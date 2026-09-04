using System.Collections.ObjectModel;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Collection.Tests.DatabaseCity;

/// <summary>
/// An in-memory Query Store that returns exactly the families, plans, and runtime buckets a test
/// declares, so attribution behaviour is judged against known evidence rather than a live server.
/// </summary>
internal sealed class FakeQueryStore : IQueryStoreHistorySource
{
    /// <summary>The atlas contract id of the same database, which the city page is addressed by.</summary>
    public const string DatabaseId = "target/database/sales";

    /// <summary>
    /// The key Query Store history is actually collected and indexed under: the SQL database name.
    /// It is deliberately different from <see cref="DatabaseId"/>, because a join that filters by
    /// the atlas id matches nothing and unattributes the whole page.
    /// </summary>
    public const string DatabaseName = "sales";

    /// <summary>Builds a showplan object reference, honouring showplan's optional bracket quoting.</summary>
    public static ShowplanObjectV1 Reference(
        string? database = null,
        string? schema = "dbo",
        string? table = null,
        string? index = null) => new(database, schema, table, index);

    /// <summary>Declares one compiled plan and the object references its nodes carry.</summary>
    public static (string PlanId, PlanNode[] Nodes) Plan(
        string planId,
        params ShowplanObjectV1[] references) =>
        (planId, references.Select(reference => new PlanNode(reference)).ToArray());

    /// <summary>
    /// Declares one compiled plan whose nodes carry row estimates. Separate from <see cref="Plan"/>
    /// because most attribution tests do not care about sizing, and a plan with no row estimates is
    /// the ordinary case a real Query Store returns for a plan compiled before the estimate existed.
    /// </summary>
    public static (string PlanId, PlanNode[] Nodes) SizedPlan(
        string planId,
        params PlanNode[] nodes) => (planId, nodes);

    /// <summary>One operator in a declared plan: what it reads, and what the optimizer expected.</summary>
    public sealed record PlanNode(
        ShowplanObjectV1 Reference,
        decimal? EstimatedRows = null,
        decimal? EstimatedRowSizeBytes = null,
        decimal? EstimatedCpu = null);

    /// <summary>
    /// One retained runtime bucket at an explicit interval, for tests about the recent traffic
    /// window. Separate from <see cref="AddFamily"/>'s <c>runtimeWaits</c>, which pins every bucket
    /// at the same instant and is what the wait-category tests already rely on -- the window tests
    /// need buckets that differ in <em>when</em>, which that shape cannot express.
    /// </summary>
    public sealed record RuntimeInterval(
        DateTimeOffset Start,
        DateTimeOffset End,
        string Executions = "1",
        string DurationMicroseconds = "1",
        string WaitMilliseconds = "0",
        string? PlanId = null,
        IReadOnlyDictionary<string, string>? WaitCategories = null);

    private static readonly DateTimeOffset Observed = new(2026, 8, 17, 17, 0, 0, TimeSpan.Zero);

    private static readonly QueryStoreEvidenceV1 Evidence = new(
        QueryStoreSource.QueryStore, DataStatus.Available, Observed, null, "Fake Query Store.", "None.");

    private readonly List<QueryFamilySummaryV1> _families = [];
    private readonly Dictionary<string, QueryFamilyDetailV1> _details = [];
    private readonly Dictionary<string, NormalizedShowplanV1> _plans = [];

    public string? TotalCount { get; init; }
    public bool ThrowOnQueries { get; init; }
    public bool ReturnNullPlans { get; init; }
    public HashSet<string> UnavailablePlanIds { get; } = new(StringComparer.Ordinal);
    public Func<string, CancellationToken, Task<NormalizedShowplanV1?>>? ReadPlanOverride { get; init; }
    public int PlansRequested { get; private set; }

    /// <summary>The database filter the last families read asked for.</summary>
    public string? RequestedDatabaseId { get; private set; }

    /// <summary>
    /// The family count the last families read asked for. This is how many query families the city
    /// page publishes, so it is the knob that decides whether a live execution can be matched to a
    /// family at all -- worth asserting on directly rather than inferring from the rows returned,
    /// because a fake with few families looks identical whatever count was requested.
    /// </summary>
    public int? RequestedPageSize { get; private set; }

