using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Domain;

public sealed class UnavailableQueryStoreHistorySource : IQueryStoreHistorySource
{
    public Task<PageV1<QueryFamilySummaryV1>> GetQueriesAsync(
        string? databaseId, string metric, int pageSize, string? pageToken, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(new PageV1<QueryFamilySummaryV1>(
            "1.0", [], null, Math.Clamp(pageSize, 1, 200), null)
        {
            Evidence = new QueryStoreEvidenceV1(
                QueryStoreSource.QueryStore, DataStatus.Unknown, null, null,
                "Connected Query Store history collection is not enabled; no fixture data is substituted.",
                "No history is shown as zero. Configure protected storage before enabling connected history collection."),
        });
    }

    public Task<QueryFamilyDetailV1?> GetFamilyAsync(string familyId, CancellationToken cancellationToken) =>
        Task.FromResult<QueryFamilyDetailV1?>(null);
    public Task<NormalizedShowplanV1?> GetPlanAsync(string planId, CancellationToken cancellationToken) =>
        Task.FromResult<NormalizedShowplanV1?>(null);
    public Task<PlanComparisonV1?> ComparePlansAsync(
        string leftPlanId, string rightPlanId, CancellationToken cancellationToken) =>
        Task.FromResult<PlanComparisonV1?>(null);

    // Nothing this source returns nothing for is absent. It has not looked, and it is not going to,
    // so every empty answer here is unavailable evidence rather than a fact about the target.
    public Task<QueryStoreReadV1<QueryFamilyDetailV1>> ReadFamilyAsync(
        string familyId, CancellationToken cancellationToken) =>
        Task.FromResult(QueryStoreRead.Unavailable<QueryFamilyDetailV1>(DataStatus.Disabled, Disabled));
    public Task<QueryStoreReadV1<NormalizedShowplanV1>> ReadPlanAsync(
        string planId, CancellationToken cancellationToken) =>
        Task.FromResult(QueryStoreRead.Unavailable<NormalizedShowplanV1>(DataStatus.Disabled, Disabled));
    public Task<QueryStoreReadV1<PlanComparisonV1>> ReadComparisonAsync(
        string leftPlanId, string rightPlanId, CancellationToken cancellationToken) =>
        Task.FromResult(QueryStoreRead.Unavailable<PlanComparisonV1>(DataStatus.Disabled, Disabled));

    private const string Disabled =
        "Connected Query Store history collection is not enabled, so nothing was read; " +
        "this is not evidence that the target holds no such record.";

    public Task<QueryStoreCollectorStatusV1> GetStatusAsync(CancellationToken cancellationToken) =>
        Task.FromResult(new QueryStoreCollectorStatusV1(
            "1.0", QueryStoreCollectorState.Disabled, 0, null, null, null, [],
            "Connected Query Store history is explicitly disabled."));
}
