using System.Globalization;
using Microsoft.Extensions.Time.Testing;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;
using SqlSimCity.Findings.Evidence;

namespace SqlSimCity.Findings.Tests;

/// <summary>
/// Pins the Query Store evidence cache inside <see cref="SourceBackedFindingsEvidenceProvider"/>.
///
/// Two things are held at once, and the second matters more than the first. One evaluation used to cost
/// a family read and a plan read per bounded candidate on every request -- measured at 351 ms against a
/// seeded instance, against 1.7 ms for the rules that consume the result -- so those reads are reused
/// while the published generation stands. But a finding presented as current while the evidence under it
/// has moved is worse than a slow one, so the reuse is confined to the Query Store half of the bundle,
/// keyed on the generation that produced it, and abandoned the moment that generation does.
/// </summary>
public sealed class SourceBackedProviderCachingTests
{
    [Fact]
    public async Task Reuses_query_store_evidence_while_the_published_generation_stands()
    {
        var queryStore = new GenerationalQueryStoreSource(familyCount: 4);
        var provider = Provider(queryStore);

        var first = await provider.GetBundleAsync(CancellationToken.None);
        var second = await provider.GetBundleAsync(CancellationToken.None);

        Assert.Equal(4, queryStore.FamilyDetailCalls);
        Assert.Equal(4, queryStore.PlanCalls);
        Assert.Equal(
            first.Families.Select(f => f.Family.FamilyId),
            second.Families.Select(f => f.Family.FamilyId));
        Assert.Equal(first.BundleReason, second.BundleReason);
    }

    [Fact]
    public async Task Re_reads_the_query_store_when_the_published_generation_advances()
    {
        var queryStore = new GenerationalQueryStoreSource(familyCount: 3);
        var provider = Provider(queryStore);

        var before = await provider.GetBundleAsync(CancellationToken.None);
        queryStore.Publish(familyPrefix: "after");
        var after = await provider.GetBundleAsync(CancellationToken.None);

        Assert.All(before.Families, f => Assert.StartsWith("before", f.Family.FamilyId, StringComparison.Ordinal));
        Assert.All(after.Families, f => Assert.StartsWith("after", f.Family.FamilyId, StringComparison.Ordinal));
        Assert.Equal(6, queryStore.FamilyDetailCalls);
    }

    [Fact]
    public async Task Advancing_only_the_collector_state_does_not_discard_the_cache()
    {
        // A connected cycle flips the published status to Collecting and back on every pass while the
        // families behind it stand still. Keying on the whole status would throw the cache away every
        // couple of minutes over evidence that never changed.
        var queryStore = new GenerationalQueryStoreSource(familyCount: 3);
        var provider = Provider(queryStore);

        await provider.GetBundleAsync(CancellationToken.None);
        queryStore.State = QueryStoreCollectorState.Collecting;
        var during = await provider.GetBundleAsync(CancellationToken.None);

        Assert.Equal(3, queryStore.FamilyDetailCalls);
        Assert.Equal(QueryStoreCollectorState.Collecting, during.QueryStoreStatus!.State);
    }

