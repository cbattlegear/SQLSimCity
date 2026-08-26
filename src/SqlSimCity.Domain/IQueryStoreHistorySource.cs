using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Domain;

public sealed class QueryStorePageTokenException(string message) : Exception(message);

public interface IQueryStoreHistorySource
{
    Task<PageV1<QueryFamilySummaryV1>> GetQueriesAsync(
        string? databaseId,
        string metric,
        int pageSize,
        string? pageToken,
        CancellationToken cancellationToken);
    Task<QueryFamilyDetailV1?> GetFamilyAsync(string familyId, CancellationToken cancellationToken);
    Task<NormalizedShowplanV1?> GetPlanAsync(string planId, CancellationToken cancellationToken);
    Task<PlanComparisonV1?> ComparePlansAsync(
        string leftPlanId,
        string rightPlanId,
        CancellationToken cancellationToken);
    Task<QueryStoreCollectorStatusV1> GetStatusAsync(CancellationToken cancellationToken);

    /// <summary>
    /// The same read as <see cref="GetFamilyAsync"/>, except that it says which kind of nothing a
    /// nothing is. A caller that drops an unavailable family silently evaluates a smaller store than
    /// the one it is describing, and cannot tell anyone that it did.
    /// </summary>
    /// <remarks>
    /// The default cannot distinguish, so it reports the safe-to-reason-from answer that the
    /// nullable methods have always implied. A source that can tell the two apart -- anything that
    /// talks to a server, or that has no published snapshot to consult -- must override it. This is
    /// a default rather than a required member so that adding it costs no source and no test fake a
    /// change it does not need.
    /// </remarks>
    async Task<QueryStoreReadV1<QueryFamilyDetailV1>> ReadFamilyAsync(
        string familyId,
        CancellationToken cancellationToken) =>
        await GetFamilyAsync(familyId, cancellationToken).ConfigureAwait(false) is { } detail
            ? QueryStoreRead.Available(detail)
            : QueryStoreRead.Absent<QueryFamilyDetailV1>(
                "This Query Store source holds no detail for this family.");

    /// <summary>
    /// The same read as <see cref="GetPlanAsync"/>, except that it distinguishes a Showplan that is
    /// not there from one this source could not read. See <see cref="ReadFamilyAsync"/> for why the
    /// default is the conservative one.
    /// </summary>
    async Task<QueryStoreReadV1<NormalizedShowplanV1>> ReadPlanAsync(
        string planId,
        CancellationToken cancellationToken) =>
        await GetPlanAsync(planId, cancellationToken).ConfigureAwait(false) is { } plan
            ? QueryStoreRead.Available(plan)
            : QueryStoreRead.Absent<NormalizedShowplanV1>(
                "This Query Store source holds no Showplan under this plan id.");

    /// <summary>
    /// The same read as <see cref="ComparePlansAsync"/>, except that "no comparison" says whether a
    /// side was missing or merely unreadable.
    /// </summary>
    /// <remarks>
    /// The default asks each side why only once the comparison has already come back empty, so the
    /// hot path costs exactly what it did before and only the failure path pays for the explanation.
    /// It defers to <see cref="ComparePlansAsync"/> rather than composing the two sides itself
    /// because a source may compare by its own rules.
    /// </remarks>
    async Task<QueryStoreReadV1<PlanComparisonV1>> ReadComparisonAsync(
        string leftPlanId,
        string rightPlanId,
        CancellationToken cancellationToken)
    {
        if (await ComparePlansAsync(leftPlanId, rightPlanId, cancellationToken).ConfigureAwait(false) is { } comparison)
            return QueryStoreRead.Available(comparison);
        return QueryStoreRead.NoComparison(
            await ReadPlanAsync(leftPlanId, cancellationToken).ConfigureAwait(false),
            await ReadPlanAsync(rightPlanId, cancellationToken).ConfigureAwait(false));
    }
}
