using System.Data;
using System.Globalization;
using Azure.Identity;
using Microsoft.Data.SqlClient;
using SqlSimCity.Contracts.V1;
using SqlSimCity.SqlServer;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.Collection.Probes;

/// <summary>
/// A real <c>Microsoft.Data.SqlClient</c>-backed <see cref="ILiveIncidentProbeExecutor"/>. Every
/// command is static catalog SQL taken verbatim from the embedded <c>ProbeCatalog</c> (never
/// string-built or interpolated), the command timeout always comes from the connection profile's
/// own <see cref="ConnectionTimeouts.CommandTimeoutSeconds"/>, and every call honors the supplied
/// <see cref="CancellationToken"/>. No probe here mutates server state. This executor opens one
/// connection per call through <see cref="ISqlConnectionFactory"/>, matching
/// <see cref="SqlClientProbeExecutor"/>'s pattern.
/// </summary>
public sealed class SqlLiveIncidentProbeExecutor : ILiveIncidentProbeExecutor
{
    /// <summary>
    /// The default row cap handed to <c>sessions.active_requests</c>. A server's session count is
    /// bounded by nothing this process controls, and an uncapped sample grows linearly with it:
    /// 5,009 idle sessions carrying no batch text at all measured 5.88 MiB per snapshot
    /// (tools/measure, SQL Server 2022), rebroadcast whole every 2-5 seconds. The cap is generous
    /// against what a reader can actually use and, critically, is disclosed -- the probe reports the
    /// pre-cap count, so a bounded sample is never mistaken for a smaller server.
    /// </summary>
    public const int DefaultMaxRequestRows = 1_000;

    /// <summary>
    /// The default text cap handed to <c>sessions.active_requests</c>. Batch text is the sharper of
    /// the two unbounded axes by three orders of magnitude: 50 sessions each executing a 1 MiB
    /// single-statement batch measured a 100.2 MiB snapshot, 4.35 s of collection -- longer than the
    /// sampler's own 2-5 s cadence -- and 103 GiB allocated in this process, with cost growing
    /// faster than linearly in text length. The same workload with text resolution off collected in
    /// 39 ms and allocated 0.9 MiB, which is why the cap is a probe parameter rather than a
    /// post-read truncation: the cost is paid materializing the text out of the engine.
    /// 16,384 characters holds any statement a reader is realistically going to read, the
    /// untruncated length always travels with it, and an operator who needs more can raise or
    /// remove the cap through <c>LiveIncidents:SampleBounds:MaxTextLength</c>. It is not set higher
    /// by default because the cost is not linear: at 250 concurrent 64 KiB batches, 16,384 measured
    /// an 8.4 MiB snapshot and 99 MiB of allocation per cycle against 31.9 MiB and 1,158 MiB at
    /// 65,536.
    /// </summary>
    public const int DefaultMaxTextLength = 16_384;

    /// <summary>
    /// The default row cap handed to <c>tempdb.usage</c>'s session and task result sets. Those two
    /// DMVs return a row per session and per task whether or not tempdb was ever touched, so they
    /// scale with connection count rather than tempdb activity: 5,028 sessions measured 1.76 MiB of
    /// mostly-zero rows in one snapshot, which was larger than the capped request sample beside it.
    /// The cap keeps the heaviest allocators, which is what this evidence is for.
    /// </summary>
    public const int DefaultMaxTempdbRows = 1_000;

    private readonly ISqlConnectionFactory _connectionFactory;
    private readonly ConnectionProfile _profile;
    private readonly Catalog.ProbeCatalog _catalog;
    private readonly EnginePlatform? _configuredPlatform;
    private readonly bool _includeSqlText;
    private readonly int? _maxRequestRows;
    private readonly int? _maxTextLength;
    private readonly int? _maxTempdbRows;

