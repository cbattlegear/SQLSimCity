using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Collection.Atlas;

public sealed record AtlasCollectionOptions
{
    public const int MaximumDatabases = 100;
    public const int MaximumConcurrency = 16;

    public string TargetId { get; init; } = "primary";
    public string DisplayName { get; init; } = "SQL Server";
    public IReadOnlyList<string> KnownDatabases { get; init; } = [];
    public int DatabaseConcurrency { get; init; } = 4;
    public TimeSpan QueryStoreWindow { get; init; } = TimeSpan.FromHours(24);
    public TimeSpan RefreshInterval { get; init; } = TimeSpan.FromMinutes(1);

    /// <summary>
    /// How often the Query Store workload aggregate is re-collected. Its cost is linear in the
    /// runtime-stats buckets the window covers, so a day-long window re-aggregated on every atlas
    /// cycle repeats the same scan around 1,440 times a day without the answer changing
    /// meaningfully. Between collections the previous result is reported unchanged, keeping its own
    /// observation time and window, which <see cref="QueryStoreHistoryV1"/> already carries.
    /// </summary>
    public TimeSpan QueryStoreRefreshInterval { get; init; } = TimeSpan.FromMinutes(15);

    public TimeSpan StaleAfter { get; init; } = TimeSpan.FromMinutes(3);

    public void Validate()
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(TargetId);
        ArgumentException.ThrowIfNullOrWhiteSpace(DisplayName);
        if (TargetId.Length > 128 || TargetId.Any(character =>
                !(char.IsAsciiLetterOrDigit(character) || character is '-' or '_' or '.' or ':')))
            throw new ArgumentException("TargetId must be 128 characters or fewer and use only ASCII letters, digits, '-', '_', '.', or ':'.",
                nameof(TargetId));
        if (DisplayName.Length > 256 || DisplayName.Any(char.IsControl))
            throw new ArgumentException("DisplayName must be 256 characters or fewer and contain no control characters.",
                nameof(DisplayName));
        if (DatabaseConcurrency is < 1 or > MaximumConcurrency)
            throw new ArgumentOutOfRangeException(nameof(DatabaseConcurrency));
        if (KnownDatabases.Count > MaximumDatabases)
            throw new ArgumentOutOfRangeException(nameof(KnownDatabases));
        if (KnownDatabases.Any(name => string.IsNullOrWhiteSpace(name) || name.Length > 128 || name.Any(char.IsControl)) ||
            KnownDatabases.Distinct(StringComparer.OrdinalIgnoreCase).Count() != KnownDatabases.Count)
            throw new ArgumentException("Known database names must be non-empty and unique.", nameof(KnownDatabases));
        if (QueryStoreWindow < TimeSpan.FromMinutes(1) || QueryStoreWindow > TimeSpan.FromDays(31))
            throw new ArgumentOutOfRangeException(nameof(QueryStoreWindow));
        if (RefreshInterval < TimeSpan.FromSeconds(10) || RefreshInterval > TimeSpan.FromHours(1))
            throw new ArgumentOutOfRangeException(nameof(RefreshInterval));
        if (QueryStoreRefreshInterval < RefreshInterval || QueryStoreRefreshInterval > TimeSpan.FromDays(1))
            throw new ArgumentOutOfRangeException(nameof(QueryStoreRefreshInterval));
        if (StaleAfter < RefreshInterval || StaleAfter > TimeSpan.FromDays(1))
            throw new ArgumentOutOfRangeException(nameof(StaleAfter));
    }
}

public sealed record AtlasTargetIdentity(
    EnginePlatform Platform,
    string ProductVersion,
    string Edition,
    string? SqlServerResetEpochToken,
    DateTimeOffset SourceTimestamp);

public sealed record AtlasDatabaseIdentity(
    string Name,
    string State,
    int CompatibilityLevel,
    bool IsQueryStoreOn,
    string? ResourceIdentity = null);

public sealed record AtlasProbeSelection(
    string QueryStoreOptionsProbeId,
    string? QueryStoreWorkloadProbeId,
    string FileIoProbeId);

