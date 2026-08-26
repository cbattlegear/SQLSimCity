namespace SqlSimCity.Collection.Probes;

/// <summary>
/// Row shape for <c>sessions.active_requests</c>: one visible session, joined to its active request
/// when one exists.
/// <para>
/// <see cref="VisibleSessionCount"/>, <see cref="BatchTextLength"/> and
/// <see cref="CurrentStatementTextLength"/> are the probe's own disclosure of what its two caps
/// omitted, and are what keep a bounded sample honest: the first is the row count <em>before</em>
/// <c>@MaxRows</c> applied, and the latter two are character counts <em>before</em>
/// <c>@MaxTextLength</c> applied. Without them a capped result would be indistinguishable from a
/// smaller server or a shorter statement.
/// </para>
/// </summary>
public sealed record ActiveRequestRow(
    int SessionId,
    string? LoginName,
    string? HostName,
    string? ProgramName,
    string? SessionStatus,
    DateTimeOffset? LastRequestStartTime,
    DateTimeOffset? LastRequestEndTime,
    int? RequestId,
    string? RequestStatus,
    string? Command,
    string? WaitType,
    int? WaitTimeMs,
    string? WaitResource,
    long? BlockingSessionId,
    DateTimeOffset? RequestStartTime,
    int? TotalElapsedTimeMs,
    int? CpuTimeMs,
    long? Reads,
    long? Writes,
    long? LogicalReads,
    int? OpenTransactionCount,
    int? DatabaseId,
    string? DatabaseName,
    string? BatchText,
    string? CurrentStatementText,
    int VisibleSessionCount,
    int SelectionRank,
    int? BatchTextLength,
    int? CurrentStatementTextLength);

/// <summary>Row shape for <c>sessions.memory_grants</c>.</summary>
public sealed record MemoryGrantRow(
    int SessionId,
    int? RequestId,
    int? SchedulerId,
    int? Dop,
    DateTimeOffset? RequestTime,
    DateTimeOffset? GrantTime,
    long? RequestedMemoryKb,
    long? GrantedMemoryKb,
    long? RequiredMemoryKb,
    long? UsedMemoryKb,
    long? MaxUsedMemoryKb,
    long? IdealMemoryKb,
    decimal? QueryCost,
    int? TimeoutSec,
    long? WaitTimeMs,
    int? GroupId,
    int? PoolId,
    string? BatchText);

/// <summary>One row of tempdb file-level space usage (result set 1 of <c>tempdb.usage</c>).</summary>
public sealed record TempdbFileRow(
    int DatabaseId,
    int FileId,
    decimal TotalMb,
    decimal AllocatedMb,
    decimal FreeMb,
    decimal VersionStoreMb,
    decimal UserObjectsMb,
    decimal InternalObjectsMb,
    decimal MixedExtentMb);

/// <summary>
/// One row of tempdb per-session space usage (result set 2 of <c>tempdb.usage</c>).
/// <see cref="VisibleSessionCount"/> is the row count before <c>@MaxSessionRows</c> applied, so a
/// bounded result discloses its own bound instead of reading as a quieter instance.
/// </summary>
public sealed record TempdbSessionRow(
    int SessionId,
    long UserObjectsAllocPageCount,
    long UserObjectsDeallocPageCount,
    long InternalObjectsAllocPageCount,
    long InternalObjectsDeallocPageCount,
    int VisibleSessionCount);

/// <summary>
/// One row of tempdb per-task space usage (result set 3 of <c>tempdb.usage</c>).
/// <see cref="VisibleTaskCount"/> is the row count before <c>@MaxTaskRows</c> applied.
/// </summary>
public sealed record TempdbTaskRow(
    int SessionId,
    int? RequestId,
    int ExecContextId,
    long UserObjectsAllocPageCount,
    long UserObjectsDeallocPageCount,
    long InternalObjectsAllocPageCount,
    long InternalObjectsDeallocPageCount,
    int VisibleTaskCount);

/// <summary>The combined, three-result-set output of <c>tempdb.usage</c>.</summary>
public sealed record TempdbUsageRaw(
    IReadOnlyList<TempdbFileRow> Files,
    IReadOnlyList<TempdbSessionRow> Sessions,
    IReadOnlyList<TempdbTaskRow> Tasks);

/// <summary>One row of <c>io.file_io_stats</c> / <c>io.file_io_stats_current_db</c>.</summary>
public sealed record FileIoRow(
    int DatabaseId,
    string? DatabaseName,
    int FileId,
    string? TypeDesc,
    long SampleMs,
    long NumOfReads,
    long NumOfBytesRead,
    long IoStallReadMs,
    long NumOfWrites,
    long NumOfBytesWritten,
    long IoStallWriteMs,
    long IoStall);

/// <summary>One row of <c>scheduler.pressure_2016</c> / <c>scheduler.pressure_2019</c>.</summary>
public sealed record SchedulerRow(
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
    long TotalCpuUsageMs,
    long TotalSchedulerDelayMs,
    int? IdealWorkersLimit);

/// <summary>Row shape for <c>space.log_space_usage</c>.</summary>
public sealed record LogSpaceRow(decimal TotalLogSizeMb, decimal UsedLogSpaceMb, decimal UsedLogSpacePercent);
