using System.Data;
using System.Globalization;
using System.Numerics;
using Azure.Identity;
using Microsoft.Data.SqlClient;
using SqlSimCity.Collection.Catalog;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;
using SqlSimCity.SqlServer;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.Collection.Atlas;

public sealed class SqlClientAtlasProbeExecutor : IAtlasProbeExecutor
{
    private readonly ISqlConnectionFactory _connectionFactory;
    private readonly ConnectionProfile _profile;
    private readonly ProbeCatalog _catalog;
    private readonly TimeProvider _timeProvider;
    private readonly EnginePlatform? _configuredPlatform;

    public SqlClientAtlasProbeExecutor(
        ISqlConnectionFactory connectionFactory,
        ConnectionProfile profile,
        ProbeCatalog catalog,
        TimeProvider? timeProvider = null,
        EnginePlatform? configuredPlatform = null)
    {
        ArgumentNullException.ThrowIfNull(connectionFactory);
        ArgumentNullException.ThrowIfNull(profile);
        ArgumentNullException.ThrowIfNull(catalog);
        _connectionFactory = connectionFactory;
        _profile = profile;
        _catalog = catalog;
        _timeProvider = timeProvider ?? TimeProvider.System;
        _configuredPlatform = configuredPlatform;
    }

    public async Task<AtlasTargetIdentity> GetTargetIdentityAsync(CancellationToken cancellationToken)
    {
        var row = await ExecuteAsync("server.identity", "master", null, null, async (reader, ct) =>
        {
            if (!await reader.ReadAsync(ct).ConfigureAwait(false))
                throw new ProbeObjectUnavailableException("The server identity probe returned no row.", null, null);
            return new AtlasTargetIdentity(
                Platform(Convert.ToInt32(reader["engine_edition"], CultureInfo.InvariantCulture)),
                Convert.ToString(reader["product_version"], CultureInfo.InvariantCulture) ?? "",
                Convert.ToString(reader["edition"], CultureInfo.InvariantCulture) ?? "",
                reader["sqlserver_start_time"] is DBNull ? null : ResetEpochToken(reader["sqlserver_start_time"]),
                _timeProvider.GetUtcNow());
        }, cancellationToken).ConfigureAwait(false);
        return row with { SourceTimestamp = _timeProvider.GetUtcNow() };
    }

    public Task<IReadOnlyList<AtlasDatabaseIdentity>> DiscoverDatabasesAsync(CancellationToken cancellationToken) =>
        ExecuteAsync("server.database_discovery", "master", null, null, async (reader, ct) =>
        {
            var rows = new List<AtlasDatabaseIdentity>();
            while (await reader.ReadAsync(ct).ConfigureAwait(false))
            {
                rows.Add(new AtlasDatabaseIdentity(
                    (string)reader["database_name"],
                    (string)reader["state_desc"],
                    Convert.ToInt32(reader["compatibility_level"], CultureInfo.InvariantCulture),
                    Convert.ToBoolean(reader["is_query_store_on"], CultureInfo.InvariantCulture)));
            }
            return (IReadOnlyList<AtlasDatabaseIdentity>)rows;
        }, cancellationToken);

