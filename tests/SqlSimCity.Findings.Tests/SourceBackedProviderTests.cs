using System.Globalization;
using System.Xml;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;
using SqlSimCity.Findings.Evidence;

namespace SqlSimCity.Findings.Tests;

public sealed class SourceBackedProviderTests
{
    [Fact]
    public async Task Bounds_family_loading_against_a_100k_family_target()
    {
        var qs = new HugeQueryStoreSource(totalFamilies: 100_000);
        var provider = new SourceBackedFindingsEvidenceProvider(
            new FakeAtlasSource(), qs, new FakeCapabilitiesSource(), () => null,
            new FixedTime(FindingsTestData.Now),
            new FindingsEvidenceOptions { MaxFamilies = 25, MaxPlans = 10, Metrics = ["cpu"] });

        var bundle = await provider.GetBundleAsync(CancellationToken.None);

        Assert.True(bundle.Families.Count <= 25);
        Assert.True(qs.FamilyDetailCalls <= 25, $"loaded {qs.FamilyDetailCalls} details");
        // It must never have enumerated the whole store.
        Assert.True(qs.MaxPageSizeRequested <= 50);
    }

    [Fact]
    public async Task Honors_cancellation()
    {
        var qs = new HugeQueryStoreSource(totalFamilies: 100_000);
        var provider = new SourceBackedFindingsEvidenceProvider(
            new FakeAtlasSource(), qs, new FakeCapabilitiesSource(), () => null,
            new FixedTime(FindingsTestData.Now));
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => provider.GetBundleAsync(cts.Token));
    }

    private sealed class HugeQueryStoreSource(int totalFamilies) : IQueryStoreHistorySource
    {
        public int FamilyDetailCalls { get; private set; }
        public int MaxPageSizeRequested { get; private set; }

        public Task<PageV1<QueryFamilySummaryV1>> GetQueriesAsync(string? databaseId, string metric, int pageSize, string? pageToken, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            MaxPageSizeRequested = Math.Max(MaxPageSizeRequested, pageSize);
            var offset = pageToken is null ? 0 : int.Parse(pageToken, CultureInfo.InvariantCulture);
            var items = Enumerable.Range(offset, Math.Min(pageSize, totalFamilies - offset))
                .Select(i => Summary($"fam-{i}"))
                .ToArray();
            var next = offset + items.Length < totalFamilies ? (offset + items.Length).ToString(CultureInfo.InvariantCulture) : null;
            return Task.FromResult(new PageV1<QueryFamilySummaryV1>("1.0", items, next, pageSize, totalFamilies.ToString(CultureInfo.InvariantCulture)));
        }

        public Task<QueryFamilyDetailV1?> GetFamilyAsync(string familyId, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            FamilyDetailCalls++;
            var detail = FindingsTestData.Family(familyId, [FindingsTestData.Plan("p1")], [FindingsTestData.Bucket("p1")]);
            return Task.FromResult<QueryFamilyDetailV1?>(detail);
        }

        public Task<NormalizedShowplanV1?> GetPlanAsync(string planId, CancellationToken cancellationToken) =>
            Task.FromResult<NormalizedShowplanV1?>(FindingsTestData.Showplan(planId));

        public Task<PlanComparisonV1?> ComparePlansAsync(string leftPlanId, string rightPlanId, CancellationToken cancellationToken) =>
            Task.FromResult<PlanComparisonV1?>(null);

        public Task<QueryStoreCollectorStatusV1> GetStatusAsync(CancellationToken cancellationToken) =>
            Task.FromResult(new QueryStoreCollectorStatusV1("1.0", QueryStoreCollectorState.Ready, 1, null, null, null, [], "Fake."));

        private static QueryFamilySummaryV1 Summary(string id) =>
            new(id, "db1", "0x", "fp", FindingsTestData.Text(), [], "100", "100000", "100000", "200", "0",
                FindingsTestData.Now.AddHours(-1), FindingsTestData.Now, FindingsTestData.QsEvidence());
    }

    [Fact]
    public async Task Discloses_a_showplan_it_cannot_normalize_instead_of_failing_the_evaluation()
    {
        // A single oversized or malformed Showplan used to escape as an unhandled 500 and take the
        // whole findings page with it, even though every other source in the bundle was fine.
        var qs = new RejectingPlanQueryStoreSource();
        var provider = new SourceBackedFindingsEvidenceProvider(
            new FakeAtlasSource(), qs, new FakeCapabilitiesSource(), () => null,
            new FixedTime(FindingsTestData.Now),
            new FindingsEvidenceOptions { MaxFamilies = 2, MaxPlans = 5, Metrics = ["cpu"] });

        var bundle = await provider.GetBundleAsync(CancellationToken.None);

        Assert.Empty(bundle.Plans);
        Assert.Contains("could not be normalized", bundle.BundleReason, StringComparison.Ordinal);
        Assert.Contains("20000-operator limit", bundle.BundleReason, StringComparison.Ordinal);
    }

    private sealed class RejectingPlanQueryStoreSource : IQueryStoreHistorySource
    {
        public Task<PageV1<QueryFamilySummaryV1>> GetQueriesAsync(string? databaseId, string metric, int pageSize, string? pageToken, CancellationToken cancellationToken) =>
            Task.FromResult(new PageV1<QueryFamilySummaryV1>(
                "1.0",
                [new QueryFamilySummaryV1("fam-1", "db1", "0x", "fp", FindingsTestData.Text(), [], "100", "100000", "100000", "200", "0",
                    FindingsTestData.Now.AddHours(-1), FindingsTestData.Now, FindingsTestData.QsEvidence())],
                null, pageSize, "1"));

        public Task<QueryFamilyDetailV1?> GetFamilyAsync(string familyId, CancellationToken cancellationToken) =>
            Task.FromResult<QueryFamilyDetailV1?>(
                FindingsTestData.Family(familyId, [FindingsTestData.Plan("p1")], [FindingsTestData.Bucket("p1")]));

        public Task<NormalizedShowplanV1?> GetPlanAsync(string planId, CancellationToken cancellationToken) =>
            throw new XmlException("Showplan exceeds the 20000-operator limit.");

        public Task<PlanComparisonV1?> ComparePlansAsync(string leftPlanId, string rightPlanId, CancellationToken cancellationToken) =>
            Task.FromResult<PlanComparisonV1?>(null);

        public Task<QueryStoreCollectorStatusV1> GetStatusAsync(CancellationToken cancellationToken) =>
            Task.FromResult(new QueryStoreCollectorStatusV1("1.0", QueryStoreCollectorState.Ready, 1, null, null, null, [], "Fake."));
    }

    [Fact]
    public async Task Discloses_a_showplan_the_source_could_not_read_instead_of_dropping_it()
    {
        // The asymmetry issue #95 names. A Showplan that raises is disclosed; one the source simply
        // could not read used to come back as the same empty value as "there is no such plan", so it
        // left no trace at all and the evaluation read as though every plan had been examined.
        var qs = new PartialReadQueryStoreSource
        {
            PlanRead = QueryStoreRead.Unavailable<NormalizedShowplanV1>(
                DataStatus.Disconnected, "The Query Store probe could not reach the target."),
        };

        var bundle = await Provider(qs).GetBundleAsync(CancellationToken.None);

        Assert.Empty(bundle.Plans);
        Assert.Contains(
            "1 Showplan(s) could not be read from the Query Store source",
            bundle.BundleReason,
            StringComparison.Ordinal);
        Assert.Contains(
            "p1: The Query Store probe could not reach the target.",
            bundle.BundleReason,
            StringComparison.Ordinal);
    }

    [Fact]
    public async Task Says_nothing_about_a_showplan_that_is_genuinely_absent()
    {
        // The other half of the distinction, and the reason it cannot be fixed by disclosing every
        // empty read. A plan the target really does not hold is not missing evidence, and reporting
        // it as such would make the disclosure meaningless.
        var qs = new PartialReadQueryStoreSource
        {
            PlanRead = QueryStoreRead.Absent<NormalizedShowplanV1>(
                "Query Store no longer holds a Showplan under this plan id."),
        };

        var bundle = await Provider(qs).GetBundleAsync(CancellationToken.None);

        Assert.Empty(bundle.Plans);
        Assert.DoesNotContain("could not be read", bundle.BundleReason, StringComparison.Ordinal);
        Assert.DoesNotContain("no longer holds", bundle.BundleReason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Discloses_a_family_the_source_could_not_read_instead_of_dropping_it()
    {
        // Same conflation one level up: a family selected by the ranking pass and then not read is a
        // hole in a bounded evaluation that advertises exactly which families it covered.
        var qs = new PartialReadQueryStoreSource
        {
            FamilyRead = QueryStoreRead.Unavailable<QueryFamilyDetailV1>(
                DataStatus.PermissionDenied, "The configured principal cannot read this family."),
        };

        var bundle = await Provider(qs).GetBundleAsync(CancellationToken.None);

        Assert.Empty(bundle.Families);
        Assert.Contains(
            "1 query family read(s) failed against the Query Store source",
            bundle.BundleReason,
            StringComparison.Ordinal);
        Assert.Contains(
            "fam-1: The configured principal cannot read this family.",
            bundle.BundleReason,
            StringComparison.Ordinal);
    }

    private static SourceBackedFindingsEvidenceProvider Provider(IQueryStoreHistorySource queryStore) =>
        new(new FakeAtlasSource(), queryStore, new FakeCapabilitiesSource(), () => null,
            new FixedTime(FindingsTestData.Now),
            new FindingsEvidenceOptions { MaxFamilies = 2, MaxPlans = 5, Metrics = ["cpu"] });

    /// <summary>
    /// One family (<c>fam-1</c>) holding one plan (<c>p1</c>), where the family read and the plan
    /// read are whatever the test sets them to. The nullable methods stay consistent with those
    /// reads -- they return the value, which is null for either empty outcome -- so a consumer that
    /// still goes through them sees exactly what it saw before this distinction existed.
    /// </summary>
    private sealed class PartialReadQueryStoreSource : IQueryStoreHistorySource
    {
        public QueryStoreReadV1<QueryFamilyDetailV1> FamilyRead { get; init; } =
            QueryStoreRead.Available(
                FindingsTestData.Family("fam-1", [FindingsTestData.Plan("p1")], [FindingsTestData.Bucket("p1")]));

        public QueryStoreReadV1<NormalizedShowplanV1> PlanRead { get; init; } =
            QueryStoreRead.Available(FindingsTestData.Showplan("p1"));

        public Task<PageV1<QueryFamilySummaryV1>> GetQueriesAsync(string? databaseId, string metric, int pageSize, string? pageToken, CancellationToken cancellationToken) =>
            Task.FromResult(new PageV1<QueryFamilySummaryV1>(
                "1.0",
                [new QueryFamilySummaryV1("fam-1", "db1", "0x", "fp", FindingsTestData.Text(), [], "100", "100000", "100000", "200", "0",
                    FindingsTestData.Now.AddHours(-1), FindingsTestData.Now, FindingsTestData.QsEvidence())],
                null, pageSize, "1"));

        public Task<QueryStoreReadV1<QueryFamilyDetailV1>> ReadFamilyAsync(string familyId, CancellationToken cancellationToken) =>
            Task.FromResult(FamilyRead);

        public Task<QueryStoreReadV1<NormalizedShowplanV1>> ReadPlanAsync(string planId, CancellationToken cancellationToken) =>
            Task.FromResult(PlanRead);

        public Task<QueryFamilyDetailV1?> GetFamilyAsync(string familyId, CancellationToken cancellationToken) =>
            Task.FromResult(FamilyRead.Value);

        public Task<NormalizedShowplanV1?> GetPlanAsync(string planId, CancellationToken cancellationToken) =>
            Task.FromResult(PlanRead.Value);

        public Task<PlanComparisonV1?> ComparePlansAsync(string leftPlanId, string rightPlanId, CancellationToken cancellationToken) =>
            Task.FromResult<PlanComparisonV1?>(null);

        public Task<QueryStoreCollectorStatusV1> GetStatusAsync(CancellationToken cancellationToken) =>
            Task.FromResult(new QueryStoreCollectorStatusV1("1.0", QueryStoreCollectorState.Ready, 1, null, null, null, [], "Fake."));
    }

    private sealed class FakeAtlasSource : IAtlasSnapshotSource
    {
        public AtlasSnapshotV1 GetCurrent() => FindingsTestData.Atlas(
            FindingsTestData.AtlasDb("db1", "db1", QueryStoreCapability.Available, QueryStoreHealth.Healthy, DataStatus.Available));
    }

    private sealed class FakeCapabilitiesSource : ICapabilitiesSource
    {
        public CapabilitiesSnapshotV1 GetCurrent() => new("1.0", FindingsTestData.Now, []);
    }

    private sealed class FixedTime(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
