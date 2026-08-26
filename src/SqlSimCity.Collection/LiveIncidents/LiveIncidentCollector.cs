using System.Globalization;
using SqlSimCity.Collection.Blocking;
using SqlSimCity.Collection.Deltas;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Collection.LiveIncidents;

/// <summary>
/// The real, source-neutral <see cref="ILiveIncidentCollector"/>. Every subsystem is probed
/// independently through <see cref="ILiveIncidentProbeExecutor"/> so one failing probe (a
/// permission gap, a timeout, an unsupported view on this platform) degrades only that subsystem
/// to an explicit <see cref="UnavailableFieldV1"/> rather than failing the whole snapshot
/// (requirement 2/6). This same class drives both a live <c>SqlLiveIncidentProbeExecutor</c> and
/// any other conforming executor; it holds no SQL-specific code itself.
///
/// Cross-cycle state this instance owns: the previous cycle's active requests (so a request that
/// disappears between polls is reported rather than silently dropped -- requirement 6's short-
/// lived-query disclosure), and one <see cref="CounterEpochTracker{TKey}"/> per cumulative counter
/// family (file I/O, scheduler CPU, scheduler delay) so deltas/epoch resets are computed correctly
/// across calls (requirement 5). Like <see cref="CounterEpochTracker{TKey}"/> itself, this type is
/// not thread-safe; the sampler guarantees at most one <see cref="CollectAsync"/> call is in
/// flight at a time.
/// </summary>
public sealed class LiveIncidentCollector : ILiveIncidentCollector
{
    private readonly ILiveIncidentProbeExecutor _probes;
    private readonly string _targetId;
    private readonly string _displayName;
    private readonly TimeProvider _timeProvider;
    private readonly TimeSpan _freshnessWindow;

    private readonly CounterEpochTracker<(int DatabaseId, int FileId, string Metric)> _fileIoTracker = new();
    private readonly CounterEpochTracker<int> _cpuUsageTracker = new();
    private readonly CounterEpochTracker<int> _schedulerDelayTracker = new();
    private readonly EnginePlatform? _configuredPlatform;
    private Dictionary<string, LiveRequestV1> _previousRequests = new(StringComparer.Ordinal);
    private long _epochMarkerTicks;
    private DateTimeOffset? _previousSampleAt;

    public LiveIncidentCollector(
        ILiveIncidentProbeExecutor probes,
        string targetId,
        string displayName,
        TimeProvider? timeProvider = null,
        TimeSpan? freshnessWindow = null,
        EnginePlatform? configuredPlatform = null)
    {
        ArgumentNullException.ThrowIfNull(probes);
        ArgumentException.ThrowIfNullOrWhiteSpace(targetId);
        ArgumentException.ThrowIfNullOrWhiteSpace(displayName);
        _probes = probes;
        _targetId = targetId;
        _displayName = displayName;
        _timeProvider = timeProvider ?? TimeProvider.System;
        _freshnessWindow = freshnessWindow ?? TimeSpan.FromSeconds(10);
        _configuredPlatform = configuredPlatform;
    }