    [Fact]
    public async Task Never_serves_atlas_live_capability_or_clock_evidence_from_the_cache()
    {
        // The evidence-honesty case. Live incidents advance every few seconds; the atlas and
        // capabilities advance on their own schedules. None of them costs anything to read, and every
        // one of them would be silently stale if the whole bundle were cached on the Query Store
        // generation.
        var queryStore = new GenerationalQueryStoreSource(familyCount: 2);
        var atlas = new MutableAtlasSource();
        var capabilities = new MutableCapabilitiesSource();
        var clock = new FakeTimeProvider(FindingsTestData.Now);
        LiveIncidentSnapshotV1? live = null;
        var provider = new SourceBackedFindingsEvidenceProvider(
            atlas, queryStore, capabilities, () => live, clock,
            new FindingsEvidenceOptions { MaxFamilies = 8, MaxPlans = 8, Metrics = ["cpu"] });

        var first = await provider.GetBundleAsync(CancellationToken.None);

        atlas.SnapshotId = "snapshot-2";
        capabilities.GeneratedAt = FindingsTestData.Now.AddMinutes(5);
        live = LiveTestData.Snapshot();
        clock.SetUtcNow(FindingsTestData.Now.AddMinutes(5));

        var second = await provider.GetBundleAsync(CancellationToken.None);

        Assert.Equal(2, queryStore.FamilyDetailCalls);
        Assert.Null(first.Live);
        Assert.NotNull(second.Live);
        Assert.Equal("snap", first.Atlas!.SnapshotId);
        Assert.Equal("snapshot-2", second.Atlas!.SnapshotId);
        Assert.Equal(FindingsTestData.Now, first.Capabilities!.GeneratedAt);
        Assert.Equal(FindingsTestData.Now.AddMinutes(5), second.Capabilities!.GeneratedAt);
        Assert.Equal(FindingsTestData.Now, first.GeneratedAt);
        Assert.Equal(FindingsTestData.Now.AddMinutes(5), second.GeneratedAt);
    }

    [Fact]
    public async Task Does_not_retain_evidence_assembled_across_a_publish()
    {
        // Families and plans are read one at a time, so a publish part-way through leaves a bundle that
        // belongs to neither generation. Returning it is the behaviour this provider has always had;
        // keeping it -- under the generation it started at, or the one it ended at -- would hand a
        // straddled read out afterwards as though it described one published snapshot.
        var queryStore = new GenerationalQueryStoreSource(familyCount: 4) { PublishAfterFamilyRead = 2 };
        var provider = Provider(queryStore);

        await provider.GetBundleAsync(CancellationToken.None);
        Assert.Equal(4, queryStore.FamilyDetailCalls);

        // The generation is stable now, so a second evaluation has to do the reads again rather than
        // reuse the straddled one, and only that second result may be retained.
        await provider.GetBundleAsync(CancellationToken.None);
        Assert.Equal(8, queryStore.FamilyDetailCalls);

        await provider.GetBundleAsync(CancellationToken.None);
        Assert.Equal(8, queryStore.FamilyDetailCalls);
    }

    [Fact]
    public async Task Assembles_once_when_concurrent_requests_find_a_cold_cache()
    {
        const int Callers = 8;
        var queryStore = new GenerationalQueryStoreSource(familyCount: 5) { HoldFirstPage = true };
        var provider = Provider(queryStore);

        var callers = Enumerable.Range(0, Callers)
            .Select(_ => Task.Run(() => provider.GetBundleAsync(CancellationToken.None)))
            .ToArray();

        // Wait until every caller has read the status and is contending for the one assembly.
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (queryStore.StatusCalls < Callers && DateTime.UtcNow < deadline)
            await Task.Delay(10, CancellationToken.None);
        Assert.True(queryStore.StatusCalls >= Callers, $"only {queryStore.StatusCalls} callers arrived");

        queryStore.ReleaseFirstPage();
        var bundles = await Task.WhenAll(callers);

        Assert.Equal(1, queryStore.PageCalls);
        Assert.Equal(5, queryStore.FamilyDetailCalls);
        Assert.All(bundles, bundle => Assert.Equal(5, bundle.Families.Count));
    }

    private static SourceBackedFindingsEvidenceProvider Provider(IQueryStoreHistorySource queryStore) =>
        new(new MutableAtlasSource(), queryStore, new MutableCapabilitiesSource(), () => null,
            new FakeTimeProvider(FindingsTestData.Now),
            new FindingsEvidenceOptions { MaxFamilies = 16, MaxPlans = 16, Metrics = ["cpu"] });

    /// <summary>
    /// A Query Store whose published generation advances only when the test says so, counting every read
    /// the provider makes so a reused assembly is distinguishable from a repeated one.
    /// </summary>
    private sealed class GenerationalQueryStoreSource(int familyCount) : IQueryStoreHistorySource
    {
        private readonly TaskCompletionSource _firstPage = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private long _sequence = 1;
        private DateTimeOffset _publishedAt = FindingsTestData.Now;
        private string _prefix = "before";
        private int _familyDetailCalls;
        private int _planCalls;
        private int _pageCalls;
        private int _statusCalls;

