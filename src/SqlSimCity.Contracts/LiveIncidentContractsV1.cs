namespace SqlSimCity.Contracts.V1;

/// <summary>
/// Coarse availability of one sampled artifact (a request row, a plan lookup, a whole subsystem
/// sample) -- distinct from <see cref="DataStatus"/>, which describes freshness/permission of an
/// entire evidence stream rather than whether one specific row was still present.
/// <see cref="Stale"/> is a request row carried forward from a previous cycle because this
/// cycle's own <c>sessions.active_requests</c> probe failed outright -- a probe failure is never
/// evidence that the request disappeared, so it must not be reported as <see cref="Available"/>
/// in a snapshot whose own timestamps say the data is fresh, nor silently reclassified as
/// <see cref="Disappeared"/> (requirement 6).
/// </summary>
public enum SampleAvailability { Available, Disappeared, Unavailable, Stale }

/// <summary>
/// The four documented negative <c>sys.dm_exec_requests.blocking_session_id</c> /
/// <c>sys.dm_os_waiting_tasks.blocking_session_id</c> sentinel values. SqlSimCity never coerces
/// these to zero or null, and -5 (untracked latch owner) is never itself reported as a blocking
/// problem -- see sql/probes/sessions/waiting_tasks.sql and sql/README.md.
/// </summary>
public enum BlockingSentinelKind
{
    None,
    OrphanedDistributedTransaction, // -2
    DeferredRecoveryTransaction,    // -3
    IndeterminateLatchOwner,        // -4
    UntrackedLatchOwner,            // -5 -- commonly benign; not a blocker problem by itself
}

/// <summary>What one node in a <see cref="BlockingGraphV1"/> represents.</summary>
public enum BlockingNodeKind { Session, Sentinel }

/// <summary>Whether a waiting task is the coordinator (serial) task or a parallel worker task of a request.</summary>
public enum ExecutionContextKind { Coordinator, Worker }

/// <summary>
/// Whether a request's execution plan was collected. SqlSimCity's live sampling path is
/// deliberately lazy about plan XML (see requirement 6): ordinary sampled requests carry
/// <see cref="NotRequested"/>, because no plan lookup was attempted at all. <see cref="Unavailable"/>
/// models a separate, explicit lazy plan lookup that was attempted and denied/failed.
/// </summary>
public enum PlanCollectionState { NotRequested, Available, Unavailable }

/// <summary>
/// The outcome of comparing one cumulative counter sample against the immediately preceding one
/// for the same target/epoch (see requirement 5). A counter regression or an engine restart always
/// starts a new epoch and never yields a fabricated negative or zero rate.
/// </summary>
public enum CounterEpochState { FirstSample, Delta, EpochReset }

/// <summary>Run state of the background <c>LiveIncidentSampler</c> loop.</summary>
public enum SamplerRunState { Running, Paused, Stopped, Reconnecting }

/// <summary>
/// The lock-resource form named by <c>wait_resource</c> / <c>resource_description</c>. Parsed from
/// the verbatim text only -- an unrecognised prefix stays <see cref="Unrecognized"/> rather than
/// being coerced into a plausible-looking kind.
/// </summary>
public enum LockResourceKind
{
    None,
    Key,

    // CA1720: 'Object' is SQL Server's own name for this lock resource type (OBJECT: db:objectid),
    // and the wire value is consumed as the literal string "Object". Renaming it would misreport
    // the engine's vocabulary, so the rule is suppressed here rather than the name changed.
#pragma warning disable CA1720
    Object,
#pragma warning restore CA1720
    Page,
    Rid,
    HoBt,
    Table,
    Extent,
    File,
    Application,
    Metadata,
    Database,
    AllocationUnit,

