namespace SqlSimCity.Collection.QueryStore;

/// <summary>
/// The aggregate bound on the on-demand plan cache.
///
/// Raw Showplan XML, raw query text and the normalized plan derived from that XML are written
/// only when a request asks for them, and nothing removed them except the seven-day detail
/// retention -- which prunes at most <c>PruneBatchSize</c> records per collection cycle. Measured
/// against the workbench instance, one hydrated plan costs about 45 KB and a crawl produced
/// records more than six times faster than one prune per cycle removes them, so retention alone
/// is not a bound an operator can rely on. This is.
///
/// It is a soft cap, checked and enforced on the storage telemetry cadence rather than on the
/// write path: overshooting between checks costs disk, whereas checking on every hydration would
/// put a full store scan in a request.
/// </summary>
public sealed record QueryStorePlanCacheOptions(long QuotaBytes)
{
    /// <summary>
    /// 2 GiB, which at the measured ~45 KB per hydrated plan is roughly 45,000 distinct plans.
    /// Chosen to be far above what browsing produces and far below what an unattended crawler
    /// would reach, so it bounds the pathological case without evicting anything a real session
    /// is using. Raise it when the disk can take it; <c>0</c> restores the previous unbounded
    /// behaviour explicitly.
    /// </summary>
    public const long DefaultQuotaBytes = 2L * 1024 * 1024 * 1024;

    public static QueryStorePlanCacheOptions Default { get; } = new(DefaultQuotaBytes);

    /// <summary>No quota. Retention is then the only bound, which is the pre-quota behaviour.</summary>
    public static QueryStorePlanCacheOptions Unbounded { get; } = new(0);

    public void Validate()
    {
        if (QuotaBytes < 0)
            throw new ArgumentOutOfRangeException(
                nameof(QuotaBytes),
                "The Query Store plan cache quota must be zero (unbounded) or a positive byte count.");
    }
}
