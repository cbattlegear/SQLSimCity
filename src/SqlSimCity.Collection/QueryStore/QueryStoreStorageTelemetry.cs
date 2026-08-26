using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using SqlSimCity.Storage;

namespace SqlSimCity.Collection.QueryStore;

/// <summary>
/// Reports what protected storage is holding and whether retention is keeping up, once per
/// collection cycle. Issue #82 estimated the retained plan cache at 25 GB from assumed inputs;
/// this exists so the figure comes off the running deployment instead.
///
/// It is deliberately a separate object from the background loop that calls it: the loop is a
/// timing construct that is awkward to test, and this is the part with behaviour worth pinning.
/// </summary>
public sealed class QueryStoreStorageTelemetry(
    IProtectedRecordStore store,
    ProtectedQueryStoreRepository repository,
    RetentionOptions retention,
    QueryStorePlanCacheOptions planCache,
    TimeProvider timeProvider,
    ILogger<QueryStoreStorageTelemetry>? logger = null)
{
    /// <summary>
    /// Retained size and composition, at Information because an operator sizing a volume should
    /// not need verbose logging to see what the store holds. On-disk bytes are reported next to
    /// stored bytes because they differ, and the gap matters: SQLite keeps the pages a delete
    /// freed, so the disk actually consumed is the larger number and does not fall when records
    /// are pruned.
    /// </summary>
    private static readonly Action<ILogger, long, long, long, long, long, Exception?> LogUsage =
        LoggerMessage.Define<long, long, long, long, long>(
            LogLevel.Information, new EventId(23, "ProtectedStorageUsage"),
            "Protected storage holds {RecordCount} records, {StoredBytes} bytes, {OnDiskBytes} bytes on " +
            "disk. The on-demand plan cache is {PlanCacheRecordCount} records and {PlanCacheBytes} bytes " +
            "of that.");

    /// <summary>
    /// A backlog above one batch means retention is falling behind: one prune deletes at most
    /// <see cref="RetentionOptions.PruneBatchSize"/> records and one prune runs per collection
    /// cycle, so expired records survive for at least ceil(backlog / batch) further cycles.
    /// Warning rather than Information because it is a bound not being met, not a number to note.
    /// </summary>
    private static readonly Action<ILogger, long, int, long, int, Exception?> LogBacklog =
        LoggerMessage.Define<long, int, long, int>(
            LogLevel.Warning, new EventId(24, "ProtectedStoragePruneBacklog"),
            "Protected storage retention is behind: {ExpiredRecordCount} expired records remain after " +
            "pruning {PrunedRecordCount} this cycle, so draining the backlog needs about " +
            "{CyclesToDrain} more collection cycles at a prune batch size of {PruneBatchSize}.");

    /// <summary>
    /// Information rather than Warning: an operator who set a quota asked for this, and the
    /// evicted records are a cache of the source's own data that re-hydrates on the next request
    /// for it. Silence would be worse -- an unexplained cache miss looks like a bug.
    /// </summary>
    private static readonly Action<ILogger, int, int, long, long, long, Exception?> LogEviction =
        LoggerMessage.Define<int, int, long, long, long>(
            LogLevel.Information, new EventId(25, "QueryStorePlanCacheEviction"),
            "Query Store plan cache exceeded its quota, so {EvictedEntries} of the oldest entries " +
            "({EvictedRecords} records, {ReclaimedBytes} bytes) were evicted, leaving " +
            "{RetainedBytes} bytes against a {QuotaBytes} byte quota. Evicted plans and query text " +
            "are re-read from the source the next time they are requested.");

    private readonly ILogger _logger = logger ?? NullLogger<QueryStoreStorageTelemetry>.Instance;
    private DateTimeOffset _measuredAt = DateTimeOffset.MinValue;

    /// <summary>
    /// How long to wait between measurements. Measuring composition walks every retained record,
    /// so it runs on its own floor rather than on the refresh interval: a five-second refresh
    /// must not make telemetry the dominant cost of the loop. The default collection cycle is two
    /// minutes, so a deployment on a normal cadence still gets this every few cycles.
    /// </summary>
    public TimeSpan MeasurementInterval { get; init; } = TimeSpan.FromMinutes(5);

    /// <summary>The most recent measurement, or <see cref="ProtectedStorageUsage.Empty"/> before the first.</summary>
    public ProtectedStorageUsage LastUsage { get; private set; } = ProtectedStorageUsage.Empty;

    /// <summary>What the most recent quota pass reclaimed.</summary>
    public QueryStorePlanCacheEviction LastEviction { get; private set; } = QueryStorePlanCacheEviction.None;

    /// <summary>
    /// Measures, logs, and brings the plan cache back inside its quota, unless
    /// <see cref="MeasurementInterval"/> has not elapsed since the last measurement. Returns the
    /// measurement it took, or <c>null</c> when it skipped.
    /// </summary>
    public async Task<ProtectedStorageUsage?> ReportAsync(
        int prunedRecordCount, CancellationToken cancellationToken = default)
    {
        var now = timeProvider.GetUtcNow();
        if (now - _measuredAt < MeasurementInterval) return null;
        _measuredAt = now;

        var usage = await store.MeasureUsageAsync(cancellationToken).ConfigureAwait(false);
        LastUsage = usage;
        LogUsage(
            _logger, usage.RecordCount, usage.StoredBytes, usage.OnDiskBytes,
            usage.RecordCountForKinds(ProtectedQueryStoreRepository.PlanCacheRecordKinds),
            usage.StoredBytesForKinds(ProtectedQueryStoreRepository.PlanCacheRecordKinds),
            null);
        if (usage.ExpiredRecordCount > retention.PruneBatchSize)
            LogBacklog(
                _logger, usage.ExpiredRecordCount, prunedRecordCount,
                CyclesToDrain(usage.ExpiredRecordCount, retention.PruneBatchSize),
                retention.PruneBatchSize, null);

        var eviction = await repository.EnforcePlanCacheQuotaAsync(
            usage, planCache.QuotaBytes, cancellationToken).ConfigureAwait(false);
        LastEviction = eviction;
        if (eviction.EvictedEntries > 0)
            LogEviction(
                _logger, eviction.EvictedEntries, eviction.EvictedRecords, eviction.ReclaimedBytes,
                eviction.RetainedBytesAfter, planCache.QuotaBytes, null);
        return usage;
    }

    private static long CyclesToDrain(long backlog, int batchSize) =>
        batchSize <= 0 ? 0 : (backlog + batchSize - 1) / batchSize;
}