    /// <summary>
    /// An <c>XACT</c> lock: a lock taken on a transaction id (TID) rather than on any row, key or
    /// object. Introduced by optimized locking (SQL Server 2025 / Azure SQL Database, Managed
    /// Instance and Fabric SQL), where a writer holds one <c>X</c> lock on its own TID for the life
    /// of the transaction and waiters queue on that TID with an <c>S</c> lock, instead of each row
    /// or key lock being held to commit.
    /// </summary>
    Transaction,
    Unrecognized,
}

/// <summary>
/// How far a lock resource could be traced to a user object.
/// <see cref="Resolved"/> means an object id is known (either stated directly in the resource text
/// or looked up from a <c>hobt_id</c>); <see cref="RequiresLookup"/> means the resource names a
/// hobt/allocation unit that the bounded lookup did not cover; <see cref="NotObjectScoped"/> means
/// the lock is genuinely not on a user object (a database, file, or application lock);
/// <see cref="Unresolvable"/> means resolution would need a cost we refuse to pay in a realtime
/// probe (a page or row id needs an allocation scan). None of these are ever guessed.
/// </summary>
public enum LockResolutionStatus
{
    Resolved,
    RequiresLookup,
    NotObjectScoped,
    Unresolvable,
    Unrecognized,
}

/// <summary>
/// A parsed (and, where cheap and safe, resolved) lock resource. Optional throughout the live
/// contracts: it is emitted only once the lock-resource probe has run, so a consumer must treat its
/// absence as "not claimed" rather than "no lock". <see cref="RawResource"/> always preserves the
/// engine's own text so the parse can be audited.
/// </summary>
public sealed record LockResourceV1(
    string RawResource,
    LockResourceKind Kind,
    int? DatabaseId,
    int? ObjectId,
    int? IndexId,
    string? SchemaName,
    string? ObjectName,
    string? IndexName,
    LockResolutionStatus Status,
    string Reason)
{
    /// <summary>The <c>hobt_id</c> named by a KEY/HOBT/PAGE-style resource, when the text carries one.</summary>
    public long? HobtId { get; init; }

    /// <summary>
    /// The transaction id (TID) named by an <c>XACT</c> resource under optimized locking. Preserved
    /// because it is the one identifier such a wait does carry: it joins to
    /// <c>sys.dm_tran_locks.request_owner_id</c> and to the blocker's own transaction, which is how
    /// a reader gets from the wait to the statement responsible for it.
    /// </summary>
    public long? TransactionId { get; init; }
}

/// <summary>One waiting task, or one blocked/blocking request, preserving <c>blocking_session_id</c> verbatim plus its decoded sentinel meaning.</summary>
public sealed record BlockingReferenceV1(long? BlockingSessionId, BlockingSentinelKind Sentinel)
{
    public static BlockingReferenceV1 FromRaw(long? rawBlockingSessionId) => rawBlockingSessionId switch
    {
        null or 0 => new BlockingReferenceV1(rawBlockingSessionId, BlockingSentinelKind.None),
        -2 => new BlockingReferenceV1(rawBlockingSessionId, BlockingSentinelKind.OrphanedDistributedTransaction),
        -3 => new BlockingReferenceV1(rawBlockingSessionId, BlockingSentinelKind.DeferredRecoveryTransaction),
        -4 => new BlockingReferenceV1(rawBlockingSessionId, BlockingSentinelKind.IndeterminateLatchOwner),
        -5 => new BlockingReferenceV1(rawBlockingSessionId, BlockingSentinelKind.UntrackedLatchOwner),
        _ => new BlockingReferenceV1(rawBlockingSessionId, BlockingSentinelKind.None),
    };
}

/// <summary>
/// What a text length cap omitted from one sampled row. Present only when a cap actually shortened
/// something, and never a substitute for the text itself: <see cref="TotalCharacters"/> is the
/// untruncated length the engine reported, so a reader can always tell "4,096 characters of a
/// 1,048,576-character batch" from "a 4,096-character batch".
/// <para>
/// The cap exists because batch text is unbounded by anything SqlSimCity controls and is the
/// dominant cost of a live snapshot -- see <c>sql/probes/sessions/active_requests.sql</c> for the
/// measurements. Truncating without saying so would trade a bandwidth problem for an
/// evidence-honesty one, which is why this record travels with the row rather than the cap being
/// applied silently.
/// </para>
/// </summary>
public sealed record LiveTextTruncationV1(
    int RetainedCharacters,
    int TotalCharacters,
    string Reason);