    public void AddFamily(
        string familyId,
        string cpu,
        string executions,
        (string PlanId, PlanNode[] Nodes)[] plans,
        string waitMilliseconds = "0",
        IReadOnlyList<IReadOnlyDictionary<string, string>>? runtimeWaits = null,
        IReadOnlyList<RuntimeInterval>? runtimeIntervals = null)
    {
        var text = new QueryTextDescriptorV1(QueryTextAvailability.Available, "SELECT 1", "fp", "Captured.");
        var summary = new QueryFamilySummaryV1(
            familyId, DatabaseName, $"hash-{familyId}", "fp", text, [],
            executions, cpu, "2000", "300", waitMilliseconds, Observed, Observed, Evidence);
        _families.Add(summary);

        var planSummaries = plans
            .Select(plan => new QueryPlanSummaryV1(
                plan.PlanId, "1", $"planhash-{plan.PlanId}", QueryPlanType.Compiled,
                QueryOptimizationKind.None, null, true, false, null, "0", null, "16.0", "160",
                Observed, Evidence))
            .ToArray();

        var runtime = (runtimeWaits ?? [])
            .Select((waits, i) => new RuntimeBucketV1(
                plans[0].PlanId, $"interval-{i}", "epoch:1", Observed, Observed,
                QueryStoreExecutionType.Regular, "primary", "1", 1m, 1m, 1m, "1", "1", "1",
                new ReadOnlyDictionary<string, string>(waits.ToDictionary()), Evidence))
            .Concat((runtimeIntervals ?? []).Select((interval, i) => new RuntimeBucketV1(
                interval.PlanId ?? plans[0].PlanId, $"window-{i}", "epoch:1", interval.Start, interval.End,
                QueryStoreExecutionType.Regular, "primary", interval.Executions, 1m, 1m, 1m,
                interval.DurationMicroseconds, "1", "1",
                new ReadOnlyDictionary<string, string>(
                    (interval.WaitCategories ?? new Dictionary<string, string> { ["CPU"] = interval.WaitMilliseconds }).ToDictionary()),
                Evidence)))
            .ToArray();

        _details[familyId] = new QueryFamilyDetailV1("1.0", summary, planSummaries, runtime);

        foreach (var plan in plans)
        {
            var nodes = plan.Nodes
                .Select((node, i) => new ShowplanNodeV1(
                    i + 1, i == 0 ? null : 1, "Scan", "Index Scan",
                    node.EstimatedRows, node.EstimatedCpu, null, null, false, node.Reference, null, [],
                    node.EstimatedRowSizeBytes))
                .ToArray();
            _plans[plan.PlanId] = new NormalizedShowplanV1(
                "1.0", plan.PlanId, "1.539", null, null, null, nodes,
                QueryOptimizationKind.None, null, $"fingerprint-{plan.PlanId}", "None.", Evidence);
        }
    }

    public Task<PageV1<QueryFamilySummaryV1>> GetQueriesAsync(
        string? databaseId, string metric, int pageSize, string? pageToken, CancellationToken cancellationToken)
    {
        if (ThrowOnQueries)
        {
            throw new InvalidDataException("Query Store index is unreadable.");
        }

        RequestedDatabaseId = databaseId;
        RequestedPageSize = pageSize;
        Assert.Equal(DatabaseName, databaseId);
        Assert.Equal("cpu", metric);
        return Task.FromResult(new PageV1<QueryFamilySummaryV1>(
            "1.0", _families.Take(pageSize).ToArray(), null, pageSize, TotalCount) { Evidence = Evidence });
    }

    public Task<QueryFamilyDetailV1?> GetFamilyAsync(string familyId, CancellationToken cancellationToken) =>
        Task.FromResult(_details.GetValueOrDefault(familyId));

    public Task<NormalizedShowplanV1?> GetPlanAsync(string planId, CancellationToken cancellationToken)
    {
        PlansRequested++;
        if (ReadPlanOverride is not null) return ReadPlanOverride(planId, cancellationToken);
        return Task.FromResult(ReturnNullPlans || UnavailablePlanIds.Contains(planId) ? null : _plans.GetValueOrDefault(planId));
    }

    public Task<PlanComparisonV1?> ComparePlansAsync(
        string leftPlanId, string rightPlanId, CancellationToken cancellationToken) =>
        Task.FromResult<PlanComparisonV1?>(null);

    public Task<QueryStoreCollectorStatusV1> GetStatusAsync(CancellationToken cancellationToken) =>
        Task.FromResult(new QueryStoreCollectorStatusV1(
            "1.0", QueryStoreCollectorState.Ready, 1, Observed, Observed, null, [], "Ready."));
}