        public bool HoldFirstPage { get; init; }

        /// <summary>Publishes a new generation once, after this many family reads.</summary>
        public int PublishAfterFamilyRead { get; init; } = -1;

        public QueryStoreCollectorState State { get; set; } = QueryStoreCollectorState.Ready;

        public int FamilyDetailCalls => Volatile.Read(ref _familyDetailCalls);
        public int PlanCalls => Volatile.Read(ref _planCalls);
        public int PageCalls => Volatile.Read(ref _pageCalls);
        public int StatusCalls => Volatile.Read(ref _statusCalls);

        public void Publish(string familyPrefix)
        {
            _prefix = familyPrefix;
            Interlocked.Increment(ref _sequence);
            _publishedAt = _publishedAt.AddMinutes(2);
        }

        public void ReleaseFirstPage() => _firstPage.TrySetResult();

        public async Task<PageV1<QueryFamilySummaryV1>> GetQueriesAsync(
            string? databaseId, string metric, int pageSize, string? pageToken, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _pageCalls);
            if (HoldFirstPage)
                await _firstPage.Task.ConfigureAwait(false);
            var prefix = _prefix;
            var items = Enumerable.Range(0, familyCount)
                .Select(i => Summary($"{prefix}-fam-{i.ToString(CultureInfo.InvariantCulture)}"))
                .ToArray();
            return new PageV1<QueryFamilySummaryV1>(
                "1.0", items, null, pageSize, familyCount.ToString(CultureInfo.InvariantCulture));
        }

        public Task<QueryFamilyDetailV1?> GetFamilyAsync(string familyId, CancellationToken cancellationToken)
        {
            var call = Interlocked.Increment(ref _familyDetailCalls);
            if (PublishAfterFamilyRead > 0 && call == PublishAfterFamilyRead)
                Publish(_prefix);
            return Task.FromResult<QueryFamilyDetailV1?>(
                FindingsTestData.Family(familyId, [FindingsTestData.Plan($"{familyId}:p1")], []));
        }

        public Task<NormalizedShowplanV1?> GetPlanAsync(string planId, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _planCalls);
            return Task.FromResult<NormalizedShowplanV1?>(FindingsTestData.Showplan(planId));
        }

        public Task<PlanComparisonV1?> ComparePlansAsync(
            string leftPlanId, string rightPlanId, CancellationToken cancellationToken) =>
            Task.FromResult<PlanComparisonV1?>(null);

        public Task<QueryStoreCollectorStatusV1> GetStatusAsync(CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _statusCalls);
            return Task.FromResult(new QueryStoreCollectorStatusV1(
                "1.0", State, Volatile.Read(ref _sequence), FindingsTestData.Now, _publishedAt, null, [],
                "Generational test source."));
        }

        private static QueryFamilySummaryV1 Summary(string id) =>
            new(id, "db1", "0x", "fp", FindingsTestData.Text(), [], "100", "100000", "100000", "200", "0",
                FindingsTestData.Now.AddHours(-1), FindingsTestData.Now, FindingsTestData.QsEvidence());
    }

    private sealed class MutableAtlasSource : IAtlasSnapshotSource
    {
        public string SnapshotId { get; set; } = "snap";

        public AtlasSnapshotV1 GetCurrent()
        {
            var atlas = FindingsTestData.Atlas(FindingsTestData.AtlasDb(
                "db1", "db1", QueryStoreCapability.Available, QueryStoreHealth.Healthy, DataStatus.Available));
            return atlas with { SnapshotId = SnapshotId };
        }
    }

    private sealed class MutableCapabilitiesSource : ICapabilitiesSource
    {
        public DateTimeOffset GeneratedAt { get; set; } = FindingsTestData.Now;

        public CapabilitiesSnapshotV1 GetCurrent() => new("1.0", GeneratedAt, []);
    }
}