/// <summary>
/// What a row cap omitted from one sampled collection. Present only when the cap actually cut rows.
/// <see cref="TotalRows"/> is the count that matched before the cap, so a bounded sample is never
/// mistaken for a smaller server -- "5,009 sessions, showing 1,000" stays distinguishable from
/// "1,000 sessions".
/// </summary>
public sealed record SampleTruncationV1(
    string Field,
    int ReturnedRows,
    int TotalRows,
    string Reason);

/// <summary>
/// One sampled live session/request from <c>sessions.active_requests</c>. Every bigint counter
/// (reads/writes/logical reads) is a lossless base-10 string, never a narrowed numeric type.
/// <see cref="Availability"/>/<see cref="AvailabilityReason"/> record when a previously-seen
/// request has disappeared between polling cycles (it completed or was killed) rather than
/// silently omitting the row -- see requirement 6's short-lived-query disclosure.
/// <para>
/// Sampling includes idle sessions on purpose, so a row here is not necessarily a request. A row
/// with a null <see cref="RequestStatus"/> is an idle session that holds no request at all, and is
/// never a request whose state went unreported; see that member for why the distinction has to
/// survive.
/// </para>
/// </summary>
public sealed record LiveRequestV1(
    string RequestId,
    int SessionId,
    string? LoginName,
    string? HostName,
    string? ProgramName,
    string? SessionStatus,
    /// <summary>
    /// <c>sys.dm_exec_requests.status</c>, passed through verbatim, or null when this row is an idle
    /// session with no request. That column is never null for a request that exists, so null here is
    /// positive evidence of "no request" rather than "a request in some unreported state" -- which is
    /// what lets a consumer count running requests without counting idle connections. Never
    /// substitute a synthetic value such as "idle": doing so made every idle pooled connection read
    /// as a running request in atlas activity (issue #79). Idleness remains readable from
    /// <see cref="RequestId"/> (<c>req:&lt;session&gt;:idle</c>) and <see cref="SessionStatus"/>.
    /// </summary>
    string? RequestStatus,
    string? Command,
    string? WaitType,
    long? WaitTimeMs,
    string? WaitResource,
    BlockingReferenceV1 Blocking,
    DateTimeOffset? RequestStartTime,
    long? TotalElapsedMs,
    long? CpuTimeMs,
    string? Reads,
    string? Writes,
    string? LogicalReads8KiBPages,
    int? OpenTransactionCount,
    string? DatabaseId,
    string? DatabaseName,
    string? CurrentStatementText,
    string? BatchText,
    SampleAvailability Availability,
    string? AvailabilityReason,
    PlanCollectionState PlanState,
    string? PlanReason)
{
    /// <summary>
    /// The parsed/resolved form of <see cref="WaitResource"/>. Null when the lock-resource probe did
    /// not run, so consumers must not read null as "this request holds no lock".
    /// </summary>
    public LockResourceV1? LockResource { get; init; }

    /// <summary>
    /// What a text length cap removed from <see cref="BatchText"/>, or null when it was returned
    /// whole. Null therefore means "this is the entire batch", which is exactly the claim a silent
    /// truncation would have made falsely.
    /// </summary>
    public LiveTextTruncationV1? BatchTextTruncation { get; init; }

    /// <summary>
    /// What a text length cap removed from <see cref="CurrentStatementText"/>, or null when it was
    /// returned whole. Tracked separately from <see cref="BatchTextTruncation"/> because a short
    /// statement inside a very long batch is truncated in the batch and not in the statement.
    /// </summary>
    public LiveTextTruncationV1? CurrentStatementTextTruncation { get; init; }
}