    public async Task<AtlasDatabaseProbeResult> CollectDatabaseAsync(
        string databaseName,
        AtlasProbeSelection selection,
        DateTimeOffset queryStoreWindowStart,
        DateTimeOffset queryStoreWindowEnd,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databaseName);
        var identity = await ReadIdentityAsync(databaseName, cancellationToken).ConfigureAwait(false);
        var space = await CaptureComponentAsync(
            () => ReadSpaceAsync(databaseName, cancellationToken),
            cancellationToken).ConfigureAwait(false);
        AtlasComponentOutcome<AtlasQueryStoreOptionsResult> options;
        AtlasComponentOutcome<AtlasQueryStoreWorkloadResult> workload;
        if (SystemDatabases.IsSystemDatabase(databaseName))
        {
            var excluded = SystemDatabases.QueryStoreExclusionReason(databaseName);
            options = AtlasComponentOutcome.Skipped<AtlasQueryStoreOptionsResult>(
                DataStatus.Unsupported, excluded);
            workload = AtlasComponentOutcome.Skipped<AtlasQueryStoreWorkloadResult>(
                DataStatus.Unsupported, excluded);
        }
        else
        {
            options = await CaptureComponentAsync(
                () => ReadQueryStoreOptionsAsync(databaseName, selection.QueryStoreOptionsProbeId, cancellationToken),
                cancellationToken).ConfigureAwait(false);
            if (WorkloadOutcomeWithoutProbe(selection.QueryStoreWorkloadProbeId, options) is { } unprobed)
            {
                workload = unprobed;
            }
            else
            {
                workload = await CaptureComponentAsync(async () =>
                {
                    var resolved = await ResolveWorkloadProbeAsync(
                        databaseName, selection.QueryStoreWorkloadProbeId!, cancellationToken).ConfigureAwait(false);
                    var summary = await ReadQueryStoreWorkloadAsync(
                        databaseName, resolved.ProbeId, queryStoreWindowStart, queryStoreWindowEnd, cancellationToken)
                        .ConfigureAwait(false);
                    return new ComponentValue<AtlasQueryStoreWorkloadResult>(
                        summary.Value, summary.Rows + resolved.Rows);
                }, cancellationToken).ConfigureAwait(false);
            }
        }
        var io = await CaptureComponentAsync(
            () => ReadIoAsync(databaseName, selection.FileIoProbeId, cancellationToken),
            cancellationToken).ConfigureAwait(false);
        return new AtlasDatabaseProbeResult(
            identity, space, options, workload, io, _timeProvider.GetUtcNow(), 1);
    }

    private Task<AtlasDatabaseIdentity> ReadIdentityAsync(string databaseName, CancellationToken cancellationToken) =>
        ExecuteAsync("server.database_identity_current", "database", databaseName, null, async (reader, ct) =>
        {
            if (!await reader.ReadAsync(ct).ConfigureAwait(false))
                throw new ProbeDatabaseUnavailableException("The current database identity was unavailable.", null, null);
            return new AtlasDatabaseIdentity(
                (string)reader["database_name"],
                (string)reader["state_desc"],
                Convert.ToInt32(reader["compatibility_level"], CultureInfo.InvariantCulture),
                Convert.ToBoolean(reader["is_query_store_on"], CultureInfo.InvariantCulture));
        }, cancellationToken);

    private async Task<ComponentValue<AtlasSpaceResult>> ReadSpaceAsync(
        string databaseName,
        CancellationToken cancellationToken)
    {
        var files = await ExecuteAsync("space.database_file_space", "database", databaseName, null, async (reader, ct) =>
        {
            var rows = new List<DatabaseFileSpaceValue>();
            while (await reader.ReadAsync(ct).ConfigureAwait(false))
            {
                rows.Add(new DatabaseFileSpaceValue(
                    (string)reader["type_desc"],
                    Unsigned(reader["allocated_bytes"]),
                    reader["data_used_bytes"] is DBNull ? null : Unsigned(reader["data_used_bytes"])));
            }
            return rows;
        }, cancellationToken).ConfigureAwait(false);

        var log = await ExecuteAsync("space.log_space_usage", "database", databaseName, null, async (reader, ct) =>
        {
            if (!await reader.ReadAsync(ct).ConfigureAwait(false))
                throw new ProbeObjectUnavailableException("The log space probe returned no row.", null, null);
            return (Allocated: Unsigned(reader["total_log_size_bytes"]), Used: Unsigned(reader["used_log_space_bytes"]));
        }, cancellationToken).ConfigureAwait(false);

        return new ComponentValue<AtlasSpaceResult>(
            AggregateSpace(files, log.Allocated, log.Used), files.Count + 1);
    }

    private async Task<ComponentValue<AtlasQueryStoreOptionsResult>> ReadQueryStoreOptionsAsync(
        string databaseName,
        string probeId,
        CancellationToken cancellationToken)
    {
        var value = await ExecuteAsync(probeId, "database", databaseName, null, async (reader, ct) =>
        {
            if (!await reader.ReadAsync(ct).ConfigureAwait(false))
                throw new ProbeObjectUnavailableException("The Query Store options probe returned no row.", null, null);
            return new AtlasQueryStoreOptionsResult(
                Convert.ToString(reader["actual_state_desc"], CultureInfo.InvariantCulture) ?? "UNKNOWN",
                Convert.ToInt32(reader["readonly_reason"], CultureInfo.InvariantCulture))
            {
                DesiredState = Convert.ToString(reader["desired_state_desc"], CultureInfo.InvariantCulture),
                CaptureMode = Convert.ToString(reader["query_capture_mode_desc"], CultureInfo.InvariantCulture),
                CurrentStorageBytes = (Unsigned(reader["current_storage_size_mb"]) * 1_048_576)
                    .ToString(CultureInfo.InvariantCulture),
                MaxStorageBytes = (Unsigned(reader["max_storage_size_mb"]) * 1_048_576)
                    .ToString(CultureInfo.InvariantCulture),
            };
        }, cancellationToken).ConfigureAwait(false);
        return new ComponentValue<AtlasQueryStoreOptionsResult>(value, 1);
    }

    /// <summary>
    /// The complete set of reasons the Query Store workload is not probed, in precedence order, or
    /// <c>null</c> when it is. Returning <c>null</c> is the only path that reaches a round trip, so
    /// a deferred cycle costs the target nothing at all -- not the summary and not the plan-metadata
    /// capability check in front of it. A deferral is deliberately last: an unavailable, denied, or
    /// unreadable Query Store describes the database as it is now and outranks the cadence.
    /// </summary>
    internal static AtlasComponentOutcome<AtlasQueryStoreWorkloadResult>? WorkloadOutcomeWithoutProbe(
        string? workloadProbeId,
        AtlasComponentOutcome<AtlasQueryStoreOptionsResult> options)
    {
        if (options.Value is not { } queryStoreOptions)
            return AtlasComponentOutcome.Skipped<AtlasQueryStoreWorkloadResult>(
                options.Status, "Query Store workload was not probed because options were unavailable.");
        if (!IsQueryStoreReadable(queryStoreOptions.ActualState))
            return AtlasComponentOutcome.Skipped<AtlasQueryStoreWorkloadResult>(
                DataStatus.Disabled, $"Query Store workload was not probed while state was {queryStoreOptions.ActualState}.");
        if (workloadProbeId is null)
            return AtlasComponentOutcome.Deferred<AtlasQueryStoreWorkloadResult>(
                "Query Store workload was not probed because its own refresh interval had not elapsed.");
        return null;
    }

    private async Task<(string ProbeId, int Rows)> ResolveWorkloadProbeAsync(
        string databaseName,
        string selectedProbeId,
        CancellationToken cancellationToken)
    {
        if (!selectedProbeId.Equals("querystore.database_workload_summary_2022", StringComparison.Ordinal))
            return (selectedProbeId, 0);

        var metadata = await ExecuteAsync(
            "capability.query_store_plan_metadata", "database", databaseName, null,
            async (reader, ct) =>
            {
                var rows = new List<(string ViewName, string ColumnName)>();
                while (await reader.ReadAsync(ct).ConfigureAwait(false))
                    rows.Add(((string)reader["view_name"], (string)reader["column_name"]));
                return rows;
            }, cancellationToken).ConfigureAwait(false);
        var hasReplicaGroupId = QueryStorePlanMetadataResult.FromColumnNames(metadata).HasReplicaGroupId;
        return (hasReplicaGroupId
            ? selectedProbeId
            : "querystore.database_workload_summary_2016", metadata.Count);
    }

    private async Task<ComponentValue<AtlasQueryStoreWorkloadResult>> ReadQueryStoreWorkloadAsync(
        string databaseName,
        string probeId,
        DateTimeOffset start,
        DateTimeOffset end,
        CancellationToken cancellationToken)
    {
        var aggregate = await ExecuteAsync(probeId, "database", databaseName,
            new Dictionary<string, object?> { ["@StartTime"] = start, ["@EndTime"] = end },
            async (reader, ct) =>
            {
                var rows = new List<AtlasQueryStoreAggregateRow>();
                while (await reader.ReadAsync(ct).ConfigureAwait(false))
                {
                    rows.Add(new AtlasQueryStoreAggregateRow(
                        Convert.ToInt32(reader["execution_type"], CultureInfo.InvariantCulture),
                        Unsigned(reader["execution_count"]),
                        Unsigned(reader["total_duration_us"]),
                        Unsigned(reader["total_cpu_us"]),
                        Unsigned(reader["logical_reads_pages"])));
                }
                return rows;
            }, cancellationToken).ConfigureAwait(false);

        return new ComponentValue<AtlasQueryStoreWorkloadResult>(
            AggregateWorkload(aggregate, start, end), aggregate.Count);
    }

    internal static AtlasQueryStoreWorkloadResult AggregateWorkload(
        IEnumerable<AtlasQueryStoreAggregateRow> rows,
        DateTimeOffset start,
        DateTimeOffset end)
    {
        var values = rows.ToArray();
        static BigInteger Sum(
            IEnumerable<AtlasQueryStoreAggregateRow> source,
            int executionType,
            Func<AtlasQueryStoreAggregateRow, BigInteger> selector) =>
            source.Where(row => row.ExecutionType == executionType)
                .Aggregate(BigInteger.Zero, (total, row) => total + selector(row));

        return new AtlasQueryStoreWorkloadResult(
            Sum(values, 0, row => row.ExecutionCount).ToString(CultureInfo.InvariantCulture),
            Sum(values, 0, row => row.TotalDurationMicroseconds).ToString(CultureInfo.InvariantCulture),
            Sum(values, 0, row => row.TotalCpuMicroseconds).ToString(CultureInfo.InvariantCulture),
            Sum(values, 0, row => row.LogicalReads8KiBPages).ToString(CultureInfo.InvariantCulture),
            start,
            end)
        {
            AbortedExecutionCount = Sum(values, 3, row => row.ExecutionCount).ToString(CultureInfo.InvariantCulture),
            ExceptionExecutionCount = Sum(values, 4, row => row.ExecutionCount).ToString(CultureInfo.InvariantCulture),
        };
    }

    private async Task<ComponentValue<IReadOnlyList<AtlasFileIoCounter>>> ReadIoAsync(
        string databaseName,
        string probeId,
        CancellationToken cancellationToken)
    {
        var rows = await ExecuteAsync(probeId, "database", databaseName, null, async (reader, ct) =>
        {
            var values = new List<AtlasFileIoCounter>();
            while (await reader.ReadAsync(ct).ConfigureAwait(false))
            {
                values.Add(new AtlasFileIoCounter(
                    Convert.ToInt32(reader["file_id"], CultureInfo.InvariantCulture),
                    Unsigned(reader["num_of_bytes_read"]).ToString(CultureInfo.InvariantCulture),
                    Unsigned(reader["num_of_bytes_written"]).ToString(CultureInfo.InvariantCulture),
                    Convert.ToInt64(reader["sample_ms"], CultureInfo.InvariantCulture)));
            }
            return values;
        }, cancellationToken).ConfigureAwait(false);
        return new ComponentValue<IReadOnlyList<AtlasFileIoCounter>>(rows, rows.Count);
    }

    private async Task<T> ExecuteAsync<T>(
        string probeId,
        string expectedScope,
        string? databaseName,
        Dictionary<string, object?>? values,
        Func<SqlDataReader, CancellationToken, Task<T>> projector,
        CancellationToken cancellationToken)
    {
        var probe = _catalog.Get(probeId);
        if (!probe.ConnectionScope.Equals(expectedScope, StringComparison.Ordinal))
            throw new InvalidOperationException($"Probe '{probeId}' does not have the required connection scope.");
        var profile = expectedScope == "master"
            ? _configuredPlatform == EnginePlatform.AzureSqlDatabase
                ? _profile
                : _profile.WithInitialDatabase("master")
            : expectedScope == "database" && databaseName is not null
                ? _profile.WithInitialDatabase(databaseName)
                : _profile;
        SqlConnectionOpenResult opened;
        try
        {
            opened = await _connectionFactory.OpenAsync(profile, cancellationToken).ConfigureAwait(false);
        }
        catch (SqlException ex)
        {
            throw SqlExceptionClassifier.Classify(ex, probeId);
        }
        catch (SecretResolutionException ex)
        {
            throw new ProbeAuthenticationException(
                "A configured authentication secret was unavailable.", null, null, ex);
        }
        catch (CredentialUnavailableException ex)
        {
            throw new ProbeAuthenticationException(
                "The configured Microsoft Entra credential was unavailable.", null, null, ex);
        }
        catch (AuthenticationFailedException ex)
        {
            throw new ProbeAuthenticationException(
                "The configured Microsoft Entra authentication failed.", null, null, ex);
        }

        await using (opened.ConfigureAwait(false))
        await using (var command = opened.Connection.CreateCommand())
        {
            command.CommandType = CommandType.Text;
            command.CommandText = probe.CommandText;
            command.CommandTimeout = profile.Timeouts.CommandTimeoutSeconds;
            var parameters = SqlClientProbeExecutor.BuildParameters(probe, values);
            if (parameters.Length > 0)
            {
                command.Parameters.AddRange(parameters);
            }
            try
            {
                await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                return await projector(reader, cancellationToken).ConfigureAwait(false);
            }
            catch (SqlException ex)
            {
                throw SqlExceptionClassifier.Classify(ex, probeId);
            }
        }
    }

    private static BigInteger Unsigned(object value)
    {
        var text = Convert.ToString(value, CultureInfo.InvariantCulture);
        if (!BigInteger.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) || parsed < 0)
            throw new ProbeDataFormatException("A SQL probe returned an invalid unsigned integer.");
        return parsed;
    }

    private static string ResetEpochToken(object value) =>
        "sqlserver-local:" + Convert.ToDateTime(value, CultureInfo.InvariantCulture)
            .ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff", CultureInfo.InvariantCulture);

    private static bool IsQueryStoreReadable(string state) =>
        state.Equals("ON", StringComparison.OrdinalIgnoreCase) ||
        state.Equals("READ_WRITE", StringComparison.OrdinalIgnoreCase) ||
        state.Equals("READ_ONLY", StringComparison.OrdinalIgnoreCase) ||
        state.Equals("READ_CAPTURE_SECONDARY", StringComparison.OrdinalIgnoreCase);

    private static EnginePlatform Platform(int engineEdition) => engineEdition switch
    {
        5 => EnginePlatform.AzureSqlDatabase,
        8 => EnginePlatform.AzureSqlManagedInstance,
        1 or 2 or 3 or 4 => EnginePlatform.SqlServerOnPremises,
        _ => EnginePlatform.Unsupported,
    };

    private static async Task<AtlasComponentOutcome<T>> CaptureComponentAsync<T>(
        Func<Task<ComponentValue<T>>> collect,
        CancellationToken cancellationToken)
    {
        try
        {
            var result = await collect().ConfigureAwait(false);
            return AtlasComponentOutcome.Success(result.Value, result.Rows, "Probe completed.");
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return AtlasComponentOutcome.Failure<T>(DataStatus.Unknown, "The component probe timed out.");
        }
        catch (ProbeNotProbedException ex)
        {
            return AtlasComponentOutcome.Skipped<T>(DataStatus.Unsupported, ex.Reason);
        }
        catch (ProbeExecutionException ex)
        {
            var status = ex switch
            {
                ProbePermissionDeniedException => DataStatus.PermissionDenied,
                ProbeTransientConnectionException or ProbeDatabaseUnavailableException or ProbeAuthenticationException
                    => DataStatus.Disconnected,
                _ => DataStatus.Unknown,
            };
            return AtlasComponentOutcome.Failure<T>(status, ex.Reason);
        }
    }

    internal static AtlasSpaceResult AggregateSpace(
        IEnumerable<DatabaseFileSpaceValue> files,
        BigInteger logAllocated,
        BigInteger logUsed)
    {
        var dataFiles = files.Where(file => file.Type.Equals("ROWS", StringComparison.OrdinalIgnoreCase)).ToArray();
        if (dataFiles.Any(file => file.Used is null))
            throw new ProbePermissionDeniedException(
                "Exact used data bytes were not visible to the collector principal.", null, null);
        return new AtlasSpaceResult(
            dataFiles.Aggregate(BigInteger.Zero, (sum, file) => sum + file.Allocated).ToString(CultureInfo.InvariantCulture),
            dataFiles.Aggregate(BigInteger.Zero, (sum, file) => sum + file.Used!.Value).ToString(CultureInfo.InvariantCulture),
            logAllocated.ToString(CultureInfo.InvariantCulture),
            logUsed.ToString(CultureInfo.InvariantCulture));
    }

    private sealed record ComponentValue<T>(T Value, int Rows);
}

internal sealed record DatabaseFileSpaceValue(string Type, BigInteger Allocated, BigInteger? Used);
internal sealed record AtlasQueryStoreAggregateRow(
    int ExecutionType,
    BigInteger ExecutionCount,
    BigInteger TotalDurationMicroseconds,
    BigInteger TotalCpuMicroseconds,
    BigInteger LogicalReads8KiBPages);