    public async Task<LiveIncidentSnapshotV1> CollectAsync(long sequence, CancellationToken cancellationToken)
    {
        var startedAt = _timeProvider.GetUtcNow();
        var unavailable = new List<UnavailableFieldV1>();

        // Requirement 7: identity-probe success alone must never make the overall snapshot
        // "Available" -- it only tells us the platform/epoch marker, not that any operational
        // subsystem (requests/blocking/waits/grants/tempdb/fileIo/scheduler/logSpace) produced
        // real evidence this cycle. `anyOperationalSuccess` deliberately excludes identity.
        var anyOperationalSuccess = false;

        ServerIdentityResult? identity = null;
        try
        {
            identity = await _probes.GetServerIdentityAsync(cancellationToken).ConfigureAwait(false);
            if (identity.SqlServerStartTime is { } startTime)
            {
                // startTime already carries a fixed, zero-offset "opaque comparable token" derived
                // from the engine's own local clock (see SqlLiveIncidentProbeExecutor), never a
                // dependable UTC instant; only ticks-equality across cycles is meaningful here.
                _epochMarkerTicks = startTime.UtcTicks;
            }
        }
        catch (ProbeExecutionException ex)
        {
            var (status, reason) = Classify(ex);
            unavailable.Add(new UnavailableFieldV1("serverIdentity", status, reason));
        }

        // Requirement 3: platform must never be derived solely from a master-scoped identity probe
        // that can legitimately fail for a contained Azure SQL Database user. A configured/negotiated
        // platform (Connected-mode DI wiring) always wins; only when none was configured do we fall
        // back to the identity probe's result, and only when even that failed do we report Unknown
        // rather than silently assuming Unsupported (which would incorrectly imply "definitely not
        // Azure, treat as a full on-premises server with server-wide visibility").
        var platform = _configuredPlatform ?? (identity is null ? EnginePlatform.Unknown : MapPlatform(identity.EngineEdition));
        var isAzureSqlDatabase = platform == EnginePlatform.AzureSqlDatabase;
        var isPlatformKnown = platform != EnginePlatform.Unknown;

        var (requests, requestsSucceeded) = await CollectRequestsAsync(unavailable, cancellationToken).ConfigureAwait(false);
        anyOperationalSuccess = anyOperationalSuccess || requestsSucceeded;

        IReadOnlyList<BlockingInputFact> blockingFacts = [];
        try
        {
            blockingFacts = await _probes.GetBlockingInputsAsync(cancellationToken).ConfigureAwait(false);
            anyOperationalSuccess = true;
        }
        catch (ProbeExecutionException ex)
        {
            var (status, reason) = Classify(ex);
            unavailable.Add(new UnavailableFieldV1("blockingGraph", status, reason));
        }

        IReadOnlyList<WaitingTaskFact> waitingTaskFacts = [];
        try
        {
            waitingTaskFacts = await _probes.GetWaitingTasksAsync(cancellationToken).ConfigureAwait(false);
            anyOperationalSuccess = true;
        }
        catch (ProbeExecutionException ex)
        {
            var (status, reason) = Classify(ex);
            unavailable.Add(new UnavailableFieldV1("waitingTasks", status, reason));
        }

        var blockingGraph = BlockingGraphBuilder.BuildGraph(blockingFacts, waitingTaskFacts);
        var waitingTasks = BlockingGraphBuilder.BuildWaitingTasks(waitingTaskFacts);

        IReadOnlyList<MemoryGrantV1> memoryGrants = [];
        try
        {
            var rows = await _probes.GetMemoryGrantsAsync(cancellationToken).ConfigureAwait(false);
            memoryGrants = rows.Select(MapMemoryGrant).ToList();
            anyOperationalSuccess = true;
        }
        catch (ProbeExecutionException ex)
        {
            var (status, reason) = Classify(ex);
            unavailable.Add(new UnavailableFieldV1("memoryGrants", status, reason));
        }

        var tempdb = await CollectTempdbAsync(platform, cancellationToken).ConfigureAwait(false);
        anyOperationalSuccess = anyOperationalSuccess || tempdb.Status == DataStatus.Available;
        if (tempdb.Status != DataStatus.Available)
        {
            unavailable.Add(new UnavailableFieldV1("tempdb", tempdb.Status, tempdb.Reason));
        }

        var now = _timeProvider.GetUtcNow();
        decimal? sampleWindowMs = _previousSampleAt is { } previousSampleAt
            ? (decimal)(now - previousSampleAt).TotalMilliseconds
            : null;

        // Unknown/unsupported platforms must not risk the instance-wide, Azure-incompatible view.
        var fileIo = await CollectFileIoAsync(platform, now, sampleWindowMs, cancellationToken).ConfigureAwait(false);
        anyOperationalSuccess = anyOperationalSuccess || fileIo.Status == DataStatus.Available;
        if (fileIo.Status != DataStatus.Available)
        {
            unavailable.Add(new UnavailableFieldV1("fileIo", fileIo.Status, fileIo.Reason));
        }

        var includeIdealWorkersLimit = ShouldIncludeIdealWorkersLimit(identity, platform);
        var scheduler = await CollectSchedulerAsync(includeIdealWorkersLimit, now, sampleWindowMs, cancellationToken).ConfigureAwait(false);
        anyOperationalSuccess = anyOperationalSuccess || scheduler.Status == DataStatus.Available;
        if (scheduler.Status != DataStatus.Available)
        {
            unavailable.Add(new UnavailableFieldV1("scheduler", scheduler.Status, scheduler.Reason));
        }

        var logSpace = await CollectLogSpaceAsync(cancellationToken).ConfigureAwait(false);
        anyOperationalSuccess = anyOperationalSuccess || logSpace.Status == DataStatus.Available;
        if (logSpace.Status != DataStatus.Available)
        {
            unavailable.Add(new UnavailableFieldV1("logSpace", logSpace.Status, logSpace.Reason));
        }

        _previousSampleAt = now;

        var completedAt = _timeProvider.GetUtcNow();
        // A real local source-observed timestamp is only meaningful when this cycle actually
        // produced genuine operational evidence (requirement 7); otherwise it stays null rather
        // than fabricating a timestamp for a snapshot built entirely from stale/carried data.
        var sourceTimestamp = anyOperationalSuccess ? startedAt : (DateTimeOffset?)null;
        var overallStatus = anyOperationalSuccess ? DataStatus.Available : DataStatus.Disconnected;
        var overallReason = anyOperationalSuccess
            ? "Snapshot assembled; see diagnostics.unavailableFields for any subsystem that could not be sampled this cycle."
            : unavailable.Count > 0
                ? unavailable[0].Reason
                : "No probe in this cycle returned data.";

        var diagnostics = new CollectionDiagnosticsV1(
            sequence,
            completedAt,
            sourceTimestamp,
            DurationMs: (long)(completedAt - startedAt).TotalMilliseconds,
            MissedCycles: 0,
            SkippedCycles: 0,
            UnavailableFields: unavailable);

        return new LiveIncidentSnapshotV1(
            "1.0",
            new LiveIncidentTargetV1(
                _targetId,
                _displayName,
                platform.ToString(),
                !isPlatformKnown ? "Unknown" : isAzureSqlDatabase ? "DatabaseScoped" : "Server",
                !isPlatformKnown
                    ? "The engine platform could not be determined this cycle; server-wide visibility is never assumed when the platform is unknown."
                    : isAzureSqlDatabase
                        ? "Azure SQL Database DMV visibility is database-scoped; server-wide fields are unavailable, not zero."
                        : null),
            sourceTimestamp,
            completedAt,
            completedAt.Add(_freshnessWindow),
            overallStatus,
            overallReason,
            requests,
            waitingTasks,
            blockingGraph,
            memoryGrants,
            tempdb,
            fileIo,
            scheduler,
            logSpace,
            diagnostics);
    }