/// <summary>
/// One row of the current wait queue from <c>sessions.waiting_tasks</c>, preserving
/// <c>exec_context_id</c> so a request's parallel worker waits are never collapsed to a single
/// coordinator wait (requirement 4).
/// </summary>
public sealed record WaitingTaskV1(
    string TaskId,
    int SessionId,
    ExecutionContextKind ExecutionContext,
    int ExecContextId,
    string? WaitType,
    string WaitDurationMs,
    string? ResourceDescription,
    BlockingReferenceV1 Blocking)
{
    /// <summary>
    /// The parsed/resolved form of <see cref="ResourceDescription"/>. Null when the lock-resource
    /// probe did not run.
    /// </summary>
    public LockResourceV1? LockResource { get; init; }
}

/// <summary>One node in the reconstructed blocking graph: a real session, or an external/indeterminate sentinel "owner".</summary>
public sealed record BlockingNodeV1(
    string NodeId,
    BlockingNodeKind Kind,
    int? SessionId,
    BlockingSentinelKind Sentinel,
    bool IsRoot,
    bool IsIdleWithOpenTransaction,
    bool InCycle,
    int DirectlyBlockedCount);

/// <summary>One directed edge: <see cref="FromNodeId"/> (blocked) waits on <see cref="ToNodeId"/> (blocker).</summary>
public sealed record BlockingEdgeV1(
    string EdgeId,
    string FromNodeId,
    string ToNodeId,
    string? WaitType,
    string? WaitDurationMs,
    ExecutionContextKind? ExecutionContext,
    int? ExecContextId);

/// <summary>
/// A durable, documented summary of the graph. This is a convenience rollup only -- every parallel
/// waiting task is still present individually in <see cref="BlockingGraphV1.Edges"/> and
/// <see cref="LiveIncidentSnapshotV1.WaitingTasks"/>; this summary never substitutes for that
/// per-task detail (requirement 4).
/// </summary>
public sealed record BlockingGraphSummaryV1(
    int BlockedSessionCount,
    int RootBlockerCount,
    int SentinelRootCount,
    int CycleCount,
    int ParallelWaitTaskCount,
    string Note);

/// <summary>
/// The reconstructed blocking graph for one sample. Built entirely by the application from
/// <c>sessions.blocking_inputs</c> and <c>sessions.waiting_tasks</c> raw facts -- the probes
/// themselves never compute a root or a graph (see their own headers).
/// </summary>
public sealed record BlockingGraphV1(
    IReadOnlyList<BlockingNodeV1> Nodes,
    IReadOnlyList<BlockingEdgeV1> Edges,
    IReadOnlyList<string> RootNodeIds,
    IReadOnlyList<IReadOnlyList<string>> Cycles,
    BlockingGraphSummaryV1 Summary);

/// <summary>
/// One row of <c>sessions.memory_grants</c>. <see cref="IsWaitingForGrant"/> is
/// <c>grant_time IS NULL</c>, the authoritative "still waiting" signal; <see cref="WaitTimeMs"/> has
/// the inverted null-timing documented on the probe (populated only while waiting).
/// </summary>
public sealed record MemoryGrantV1(
    int SessionId,
    int? RequestId,
    int? SchedulerId,
    int? Dop,
    DateTimeOffset? RequestTime,
    DateTimeOffset? GrantTime,
    bool IsWaitingForGrant,
    string? RequestedKb,
    string? GrantedKb,
    string? RequiredKb,
    string? UsedKb,
    string? MaxUsedKb,
    string? IdealKb,
    decimal? QueryCost,
    int? TimeoutSec,
    string? WaitTimeMs,
    string? BatchText);

public sealed record TempdbFileUsageV1(
    int FileId,
    decimal TotalMb,
    decimal AllocatedMb,
    decimal FreeMb,
    decimal VersionStoreMb,
    decimal UserObjectsMb,
    decimal InternalObjectsMb,
    decimal MixedExtentMb);