    public SqlLiveIncidentProbeExecutor(
        ISqlConnectionFactory connectionFactory,
        ConnectionProfile profile,
        Catalog.ProbeCatalog catalog,
        EnginePlatform? configuredPlatform = null,
        bool includeSqlText = true,
        int? maxRequestRows = DefaultMaxRequestRows,
        int? maxTextLength = DefaultMaxTextLength,
        int? maxTempdbRows = DefaultMaxTempdbRows)
    {
        ArgumentNullException.ThrowIfNull(connectionFactory);
        ArgumentNullException.ThrowIfNull(profile);
        ArgumentNullException.ThrowIfNull(catalog);
        if (maxRequestRows is <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maxRequestRows), maxRequestRows,
                "The request row cap must be positive, or null for no cap.");
        }

        if (maxTextLength is <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maxTextLength), maxTextLength,
                "The text length cap must be positive, or null for no cap.");
        }

        if (maxTempdbRows is <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maxTempdbRows), maxTempdbRows,
                "The tempdb row cap must be positive, or null for no cap.");
        }

        _connectionFactory = connectionFactory;
        _profile = profile;
        _catalog = catalog;
        _configuredPlatform = configuredPlatform;
        _includeSqlText = includeSqlText;
        _maxRequestRows = maxRequestRows;
        _maxTextLength = maxTextLength;
        _maxTempdbRows = maxTempdbRows;
    }

    /// <summary>The row cap this executor sends to <c>sessions.active_requests</c>, or null for no cap.</summary>
    public int? MaxRequestRows => _maxRequestRows;

    /// <summary>The text length cap this executor sends to <c>sessions.active_requests</c>, or null for no cap.</summary>
    public int? MaxTextLength => _maxTextLength;

    /// <summary>The row cap this executor sends to <c>tempdb.usage</c>'s session and task result sets, or null for no cap.</summary>
    public int? MaxTempdbRows => _maxTempdbRows;

    public Task<ServerIdentityResult> GetServerIdentityAsync(CancellationToken cancellationToken) =>
        ExecuteAsync(
            "server.identity",
            "master",
            async (reader, ct) =>
            {
                if (!await reader.ReadAsync(ct).ConfigureAwait(false))
                {
                    throw new ProbeObjectUnavailableException("Probe 'server.identity' returned no row.", null, null);
                }

                return new ServerIdentityResult(
                    reader["server_name"] as string,
                    reader["product_version"] as string,
                    reader["product_level"] as string,
                    reader["edition"] as string,
                    Convert.ToInt32(reader["engine_edition"], CultureInfo.InvariantCulture),
                    SqlClientProbeExecutor.IsHadrEnabled(reader["is_hadr_enabled"]),
                    Convert.ToInt32(reader["cpu_count"], CultureInfo.InvariantCulture),
                    Convert.ToInt32(reader["scheduler_count"], CultureInfo.InvariantCulture),
                    reader["physical_memory_mb"] is DBNull ? null : Convert.ToInt64(reader["physical_memory_mb"], CultureInfo.InvariantCulture),
                    AsOpaqueEpochToken(reader, "sqlserver_start_time"));
            },
            cancellationToken);

    public Task<IReadOnlyList<ActiveRequestRow>> GetActiveRequestsAsync(CancellationToken cancellationToken) =>
        ExecuteAsync(
            "sessions.active_requests",
            "server",
            async (reader, ct) =>
            {
                var rows = new List<ActiveRequestRow>();
                while (await reader.ReadAsync(ct).ConfigureAwait(false))
                {
                    rows.Add(new ActiveRequestRow(
                        Convert.ToInt32(reader["session_id"], CultureInfo.InvariantCulture),
                        AsString(reader, "login_name"),
                        AsString(reader, "host_name"),
                        AsString(reader, "program_name"),
                        AsString(reader, "session_status"),
                        AsDateTimeOffset(reader, "last_request_start_time"),
                        AsDateTimeOffset(reader, "last_request_end_time"),
                        AsNullableInt32(reader, "request_id"),
                        AsString(reader, "request_status"),
                        AsString(reader, "command"),
                        AsString(reader, "wait_type"),
                        AsNullableInt32(reader, "wait_time_ms"),
                        AsString(reader, "wait_resource"),
                        AsNullableInt64(reader, "blocking_session_id"),
                        AsDateTimeOffset(reader, "request_start_time"),
                        AsNullableInt32(reader, "total_elapsed_time_ms"),
                        AsNullableInt32(reader, "cpu_time_ms"),
                        AsNullableInt64(reader, "reads"),
                        AsNullableInt64(reader, "writes"),
                        AsNullableInt64(reader, "logical_reads"),
                        AsNullableInt32(reader, "open_transaction_count"),
                        AsNullableInt32(reader, "database_id"),
                        AsString(reader, "database_name"),
                        AsString(reader, "batch_text"),
                        AsString(reader, "current_statement_text"),
                        Convert.ToInt32(reader["visible_session_count"], CultureInfo.InvariantCulture),
                        Convert.ToInt32(reader["selection_rank"], CultureInfo.InvariantCulture),
                        AsNullableInt32(reader, "batch_text_length"),
                        AsNullableInt32(reader, "current_statement_text_length")));
                }

                return (IReadOnlyList<ActiveRequestRow>)rows;
            },
            cancellationToken,
            new Dictionary<string, object?>
            {
                ["@IncludeIdleSessions"] = true,
                ["@MinElapsedMs"] = 0,
                ["@DatabaseId"] = null,
                ["@IncludeSqlText"] = _includeSqlText,
                ["@MaxRows"] = _maxRequestRows,
                ["@MaxTextLength"] = _maxTextLength,
            });

    public Task<IReadOnlyList<Blocking.WaitingTaskFact>> GetWaitingTasksAsync(CancellationToken cancellationToken) =>
        ExecuteAsync(
            "sessions.waiting_tasks",
            "server",
            async (reader, ct) =>
            {
                var rows = new List<Blocking.WaitingTaskFact>();
                while (await reader.ReadAsync(ct).ConfigureAwait(false))
                {
                    rows.Add(new Blocking.WaitingTaskFact(
                        AsVarbinaryHex(reader, "waiting_task_address") ?? string.Empty,
                        Convert.ToInt32(reader["session_id"], CultureInfo.InvariantCulture),
                        Convert.ToInt32(reader["exec_context_id"], CultureInfo.InvariantCulture),
                        Convert.ToInt64(reader["wait_duration_ms"], CultureInfo.InvariantCulture),
                        AsString(reader, "wait_type"),
                        AsVarbinaryHex(reader, "resource_address"),
                        AsVarbinaryHex(reader, "blocking_task_address"),
                        AsNullableInt64(reader, "blocking_session_id"),
                        AsString(reader, "resource_description")));
                }

                return (IReadOnlyList<Blocking.WaitingTaskFact>)rows;
            },
            cancellationToken,
            new Dictionary<string, object?> { ["@MinWaitMs"] = 0 });

    public Task<IReadOnlyList<Blocking.BlockingInputFact>> GetBlockingInputsAsync(CancellationToken cancellationToken) =>
        ExecuteAsync(
            "sessions.blocking_inputs",
            "server",
            async (reader, ct) =>
            {
                var rows = new List<Blocking.BlockingInputFact>();
                while (await reader.ReadAsync(ct).ConfigureAwait(false))
                {
                    rows.Add(new Blocking.BlockingInputFact(
                        (string)reader["fact_source"],
                        Convert.ToInt32(reader["session_id"], CultureInfo.InvariantCulture),
                        AsNullableInt32(reader, "request_id"),
                        AsNullableInt64(reader, "blocking_session_id"),
                        AsString(reader, "wait_type"),
                        AsNullableInt64(reader, "wait_time_ms"),
                        AsString(reader, "wait_resource"),
                        AsString(reader, "status"),
                        AsNullableInt32(reader, "open_transaction_count"),
                        AsDateTimeOffset(reader, "start_time"),
                        AsString(reader, "command"),
                        AsNullableInt32(reader, "database_id")));
                }

                return (IReadOnlyList<Blocking.BlockingInputFact>)rows;
            },
            cancellationToken);

    public Task<IReadOnlyList<MemoryGrantRow>> GetMemoryGrantsAsync(CancellationToken cancellationToken) =>
        ExecuteAsync(
            "sessions.memory_grants",
            "server",
            async (reader, ct) =>
            {
                var rows = new List<MemoryGrantRow>();
                while (await reader.ReadAsync(ct).ConfigureAwait(false))
                {
                    rows.Add(new MemoryGrantRow(
                        Convert.ToInt32(reader["session_id"], CultureInfo.InvariantCulture),
                        AsNullableInt32(reader, "request_id"),
                        AsNullableInt32(reader, "scheduler_id"),
                        AsNullableInt32(reader, "dop"),
                        AsDateTimeOffset(reader, "request_time"),
                        AsDateTimeOffset(reader, "grant_time"),
                        AsNullableInt64(reader, "requested_memory_kb"),
                        AsNullableInt64(reader, "granted_memory_kb"),
                        AsNullableInt64(reader, "required_memory_kb"),
                        AsNullableInt64(reader, "used_memory_kb"),
                        AsNullableInt64(reader, "max_used_memory_kb"),
                        AsNullableInt64(reader, "ideal_memory_kb"),
                        reader["query_cost"] is DBNull ? null : Convert.ToDecimal(reader["query_cost"], CultureInfo.InvariantCulture),
                        AsNullableInt32(reader, "timeout_sec"),
                        AsNullableInt64(reader, "wait_time_ms"),
                        AsNullableInt32(reader, "group_id"),
                        AsNullableInt32(reader, "pool_id"),
                        AsString(reader, "batch_text")));
                }

                return (IReadOnlyList<MemoryGrantRow>)rows;
            },
            cancellationToken,
            new Dictionary<string, object?>
            {
                ["@IncludeSqlText"] = _includeSqlText,
            });

    /// <summary>Reads tempdb-only allocation DMVs; Azure SQL Database has no supported connection scope for this probe.</summary>
    public Task<TempdbUsageRaw> GetTempdbUsageAsync(bool azureScoped, CancellationToken cancellationToken) =>
        azureScoped
            ? Task.FromException<TempdbUsageRaw>(new ProbeObjectUnavailableException(
                "Azure SQL Database does not expose a supported tempdb connection scope for this probe.", null, null))
            : GetTempdbUsageFullAsync(cancellationToken);

    private Task<TempdbUsageRaw> GetTempdbUsageFullAsync(CancellationToken cancellationToken) =>
        ExecuteAsync(
            "tempdb.usage",
            "tempdb",
            async (reader, ct) =>
            {
                var files = new List<TempdbFileRow>();
                while (await reader.ReadAsync(ct).ConfigureAwait(false))
                {
                    files.Add(new TempdbFileRow(
                        Convert.ToInt32(reader["database_id"], CultureInfo.InvariantCulture),
                        Convert.ToInt32(reader["file_id"], CultureInfo.InvariantCulture),
                        Convert.ToDecimal(reader["total_mb"], CultureInfo.InvariantCulture),
                        Convert.ToDecimal(reader["allocated_mb"], CultureInfo.InvariantCulture),
                        Convert.ToDecimal(reader["free_mb"], CultureInfo.InvariantCulture),
                        Convert.ToDecimal(reader["version_store_mb"], CultureInfo.InvariantCulture),
                        Convert.ToDecimal(reader["user_objects_mb"], CultureInfo.InvariantCulture),
                        Convert.ToDecimal(reader["internal_objects_mb"], CultureInfo.InvariantCulture),
                        Convert.ToDecimal(reader["mixed_extent_mb"], CultureInfo.InvariantCulture)));
                }

                var sessions = await ReadTempdbSessionsAsync(reader, ct).ConfigureAwait(false);
                var tasks = await ReadTempdbTasksAsync(reader, ct).ConfigureAwait(false);
                return new TempdbUsageRaw(files, sessions, tasks);
            },
            cancellationToken,
            new Dictionary<string, object?>
            {
                ["@IncludeSystemSessions"] = false,
                ["@MaxSessionRows"] = _maxTempdbRows,
                ["@MaxTaskRows"] = _maxTempdbRows,
            });

    private static async Task<List<TempdbSessionRow>> ReadTempdbSessionsAsync(SqlDataReader reader, CancellationToken ct)
    {
        var sessions = new List<TempdbSessionRow>();
        if (await reader.NextResultAsync(ct).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(ct).ConfigureAwait(false))
            {
                sessions.Add(ReadTempdbSessionRow(reader));
            }
        }

        return sessions;
    }

    private static async Task<List<TempdbTaskRow>> ReadTempdbTasksAsync(SqlDataReader reader, CancellationToken ct)
    {
        var tasks = new List<TempdbTaskRow>();
        if (await reader.NextResultAsync(ct).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(ct).ConfigureAwait(false))
            {
                tasks.Add(ReadTempdbTaskRow(reader));
            }
        }

        return tasks;
    }

    private static TempdbSessionRow ReadTempdbSessionRow(SqlDataReader reader) => new(
        Convert.ToInt32(reader["session_id"], CultureInfo.InvariantCulture),
        Convert.ToInt64(reader["user_objects_alloc_page_count"], CultureInfo.InvariantCulture),
        Convert.ToInt64(reader["user_objects_dealloc_page_count"], CultureInfo.InvariantCulture),
        Convert.ToInt64(reader["internal_objects_alloc_page_count"], CultureInfo.InvariantCulture),
        Convert.ToInt64(reader["internal_objects_dealloc_page_count"], CultureInfo.InvariantCulture),
        Convert.ToInt32(reader["visible_session_count"], CultureInfo.InvariantCulture));

    private static TempdbTaskRow ReadTempdbTaskRow(SqlDataReader reader) => new(
        Convert.ToInt32(reader["session_id"], CultureInfo.InvariantCulture),
        AsNullableInt32(reader, "request_id"),
        Convert.ToInt32(reader["exec_context_id"], CultureInfo.InvariantCulture),
        Convert.ToInt64(reader["user_objects_alloc_page_count"], CultureInfo.InvariantCulture),
        Convert.ToInt64(reader["user_objects_dealloc_page_count"], CultureInfo.InvariantCulture),
        Convert.ToInt64(reader["internal_objects_alloc_page_count"], CultureInfo.InvariantCulture),
        Convert.ToInt64(reader["internal_objects_dealloc_page_count"], CultureInfo.InvariantCulture),
        Convert.ToInt32(reader["visible_task_count"], CultureInfo.InvariantCulture));

    public Task<IReadOnlyList<FileIoRow>> GetFileIoStatsAsync(bool azureScoped, CancellationToken cancellationToken) =>
        ExecuteAsync(
            azureScoped ? "io.file_io_stats_current_db" : "io.file_io_stats",
            azureScoped ? "database" : "server",
            async (reader, ct) =>
            {
                var rows = new List<FileIoRow>();
                while (await reader.ReadAsync(ct).ConfigureAwait(false))
                {
                    rows.Add(new FileIoRow(
                        Convert.ToInt32(reader["database_id"], CultureInfo.InvariantCulture),
                        AsString(reader, "database_name"),
                        Convert.ToInt32(reader["file_id"], CultureInfo.InvariantCulture),
                        AsString(reader, "type_desc"),
                        Convert.ToInt64(reader["sample_ms"], CultureInfo.InvariantCulture),
                        Convert.ToInt64(reader["num_of_reads"], CultureInfo.InvariantCulture),
                        Convert.ToInt64(reader["num_of_bytes_read"], CultureInfo.InvariantCulture),
                        Convert.ToInt64(reader["io_stall_read_ms"], CultureInfo.InvariantCulture),
                        Convert.ToInt64(reader["num_of_writes"], CultureInfo.InvariantCulture),
                        Convert.ToInt64(reader["num_of_bytes_written"], CultureInfo.InvariantCulture),
                        Convert.ToInt64(reader["io_stall_write_ms"], CultureInfo.InvariantCulture),
                        Convert.ToInt64(reader["io_stall"], CultureInfo.InvariantCulture)));
                }

                return (IReadOnlyList<FileIoRow>)rows;
            },
            cancellationToken);

    public Task<IReadOnlyList<SchedulerRow>> GetSchedulerPressureAsync(bool includeIdealWorkersLimit, CancellationToken cancellationToken) =>
        ExecuteAsync(
            includeIdealWorkersLimit ? "scheduler.pressure_2019" : "scheduler.pressure_2016",
            "server",
            async (reader, ct) =>
            {
                var rows = new List<SchedulerRow>();
                while (await reader.ReadAsync(ct).ConfigureAwait(false))
                {
                    rows.Add(new SchedulerRow(
                        Convert.ToInt32(reader["scheduler_id"], CultureInfo.InvariantCulture),
                        Convert.ToInt32(reader["cpu_id"], CultureInfo.InvariantCulture),
                        AsString(reader, "status"),
                        Convert.ToInt32(reader["is_online"], CultureInfo.InvariantCulture) != 0,
                        Convert.ToInt32(reader["is_idle"], CultureInfo.InvariantCulture) != 0,
                        Convert.ToInt32(reader["current_tasks_count"], CultureInfo.InvariantCulture),
                        Convert.ToInt32(reader["runnable_tasks_count"], CultureInfo.InvariantCulture),
                        Convert.ToInt32(reader["current_workers_count"], CultureInfo.InvariantCulture),
                        Convert.ToInt32(reader["active_workers_count"], CultureInfo.InvariantCulture),
                        Convert.ToInt32(reader["work_queue_count"], CultureInfo.InvariantCulture),
                        Convert.ToInt32(reader["pending_disk_io_count"], CultureInfo.InvariantCulture),
                        Convert.ToInt32(reader["load_factor"], CultureInfo.InvariantCulture),
                        Convert.ToInt64(reader["total_cpu_usage_ms"], CultureInfo.InvariantCulture),
                        Convert.ToInt64(reader["total_scheduler_delay_ms"], CultureInfo.InvariantCulture),
                        includeIdealWorkersLimit ? AsNullableInt32(reader, "ideal_workers_limit") : null));
                }

                return (IReadOnlyList<SchedulerRow>)rows;
            },
            cancellationToken);

    public Task<LogSpaceRow?> GetLogSpaceUsageAsync(CancellationToken cancellationToken) =>
        ExecuteAsync(
            "space.log_space_usage",
            "database",
            async (reader, ct) =>
            {
                if (!await reader.ReadAsync(ct).ConfigureAwait(false))
                {
                    return (LogSpaceRow?)null;
                }

                // The probe returns exact bytes (total_log_size_bytes / used_log_space_bytes);
                // every consumer of LogSpaceRow -- the V1 contract, the findings rule, and the
                // UI -- is in MB, so the conversion happens here. Reading "*_mb" columns that
                // the probe never emits threw IndexOutOfRangeException on every sampling cycle.
                return new LogSpaceRow(
                    BytesToMegabytes(reader["total_log_size_bytes"]),
                    BytesToMegabytes(reader["used_log_space_bytes"]),
                    Convert.ToDecimal(reader["used_log_space_in_percent"], CultureInfo.InvariantCulture));
            },
            cancellationToken);

    private const decimal BytesPerMegabyte = 1_024m * 1_024m;

    /// <summary>
    /// Converts an exact byte count to megabytes, rounded to two decimals to match
    /// the precision the live-incident contract and its fixtures already use.
    /// </summary>
    private static decimal BytesToMegabytes(object value) =>
        Math.Round(
            Convert.ToDecimal(value, CultureInfo.InvariantCulture) / BytesPerMegabyte,
            2,
            MidpointRounding.AwayFromZero);

    private static string? AsString(SqlDataReader reader, string column) => reader[column] is DBNull ? null : (string)reader[column];

    /// <summary>
    /// Encodes a <c>varbinary</c> column (e.g. <c>waiting_task_address</c>, <c>resource_address</c>,
    /// <c>blocking_task_address</c> -- all <c>varbinary(8)</c>) as a deterministic <c>0x</c>-prefixed
    /// uppercase hex string, or null for a NULL column. Never cast these columns with
    /// <see cref="AsString"/>: a raw <c>byte[]</c> value is not a <see cref="string"/>, and that cast
    /// throws <see cref="InvalidCastException"/> at runtime for every row.
    /// </summary>
    private static string? AsVarbinaryHex(SqlDataReader reader, string column) => FormatVarbinaryHex(reader[column] as byte[]);

    /// <summary>The pure formatting rule <see cref="AsVarbinaryHex"/> applies, extracted so it is unit-testable without a live <see cref="SqlDataReader"/>.</summary>
    internal static string? FormatVarbinaryHex(byte[]? bytes) => bytes is null ? null : "0x" + Convert.ToHexString(bytes);

    private static int? AsNullableInt32(SqlDataReader reader, string column) =>
        reader[column] is DBNull ? null : Convert.ToInt32(reader[column], CultureInfo.InvariantCulture);

    private static long? AsNullableInt64(SqlDataReader reader, string column) =>
        reader[column] is DBNull ? null : Convert.ToInt64(reader[column], CultureInfo.InvariantCulture);

    /// <summary>
    /// A SQL Server <c>datetime</c>/<c>datetime2</c> column is always <see cref="DateTimeKind.Unspecified"/>
    /// and, for every column this executor reads, represents the connected engine's own local clock --
    /// never guaranteed UTC. Wrapping it with <c>new DateTimeOffset(DateTime)</c> would silently apply
    /// this PROCESS's local time zone offset instead, which is wrong for display and, worse, is not even
    /// stable across polls of the very same value if the collector process's own zone observes a DST
    /// transition between polls. Every value here therefore carries a fixed, zero UTC offset: it is a
    /// server-local clock reading rendered as a <see cref="DateTimeOffset"/> only for convenient
    /// arithmetic/comparison, never a claim that the moment shown is actually UTC.
    /// </summary>
    private static DateTimeOffset? AsDateTimeOffset(SqlDataReader reader, string column) =>
        reader[column] is DBNull ? null : new DateTimeOffset(Convert.ToDateTime(reader[column], CultureInfo.InvariantCulture).Ticks, TimeSpan.Zero);

    /// <summary>
    /// <c>sys.dm_os_sys_info.sqlserver_start_time</c> read as a purely opaque, deterministic
    /// comparable token for cross-cycle engine-restart detection (requirement 8) -- not a
    /// dependable UTC instant. See <see cref="AsDateTimeOffset"/>'s doc comment for why a naive
    /// <c>DateTimeOffset(DateTime)</c> conversion is unsafe even for this narrower purpose: it would
    /// make the token's value depend on the COLLECTOR process's local time zone, so a DST
    /// transition on the collector machine between two polls could register as a spurious engine
    /// restart even though the server's own start time never changed.
    /// </summary>
    private static DateTimeOffset? AsOpaqueEpochToken(SqlDataReader reader, string column) => AsDateTimeOffset(reader, column);

    /// <summary>
    /// Opens one connection scoped correctly for <paramref name="expectedConnectionScope"/>
    /// (server/database/tempdb -- the initial database this probe requires), runs one catalog
    /// probe, and guarantees the connection is disposed before returning.
    /// </summary>
    private async Task<T> ExecuteAsync<T>(
        string probeId,
        string expectedConnectionScope,
        Func<SqlDataReader, CancellationToken, Task<T>> project,
        CancellationToken cancellationToken,
        IReadOnlyDictionary<string, object?>? parameters = null)
    {
        var probe = _catalog.Get(probeId);
        if (!string.Equals(probe.ConnectionScope, expectedConnectionScope, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                $"Probe '{probeId}' declares connectionScope '{probe.ConnectionScope}', not expected scope '{expectedConnectionScope}'.");
        }

        var executionProfile = expectedConnectionScope switch
        {
            "master" => _configuredPlatform == EnginePlatform.AzureSqlDatabase
                ? _profile
                : _profile.WithInitialDatabase("master"),
            "tempdb" => _profile.WithInitialDatabase("tempdb"),
            "database" => _profile,
            "server" => _profile,
            _ => throw new InvalidOperationException($"Probe '{probeId}' cannot execute through this executor with scope '{expectedConnectionScope}'."),
        };

        var boundParameters = BuildParameters(probe, parameters);

        SqlConnectionOpenResult openResult;
        try
        {
            openResult = await _connectionFactory.OpenAsync(executionProfile, cancellationToken).ConfigureAwait(false);
        }
        catch (SqlException ex)
        {
            throw SqlExceptionClassifier.Classify(ex, probeId);
        }
        catch (Exception ex) when (IsCredentialResolutionFailure(ex))
        {
            throw ClassifyCredentialFailure(ex, probeId);
        }

        await using (openResult.ConfigureAwait(false))
        {
            await using var command = openResult.Connection.CreateCommand();
            command.CommandType = CommandType.Text;
            command.CommandText = probe.CommandText;
            command.CommandTimeout = executionProfile.Timeouts.CommandTimeoutSeconds;
            if (boundParameters.Length > 0)
            {
                command.Parameters.AddRange(boundParameters);
            }

            try
            {
                await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                return await project(reader, cancellationToken).ConfigureAwait(false);
            }
            catch (SqlException ex)
            {
                throw SqlExceptionClassifier.Classify(ex, probeId);
            }
            catch (Exception ex) when (IsCredentialResolutionFailure(ex))
            {
                throw ClassifyCredentialFailure(ex, probeId);
            }
            catch (Exception ex) when (IsRowShapeFailure(ex))
            {
                throw ClassifyRowShapeFailure(ex, probeId);
            }
        }
    }

    /// <summary>
    /// True for the exceptions a row projection raises when the engine's actual result shape
    /// disagrees with what the projection expects: a column that is NULL on this platform but not
    /// another (<see cref="InvalidCastException"/> from <c>Convert</c>), a column the probe does not
    /// emit (<see cref="IndexOutOfRangeException"/>), or a value outside the target type
    /// (<see cref="FormatException"/>, <see cref="OverflowException"/>).
    ///
    /// These are classified rather than left to propagate because the live-incident collector is
    /// built to degrade one subsystem at a time -- it records an <c>UnavailableFieldV1</c> for any
    /// <see cref="ProbeExecutionException"/> and still publishes the rest of the snapshot. An
    /// unclassified cast failure instead escapes to the sampler and destroys the whole cycle, so a
    /// single platform-specific NULL silently costs every other subsystem's evidence too. That is
    /// exactly what <c>SERVERPROPERTY('IsHadrEnabled')</c> did on Azure SQL Database.
    /// </summary>
    internal static bool IsRowShapeFailure(Exception ex) =>
        ex is InvalidCastException or IndexOutOfRangeException or FormatException or OverflowException;

    private static ProbeDataFormatException ClassifyRowShapeFailure(Exception ex, string probeId) =>
        new($"Probe '{probeId}' returned a row shape its result contract cannot represent, which " +
            "usually means a column is NULL or absent on this engine edition.", ex);

    /// <summary>
    /// True for the non-<see cref="SqlException"/> failure types a connection open can raise before
    /// ever reaching the server: a mounted secret file that could not be resolved
    /// (<see cref="SecretResolutionException"/>), or an Entra/Azure Identity credential that could
    /// not produce a token (<see cref="CredentialUnavailableException"/>,
    /// <see cref="AuthenticationFailedException"/>). None of these are caught anywhere else in this
    /// executor, so without this classification they would propagate raw all the way to the
    /// sampler and risk exposing secret paths, tenant/client identifiers, or credential provider
    /// diagnostics through an unclassified error message (requirements 11 and 16).
    /// </summary>
    private static bool IsCredentialResolutionFailure(Exception ex) =>
        ex is SecretResolutionException or CredentialUnavailableException or AuthenticationFailedException;

    private static ProbeAuthenticationException ClassifyCredentialFailure(Exception ex, string probeId) => ex switch
    {
        SecretResolutionException => new ProbeAuthenticationException(
            $"Probe '{probeId}' could not open a connection because a required secret could not be resolved.", null, null, ex),
        CredentialUnavailableException => new ProbeAuthenticationException(
            $"Probe '{probeId}' could not open a connection because no Microsoft Entra credential was available for this identity.", null, null, ex),
        AuthenticationFailedException => new ProbeAuthenticationException(
            $"Probe '{probeId}' could not open a connection because Microsoft Entra authentication failed.", null, null, ex),
        _ => new ProbeAuthenticationException($"Probe '{probeId}' could not open a connection because authentication failed.", null, null, ex),
    };

    private static SqlParameter[] BuildParameters(Catalog.ProbeDefinition probe, IReadOnlyDictionary<string, object?>? values)
    {
        values ??= new Dictionary<string, object?>();
        var declared = probe.Parameters.ToDictionary(p => p.Name, StringComparer.Ordinal);
        var undeclared = values.Keys.Where(name => !declared.ContainsKey(name)).ToList();
        var missing = probe.Parameters
            .Where(p => p.Required && !values.ContainsKey(p.Name))
            .Select(p => p.Name)
            .ToList();
        if (undeclared.Count > 0 || missing.Count > 0)
        {
            throw new InvalidOperationException(
                $"Probe '{probe.Id}' parameter contract mismatch. " +
                $"Undeclared: [{string.Join(", ", undeclared)}]; missing required: [{string.Join(", ", missing)}].");
        }

        var result = new List<SqlParameter>(values.Count);
        foreach (var definition in probe.Parameters)
        {
            if (!values.TryGetValue(definition.Name, out var value))
            {
                continue;
            }

            if (!Enum.TryParse<SqlDbType>(definition.SqlDbType, ignoreCase: false, out var sqlDbType))
            {
                throw new InvalidOperationException(
                    $"Probe '{probe.Id}' parameter '{definition.Name}' declares unsupported SqlDbType '{definition.SqlDbType}'.");
            }

            result.Add(new SqlParameter(definition.Name, sqlDbType) { Value = value ?? DBNull.Value });
        }

        return [.. result];
    }
}