    private async Task<(IReadOnlyList<LiveRequestV1> Requests, bool Succeeded)> CollectRequestsAsync(
        List<UnavailableFieldV1> unavailable,
        CancellationToken cancellationToken)
    {
        IReadOnlyList<ActiveRequestRow> rows;
        try
        {
            rows = await _probes.GetActiveRequestsAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (ProbeExecutionException ex)
        {
            var (status, reason) = Classify(ex);
            unavailable.Add(new UnavailableFieldV1("requests", status, reason));

            // Requirement 6: the probe failed outright this cycle. We have no evidence one way or
            // the other about any previously-known request, so every row that was still Available
            // must be marked Stale with a reason -- never silently re-emitted as Available in what
            // is, this cycle, a snapshot with no fresh request evidence at all. Rows already marked
            // Disappeared/Unavailable/Stale keep their own prior state unchanged. Critically,
            // _previousRequests itself is left untouched (holding the last known-good data, not
            // these synthetic stale copies) so disappearance-detection keeps working correctly once
            // the probe recovers.
            var staleReason = "The active-requests probe failed this cycle, so this row could not be " +
                "refreshed or confirmed; it is carried forward from the last successful sample and may " +
                "no longer reflect reality. " + reason;
            var carried = _previousRequests.Values
                .Select(r => r.Availability == SampleAvailability.Available
                    ? r with { Availability = SampleAvailability.Stale, AvailabilityReason = staleReason }
                    : r)
                .ToList();
            return (carried, false);
        }

        var current = new Dictionary<string, LiveRequestV1>(StringComparer.Ordinal);
        foreach (var row in rows)
        {
            var mapped = MapActiveRequest(row);
            current[mapped.RequestId] = mapped;
        }

        var disappeared = _previousRequests
            .Where(kvp => !current.ContainsKey(kvp.Key) && kvp.Value.Availability == SampleAvailability.Available)
            .Select(kvp => kvp.Value with
            {
                Availability = SampleAvailability.Disappeared,
                AvailabilityReason = "This request was present in the previous sampling cycle and is no longer visible: " +
                    "it completed, was killed, or its session ended. A request that both started and finished between " +
                    "two sampling cycles is never observed at all (requirement 6's short-lived-query disclosure).",
            })
            .ToList();

        _previousRequests = current;
        return (current.Values.Concat(disappeared).ToList(), true);
    }

    private static LiveRequestV1 MapActiveRequest(ActiveRequestRow row) => new(
        // A real, currently-executing request (request_id present, even 0) and an idle session
        // with no request row (request_id absent from the LEFT JOIN) are never the same thing:
        // collapsing both to "0" here would make an idle session indistinguishable from a genuine
        // request_id 0 (requirement 5). "idle" cannot collide with any real integer request_id.
        RequestId: row.RequestId is int requestId ? $"req:{row.SessionId}:{requestId}" : $"req:{row.SessionId}:idle",
        SessionId: row.SessionId,
        LoginName: row.LoginName,
        HostName: row.HostName,
        ProgramName: row.ProgramName,
        SessionStatus: row.SessionStatus,
        // Passed through verbatim, never synthesized. An idle session arrives from the probe's LEFT
        // JOIN with every sys.dm_exec_requests column NULL, and sys.dm_exec_requests.status is never
        // NULL for a request that exists -- so a NULL here means "this session has no request", not
        // "a request whose state went unreported". Substituting a made-up status such as "idle" made
        // an idle session read as a request in some state, and atlas activity counted every row with
        // a non-null status as a running request, so a mostly-idle connection pool inflated the
        // concurrency figure one-for-one (issue #79). Idleness stays fully recoverable without
        // inventing anything: RequestId is req:<session>:idle above, and SessionStatus carries the
        // session's own DMV status.
        RequestStatus: row.RequestStatus,
        Command: row.Command,
        WaitType: row.WaitType,
        WaitTimeMs: row.WaitTimeMs,
        WaitResource: row.WaitResource,
        Blocking: BlockingReferenceV1.FromRaw(row.BlockingSessionId),
        RequestStartTime: row.RequestStartTime,
        TotalElapsedMs: row.TotalElapsedTimeMs,
        CpuTimeMs: row.CpuTimeMs,
        Reads: row.Reads?.ToString(CultureInfo.InvariantCulture),
        Writes: row.Writes?.ToString(CultureInfo.InvariantCulture),
        LogicalReads8KiBPages: row.LogicalReads?.ToString(CultureInfo.InvariantCulture),
        OpenTransactionCount: row.OpenTransactionCount,
        DatabaseId: row.DatabaseId?.ToString(CultureInfo.InvariantCulture),
        DatabaseName: row.DatabaseName,
        CurrentStatementText: row.CurrentStatementText,
        BatchText: row.BatchText,
        Availability: SampleAvailability.Available,
        AvailabilityReason: null,
        PlanState: PlanCollectionState.NotRequested,
        PlanReason: "Plan XML is never fetched during routine sampling; only statement text is captured " +
                    "(requirement 6). A request that both started and finished between two sampling cycles " +
                    "is never observed here at all.")
    {
        // Parsing is pure and costs nothing: an OBJECT:/TAB: lock resolves outright because the text
        // already names the object id, while a KEY:/HOBT: lock is reported RequiresLookup and names
        // the probe that would resolve it. No object is ever guessed.
        LockResource = LockResourceParser.Parse(row.WaitResource),
    };

    private static MemoryGrantV1 MapMemoryGrant(MemoryGrantRow row) => new(
        row.SessionId,
        row.RequestId,
        row.SchedulerId,
        row.Dop,
        row.RequestTime,
        row.GrantTime,
        row.GrantTime is null,
        row.RequestedMemoryKb?.ToString(CultureInfo.InvariantCulture),
        row.GrantedMemoryKb?.ToString(CultureInfo.InvariantCulture),
        row.RequiredMemoryKb?.ToString(CultureInfo.InvariantCulture),
        row.UsedMemoryKb?.ToString(CultureInfo.InvariantCulture),
        row.MaxUsedMemoryKb?.ToString(CultureInfo.InvariantCulture),
        row.IdealMemoryKb?.ToString(CultureInfo.InvariantCulture),
        row.QueryCost,
        row.TimeoutSec,
        row.WaitTimeMs?.ToString(CultureInfo.InvariantCulture),
        row.BatchText);

    private async Task<TempdbUsageV1> CollectTempdbAsync(EnginePlatform platform, CancellationToken cancellationToken)
    {
        // Requirement 4: never attempt a tempdb-scoped connection profile for Azure SQL Database
        // (impossible -- Azure SQL Database cannot open with tempdb as its initial catalog, and has
        // no cross-database reference to it either), and never attempt any tempdb probe at all when
        // the platform could not be determined, since doing so could silently select the wrong path.
        if (platform == EnginePlatform.Unknown)
        {
            return new TempdbUsageV1([], [], [], DataStatus.Unknown,
                "The engine platform could not be determined this cycle, so no tempdb probe was attempted: " +
                "Azure SQL Database cannot open a tempdb-scoped connection, and guessing could select the " +
                "wrong connection profile.");
        }

        if (platform == EnginePlatform.AzureSqlDatabase)
        {
            return new TempdbUsageV1([], [], [], DataStatus.Unsupported,
                "Azure SQL Database does not allow a connection whose current database is tempdb. " +
                "The documented sys.dm_db_session_space_usage and sys.dm_db_task_space_usage views " +
                "are applicable only in tempdb, so SQLSimCity does not claim session, task, or file " +
                "tempdb usage from a regular user-database connection.");
        }

        if (platform is not (EnginePlatform.SqlServerOnPremises or EnginePlatform.AzureSqlManagedInstance))
        {
            return new TempdbUsageV1([], [], [], DataStatus.Unsupported,
                $"This build does not model a tempdb access path for engine platform '{platform}'.");
        }

        try
        {
            var raw = await _probes.GetTempdbUsageAsync(azureScoped: false, cancellationToken).ConfigureAwait(false);
            return new TempdbUsageV1(
                raw.Files.Select(f => new TempdbFileUsageV1(
                    f.FileId, f.TotalMb, f.AllocatedMb, f.FreeMb, f.VersionStoreMb, f.UserObjectsMb, f.InternalObjectsMb, f.MixedExtentMb)).ToList(),
                raw.Sessions.Select(s => new TempdbSessionUsageV1(
                    s.SessionId,
                    s.UserObjectsAllocPageCount.ToString(CultureInfo.InvariantCulture),
                    s.UserObjectsDeallocPageCount.ToString(CultureInfo.InvariantCulture),
                    s.InternalObjectsAllocPageCount.ToString(CultureInfo.InvariantCulture),
                    s.InternalObjectsDeallocPageCount.ToString(CultureInfo.InvariantCulture))).ToList(),
                raw.Tasks.Select(t => new TempdbTaskUsageV1(
                    t.SessionId, t.RequestId, t.ExecContextId,
                    t.UserObjectsAllocPageCount.ToString(CultureInfo.InvariantCulture),
                    t.UserObjectsDeallocPageCount.ToString(CultureInfo.InvariantCulture),
                    t.InternalObjectsAllocPageCount.ToString(CultureInfo.InvariantCulture),
                    t.InternalObjectsDeallocPageCount.ToString(CultureInfo.InvariantCulture))).ToList(),
                DataStatus.Available,
                "tempdb usage sampled from a connection opened with tempdb as its initial database.");
        }
        catch (ProbeExecutionException ex)
        {
            var (status, reason) = Classify(ex);
            return new TempdbUsageV1([], [], [], status, reason);
        }
    }

    private async Task<FileIoSampleV1> CollectFileIoAsync(
        EnginePlatform platform, DateTimeOffset now, decimal? sampleWindowMs, CancellationToken cancellationToken)
    {
        var useDatabaseScopedView = platform is not (
            EnginePlatform.SqlServerOnPremises or EnginePlatform.AzureSqlManagedInstance);
        try
        {
            var rows = await _probes.GetFileIoStatsAsync(useDatabaseScopedView, cancellationToken).ConfigureAwait(false);
            var deltas = rows.Select(row =>
            {
                // Each counter (reads/bytesRead/stallRead/writes/bytesWritten/stallWrite) is
                // tracked under its own key: sharing one key per file would make each metric's
                // Compute() call overwrite the previous metric's "last observation" for that file,
                // silently comparing unrelated counters and fabricating spurious epoch resets.
                var readsObs = new CounterObservation(row.NumOfReads, now, _epochMarkerTicks);
                var bytesReadObs = new CounterObservation(row.NumOfBytesRead, now, _epochMarkerTicks);
                var stallReadObs = new CounterObservation(row.IoStallReadMs, now, _epochMarkerTicks);
                var writesObs = new CounterObservation(row.NumOfWrites, now, _epochMarkerTicks);
                var bytesWrittenObs = new CounterObservation(row.NumOfBytesWritten, now, _epochMarkerTicks);
                var stallWriteObs = new CounterObservation(row.IoStallWriteMs, now, _epochMarkerTicks);

                // Requirement 8: a reset must be atomic per file. Pre-detect a reset from ANY of
                // this file's six counters (the epoch-marker check is identical across all six, but
                // the "counter regressed" fallback is only reliable when checked per counter) and
                // force every counter for this file to reset together, so a sibling counter that
                // happens not to individually regress cannot emit a fabricated cross-restart delta.
                var fileReset =
                    _fileIoTracker.WouldReset((row.DatabaseId, row.FileId, "reads"), readsObs) ||
                    _fileIoTracker.WouldReset((row.DatabaseId, row.FileId, "bytesRead"), bytesReadObs) ||
                    _fileIoTracker.WouldReset((row.DatabaseId, row.FileId, "stallRead"), stallReadObs) ||
                    _fileIoTracker.WouldReset((row.DatabaseId, row.FileId, "writes"), writesObs) ||
                    _fileIoTracker.WouldReset((row.DatabaseId, row.FileId, "bytesWritten"), bytesWrittenObs) ||
                    _fileIoTracker.WouldReset((row.DatabaseId, row.FileId, "stallWrite"), stallWriteObs);

                var reads = _fileIoTracker.Compute((row.DatabaseId, row.FileId, "reads"), readsObs, fileReset);
                var bytesRead = _fileIoTracker.Compute((row.DatabaseId, row.FileId, "bytesRead"), bytesReadObs, fileReset);
                var stallRead = _fileIoTracker.Compute((row.DatabaseId, row.FileId, "stallRead"), stallReadObs, fileReset);
                var writes = _fileIoTracker.Compute((row.DatabaseId, row.FileId, "writes"), writesObs, fileReset);
                var bytesWritten = _fileIoTracker.Compute((row.DatabaseId, row.FileId, "bytesWritten"), bytesWrittenObs, fileReset);
                var stallWrite = _fileIoTracker.Compute((row.DatabaseId, row.FileId, "stallWrite"), stallWriteObs, fileReset);
                var epochId = FileIoMetrics(row.DatabaseId, row.FileId).Max(_fileIoTracker.CurrentEpochId);
                return new FileIoDeltaV1(
                    row.DatabaseId, row.DatabaseName, row.FileId, row.TypeDesc,
                    epochId, sampleWindowMs,
                    reads, bytesRead, stallRead, writes, bytesWritten, stallWrite);
            }).ToList();

            _fileIoTracker.Prune(rows.SelectMany(r => FileIoMetrics(r.DatabaseId, r.FileId)).ToList());
            return new FileIoSampleV1(deltas, DataStatus.Available,
                platform switch
                {
                    EnginePlatform.AzureSqlDatabase =>
                        "File I/O sampled through the Azure SQL Database-scoped view (io.file_io_stats_current_db).",
                    EnginePlatform.Unknown =>
                        "File I/O sampled through the database-scoped view because the engine platform could not be determined this cycle.",
                    EnginePlatform.Unsupported =>
                        "File I/O sampled through the database-scoped view because the engine platform is not supported for instance-wide collection.",
                    _ => "File I/O sampled through the instance-wide view (io.file_io_stats).",
                });
        }
        catch (ProbeExecutionException ex)
        {
            var (status, reason) = Classify(ex);
            return new FileIoSampleV1([], status, reason);
        }
    }

    private static readonly string[] FileIoMetricNames = ["reads", "bytesRead", "stallRead", "writes", "bytesWritten", "stallWrite"];

    private static IEnumerable<(int DatabaseId, int FileId, string Metric)> FileIoMetrics(int databaseId, int fileId) =>
        FileIoMetricNames.Select(metric => (databaseId, fileId, metric));

    private async Task<SchedulerPressureV1> CollectSchedulerAsync(
        bool includeIdealWorkersLimit, DateTimeOffset now, decimal? sampleWindowMs, CancellationToken cancellationToken)
    {
        try
        {
            var rows = await _probes.GetSchedulerPressureAsync(includeIdealWorkersLimit, cancellationToken).ConfigureAwait(false);
            var samples = rows.Select(row =>
            {
                var cpuObs = new CounterObservation(row.TotalCpuUsageMs, now, _epochMarkerTicks);
                var delayObs = new CounterObservation(row.TotalSchedulerDelayMs, now, _epochMarkerTicks);

                // Requirement 8: CPU and delay are two independently-tracked counters for the same
                // scheduler; force both to reset together whenever either one alone would.
                var schedulerReset =
                    _cpuUsageTracker.WouldReset(row.SchedulerId, cpuObs) ||
                    _schedulerDelayTracker.WouldReset(row.SchedulerId, delayObs);

                var cpuDelta = _cpuUsageTracker.Compute(row.SchedulerId, cpuObs, schedulerReset);
                var delayDelta = _schedulerDelayTracker.Compute(row.SchedulerId, delayObs, schedulerReset);
                return new SchedulerSampleV1(
                    row.SchedulerId, row.CpuId, row.Status, row.IsOnline, row.IsIdle,
                    row.CurrentTasksCount, row.RunnableTasksCount, row.CurrentWorkersCount, row.ActiveWorkersCount,
                    row.WorkQueueCount, row.PendingDiskIoCount, row.LoadFactor,
                    _cpuUsageTracker.CurrentEpochId(row.SchedulerId), sampleWindowMs,
                    cpuDelta, delayDelta, row.IdealWorkersLimit);
            }).ToList();

            var liveSchedulerIds = rows.Select(r => r.SchedulerId).ToList();
            _cpuUsageTracker.Prune(liveSchedulerIds);
            _schedulerDelayTracker.Prune(liveSchedulerIds);
            return new SchedulerPressureV1(samples, DataStatus.Available,
                includeIdealWorkersLimit
                    ? "Scheduler pressure sampled including ideal_workers_limit (SQL Server 2019+/Azure SQL Database)."
                    : "Scheduler pressure sampled without ideal_workers_limit (pre-2019 SQL Server).");
        }
        catch (ProbeExecutionException ex)
        {
            var (status, reason) = Classify(ex);
            return new SchedulerPressureV1([], status, reason);
        }
    }

    private async Task<LogSpaceUsageV1> CollectLogSpaceAsync(CancellationToken cancellationToken)
    {
        try
        {
            var row = await _probes.GetLogSpaceUsageAsync(cancellationToken).ConfigureAwait(false);
            return row is null
                ? new LogSpaceUsageV1(null, null, null, DataStatus.Unknown, "The log space probe returned no row for the current database.")
                : new LogSpaceUsageV1(row.TotalLogSizeMb, row.UsedLogSpaceMb, row.UsedLogSpacePercent, DataStatus.Available,
                    "Log space usage is an instant gauge for the connected database; it is never delta'd.");
        }
        catch (ProbeExecutionException ex)
        {
            var (status, reason) = Classify(ex);
            return new LogSpaceUsageV1(null, null, null, status, reason);
        }
    }

    /// <summary>
    /// Azure SQL Database always exposes <c>ideal_workers_limit</c> (see scheduler.pressure_2019's
    /// manifest notes); on-premises SQL Server needs the 2019+ variant only from SQL Server 2019
    /// onward, detected from the leading product-version component.
    /// </summary>
    private static bool ShouldIncludeIdealWorkersLimit(ServerIdentityResult? identity, EnginePlatform platform)
    {
        if (platform is EnginePlatform.AzureSqlDatabase or EnginePlatform.AzureSqlManagedInstance)
        {
            return true;
        }

        if (identity?.ProductVersion is { } version)
        {
            var majorText = version.Split('.', 2)[0];
            if (int.TryParse(majorText, NumberStyles.Integer, CultureInfo.InvariantCulture, out var major))
            {
                return major >= 15; // SQL Server 2019 is major version 15.
            }
        }

        return false;
    }

    private static EnginePlatform MapPlatform(int engineEdition) => engineEdition switch
    {
        1 or 2 or 3 or 4 => EnginePlatform.SqlServerOnPremises,
        5 => EnginePlatform.AzureSqlDatabase,
        8 => EnginePlatform.AzureSqlManagedInstance,
        _ => EnginePlatform.Unsupported,
    };

    private static (DataStatus Status, string Reason) Classify(ProbeExecutionException ex) => ex switch
    {
        ProbePermissionDeniedException => (DataStatus.PermissionDenied, ex.Reason),
        ProbeObjectUnavailableException => (DataStatus.Unsupported, ex.Reason),
        ProbeNotProbedException => (DataStatus.Unknown, ex.Reason),
        ProbeTimeoutException => (DataStatus.Disconnected, ex.Reason),
        ProbeTransientConnectionException => (DataStatus.Disconnected, ex.Reason),
        ProbeAuthenticationException => (DataStatus.Disconnected, ex.Reason),
        ProbeDatabaseUnavailableException => (DataStatus.Disconnected, ex.Reason),
        _ => (DataStatus.Unknown, ex.Reason),
    };
}