public sealed record TempdbSessionUsageV1(
    int SessionId,
    string UserObjectsAllocPageCount,
    string UserObjectsDeallocPageCount,
    string InternalObjectsAllocPageCount,
    string InternalObjectsDeallocPageCount);

public sealed record TempdbTaskUsageV1(
    int SessionId,
    int? RequestId,
    int ExecContextId,
    string UserObjectsAllocPageCount,
    string UserObjectsDeallocPageCount,
    string InternalObjectsAllocPageCount,
    string InternalObjectsDeallocPageCount);

/// <summary>
/// tempdb space usage. Requires the correct tempdb connection context (see
/// sql/probes/tempdb/tempdb_usage.sql); on Azure SQL Database this is the database's own private
/// tempdb, a supported path distinct from server-wide tempdb visibility.
/// </summary>
public sealed record TempdbUsageV1(
    IReadOnlyList<TempdbFileUsageV1> Files,
    IReadOnlyList<TempdbSessionUsageV1> Sessions,
    IReadOnlyList<TempdbTaskUsageV1> Tasks,
    DataStatus Status,
    string Reason);

/// <summary>
/// One counter's delta result across the immediately preceding sample and this one. A regression
/// or an engine restart between samples always yields <see cref="CounterEpochState.EpochReset"/>
/// with a null delta/rate rather than a fabricated negative or zero throughput (requirement 5).
/// </summary>
public sealed record CounterDeltaV1(CounterEpochState State, string? DeltaValue, decimal? RatePerSecond, string Reason);

/// <summary>
/// Per-file cumulative I/O counter deltas from <c>io.file_io_stats</c> /
/// <c>io.file_io_stats_current_db</c>. <see cref="EpochId"/> increments every time an engine
/// restart or counter regression is detected for this file, so a UI/consumer can tell "no rate yet"
/// apart from "the engine just restarted".
/// </summary>
public sealed record FileIoDeltaV1(
    int DatabaseId,
    string? DatabaseName,
    int FileId,
    string? TypeDesc,
    long EpochId,
    decimal? SampleWindowMs,
    CounterDeltaV1 ReadsDelta,
    CounterDeltaV1 BytesReadDelta,
    CounterDeltaV1 IoStallReadMsDelta,
    CounterDeltaV1 WritesDelta,
    CounterDeltaV1 BytesWrittenDelta,
    CounterDeltaV1 IoStallWriteMsDelta);

public sealed record FileIoSampleV1(IReadOnlyList<FileIoDeltaV1> Files, DataStatus Status, string Reason);

/// <summary>
/// Per-scheduler CPU/runnable-queue pressure. <c>current_tasks_count</c>/<c>runnable_tasks_count</c>
/// etc. are instant gauges and are reported as-is; <c>total_cpu_usage_ms</c>/
/// <c>total_scheduler_delay_ms</c> are cumulative since engine start and are delta'd the same way as
/// file I/O counters (requirement 5).
/// </summary>
public sealed record SchedulerSampleV1(
    int SchedulerId,
    int CpuId,
    string? Status,
    bool IsOnline,
    bool IsIdle,
    int CurrentTasksCount,
    int RunnableTasksCount,
    int CurrentWorkersCount,
    int ActiveWorkersCount,
    int WorkQueueCount,
    int PendingDiskIoCount,
    int LoadFactor,
    long EpochId,
    decimal? SampleWindowMs,
    CounterDeltaV1 CpuUsageMsDelta,
    CounterDeltaV1 SchedulerDelayMsDelta,
    int? IdealWorkersLimit);

public sealed record SchedulerPressureV1(IReadOnlyList<SchedulerSampleV1> Schedulers, DataStatus Status, string Reason);

/// <summary>Transaction log size/utilization for the current database. An instant gauge -- never delta'd.</summary>
public sealed record LogSpaceUsageV1(
    decimal? TotalLogSizeMb,
    decimal? UsedLogSpaceMb,
    decimal? UsedLogSpacePercent,
    DataStatus Status,
    string Reason);

