using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.DatabaseCity;

public sealed record DatabaseCityInventoryRow(
    int ObjectId,
    int SchemaId,
    int SchemaLayoutOrdinal,
    string SchemaName,
    string ObjectName,
    DatabaseObjectKind Kind,
    string? ReservedPages8KiB,
    string? UsedPages8KiB,
    int? IndexId,
    string? IndexName,
    DatabaseIndexKind? IndexKind);

public sealed record DatabaseCityIndexUsageRow(
    int ObjectId,
    int IndexId,
    string TotalOperations);

/// <param name="OldestLastUpdated">
/// The stalest statistic on the object, or <see langword="null"/> when none has ever been updated.
/// Never conflate that null with freshness: <paramref name="NeverUpdatedCount"/> carries it.
/// </param>
/// <param name="UnreadableCount">
/// Statistics whose properties could not be read, which is missing evidence rather than staleness.
/// </param>
/// <param name="PastAutoUpdateThresholdCount">
/// Statistics whose modification counter has passed the engine's own AUTO_UPDATE_STATISTICS
/// recompilation threshold for their cardinality. This is the measured answer to "should this be
/// updated"; age is not, because a statistic built long ago against a table nothing has modified
/// since is still exactly right. Unreadable statistics contribute nothing to it.
/// </param>
public sealed record DatabaseCityStatisticsAgeRow(
    int ObjectId,
    DateTimeOffset? OldestLastUpdated,
    int StatisticsCount,
    int NeverUpdatedCount,
    int UnreadableCount,
    string? ModificationCounter,
    int PastAutoUpdateThresholdCount);

/// <param name="TotalObjects">
/// Every object the inventory probe would return across all pages, unbounded by the keyset, or
/// <see langword="null"/> when the count could not be established. It is not the number of rows on
/// this page.
/// </param>
public sealed record DatabaseCityProbePage(
    IReadOnlyList<DatabaseCityInventoryRow> Inventory,
    IReadOnlyList<DatabaseCityIndexUsageRow> Usage,
    DataStatus UsageStatus,
    string UsageReason,
    DateTimeOffset ObservedAt,
    string? TotalObjects = null,
    // Statistics freshness carries its own status because it is a separate probe against a separate
    // DMF: it can be denied while index usage succeeds, and an empty list under an Available status
    // means "measured, no statistics" rather than "not collected".
    IReadOnlyList<DatabaseCityStatisticsAgeRow>? Statistics = null,
    DataStatus StatisticsStatus = DataStatus.Unknown,
    string? StatisticsReason = null);

public interface IDatabaseCityProbeExecutor
{
    Task<DatabaseCityProbePage> CollectPageAsync(
        string databaseName,
        int afterObjectId,
        int topN,
        CancellationToken cancellationToken);
}