public sealed record AtlasSpaceResult(
    string DataAllocatedBytes,
    string DataUsedBytes,
    string LogAllocatedBytes,
    string LogUsedBytes);

public sealed record AtlasQueryStoreOptionsResult(
    string ActualState,
    int ReadOnlyReason)
{
    public string? DesiredState { get; init; }
    public string? CaptureMode { get; init; }
    public string? CurrentStorageBytes { get; init; }
    public string? MaxStorageBytes { get; init; }
}

public sealed record AtlasQueryStoreWorkloadResult(
    string? ExecutionCount,
    string? TotalDurationMicroseconds,
    string? TotalCpuMicroseconds,
    string? LogicalReads8KiBPages,
    DateTimeOffset? WindowStart,
    DateTimeOffset? WindowEnd)
{
    public string? AbortedExecutionCount { get; init; }
    public string? ExceptionExecutionCount { get; init; }
}

public sealed record AtlasFileIoCounter(
    int FileId,
    string BytesRead,
    string BytesWritten,
    long SampleMilliseconds);

public sealed record AtlasDatabaseProbeResult(
    AtlasDatabaseIdentity Identity,
    AtlasComponentOutcome<AtlasSpaceResult> Space,
    AtlasComponentOutcome<AtlasQueryStoreOptionsResult> QueryStoreOptions,
    AtlasComponentOutcome<AtlasQueryStoreWorkloadResult> QueryStoreWorkload,
    AtlasComponentOutcome<IReadOnlyList<AtlasFileIoCounter>> FileIo,
    DateTimeOffset SourceTimestamp,
    int IdentityRowCount)
{
    /// <summary>
    /// Query Store is not a collected component of a system database, so its outcome is neither a
    /// failure nor a skip there and can never make a collection cycle report as degraded.
    /// </summary>
    private bool QueryStoreCollected => !SystemDatabases.IsSystemDatabase(Identity.Name);

    public int RowCount => IdentityRowCount + Space.RowCount + QueryStoreOptions.RowCount +
                           QueryStoreWorkload.RowCount + FileIo.RowCount;
    public int FailureCount => (Space.IsFailure ? 1 : 0) + (FileIo.IsFailure ? 1 : 0) +
                               (QueryStoreCollected
                                   ? (QueryStoreOptions.IsFailure ? 1 : 0) + (QueryStoreWorkload.IsFailure ? 1 : 0)
                                   : 0);
    public int SkipCount => (Space.IsSkipped ? 1 : 0) + (FileIo.IsSkipped ? 1 : 0) +
                            (QueryStoreCollected
                                ? (QueryStoreOptions.IsSkipped ? 1 : 0) + (QueryStoreWorkload.IsSkipped ? 1 : 0)
                                : 0);
}

public sealed record AtlasComponentOutcome<T>(
    T? Value,
    DataStatus Status,
    string Reason,
    int RowCount,
    bool IsSkipped)
{
    /// <summary>
    /// The component was not probed because its own refresh interval had not elapsed, not because
    /// anything about it was unavailable. Only this marker permits a previously collected value to
    /// be reported again; every other unprobed outcome describes a real condition that must not be
    /// papered over with an older success.
    /// </summary>
    public bool IsDeferred { get; init; }

    public bool IsSuccess => Value is not null && Status == DataStatus.Available;
    public bool IsFailure => Value is null && !IsSkipped;
}

public static class AtlasComponentOutcome
{
    public static AtlasComponentOutcome<T> Success<T>(T value, int rowCount, string reason) =>
        new(value, DataStatus.Available, reason, rowCount, false);

    public static AtlasComponentOutcome<T> Failure<T>(DataStatus status, string reason) =>
        new(default, status, reason, 0, false);

    public static AtlasComponentOutcome<T> Skipped<T>(DataStatus status, string reason) =>
        new(default, status, reason, 0, true);

    public static AtlasComponentOutcome<T> Deferred<T>(string reason) =>
        new(default, DataStatus.Unknown, reason, 0, true) { IsDeferred = true };
}

public sealed record AtlasCollectionResult(
    AtlasSnapshotV1 Snapshot,
    AtlasCollectorStatusV1 Status,
    bool ConnectionFailure);