/// <summary>One subsystem sample this snapshot could not collect, and why -- never a silent omission.</summary>
public sealed record UnavailableFieldV1(string Field, DataStatus Status, string Reason);

/// <summary>
/// Collection metadata for one sample cycle: its position in the sampling sequence, when the
/// server-side facts were actually observed versus when this process finished assembling them, how
/// long assembly took, and how many scheduled cycles were skipped (overlap avoided) or missed
/// (paused/backing off) since the sampler started.
/// </summary>
public sealed record CollectionDiagnosticsV1(
    long Sequence,
    DateTimeOffset CollectedAt,
    DateTimeOffset? SourceTimestamp,
    long DurationMs,
    long MissedCycles,
    long SkippedCycles,
    IReadOnlyList<UnavailableFieldV1> UnavailableFields)
{
    /// <summary>
    /// Every collection a row cap bounded this cycle, and how much it left out. Empty means nothing
    /// was capped -- the counterpart of <see cref="UnavailableFields"/> for evidence that was
    /// reached but deliberately not all returned, rather than evidence that could not be sampled at
    /// all. A consumer that ignores this list will under-report the server; it must never be read
    /// as decoration.
    /// </summary>
    public IReadOnlyList<SampleTruncationV1> Truncations { get; init; } = [];
}

public sealed record LiveIncidentTargetV1(
    string TargetId,
    string DisplayName,
    string Platform,
    string VisibilityScope,
    string? UnavailableServerWideEvidenceReason);

/// <summary>
/// The canonical, versioned, immutable snapshot the sampler publishes once per cycle. Produced
/// identically by a fixture-backed and a live <c>Microsoft.Data.SqlClient</c>-backed
/// <c>ILiveIncidentCollector</c> (see <c>SqlSimCity.Collection</c>). <see cref="FreshUntil"/> is the
/// point after which a consumer should treat this snapshot as stale even without a newer one
/// arriving; <see cref="Status"/>/<see cref="Reason"/> record disconnection/permission/timeout
/// causes explicitly rather than an empty snapshot standing in for "nothing is happening".
/// </summary>
public sealed record LiveIncidentSnapshotV1(
    string SchemaVersion,
    LiveIncidentTargetV1 Target,
    DateTimeOffset? SourceTimestamp,
    DateTimeOffset CollectedAt,
    DateTimeOffset? FreshUntil,
    DataStatus Status,
    string Reason,
    IReadOnlyList<LiveRequestV1> Requests,
    IReadOnlyList<WaitingTaskV1> WaitingTasks,
    BlockingGraphV1 BlockingGraph,
    IReadOnlyList<MemoryGrantV1> MemoryGrants,
    TempdbUsageV1 Tempdb,
    FileIoSampleV1 FileIo,
    SchedulerPressureV1 Scheduler,
    LogSpaceUsageV1 LogSpace,
    CollectionDiagnosticsV1 Diagnostics);

/// <summary>
/// The <c>LiveIncidentSampler</c>'s own operational status, independent of whether a snapshot has
/// ever successfully been produced -- so a consumer can distinguish "paused", "reconnecting with
/// backoff", and "stopped" from ordinary staleness of the last good snapshot.
/// </summary>
public sealed record LiveCollectorStatusV1(
    SamplerRunState State,
    long Sequence,
    DateTimeOffset? LastSuccessAt,
    DateTimeOffset? LastAttemptAt,
    long ConsecutiveFailures,
    double? NextAttemptInMs,
    string? LastErrorReason,
    long MissedCycles,
    long SkippedCycles);

/// <summary>The <c>/api/v1/live</c> response shape: the latest immutable snapshot (if any) plus the sampler's own status.</summary>
public sealed record LiveIncidentResponseV1(LiveIncidentSnapshotV1? Snapshot, LiveCollectorStatusV1 Collector);
