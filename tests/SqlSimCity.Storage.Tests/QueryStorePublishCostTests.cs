using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Storage.Sqlite;

namespace SqlSimCity.Storage.Tests;

/// <summary>
/// The two things issue #82 asserts about persistence, measured against the real store rather
/// than argued: a publish rewrites the whole generation regardless of how little changed, and the
/// on-demand plan cache has no bound but the one added here.
/// </summary>
public sealed class QueryStorePublishCostTests : IDisposable
{
    private readonly string _directory =
        Path.Combine(Path.GetTempPath(), "sqlsimcity-publish-cost", Guid.NewGuid().ToString("N"));

    private static readonly DateTimeOffset Now = new(2026, 8, 20, 9, 0, 0, TimeSpan.Zero);

    public void Dispose()
    {
        if (!Directory.Exists(_directory)) return;
        try
        {
            Directory.Delete(_directory, recursive: true);
        }
        catch (IOException)
        {
            // A lingering SQLite handle can transiently hold the file open on Windows.
        }
    }

    private SqliteProtectedRecordStore NewStore(int maxPayloadBytes = 1_048_576) =>
        new(_directory, "history.db", new RetentionOptions(), TimeProvider.System,
            maxPayloadBytes: maxPayloadBytes);

    [Fact]
    public async Task PublishCostCountsEveryFamilyAndEveryRecordTheStoreEndsUpHolding()
    {
        using var store = NewStore();
        await store.EnsureReadyAsync();
        var repository = new ProtectedQueryStoreRepository(store);

        var cost = await repository.PublishSnapshotAsync(Snapshot(1, Families(120, "gen-1")));
        var usage = await store.MeasureUsageAsync();

        Assert.Equal(120, cost.FamilyCount);
        Assert.True(cost.StoredBytes > 0);
        Assert.Equal(cost.StoredBytes / 120, cost.BytesPerFamily);
        // The pointer is written outside the slot replacement, so the store holds exactly the
        // replacement's records plus that one. Anchoring the reported count to what storage really
        // contains is what stops it drifting into a count of something else.
        Assert.Equal(cost.RecordsWritten + 1, usage.RecordCount);
        Assert.True(
            cost.WriteLockHold > TimeSpan.Zero && cost.WriteLockHold <= cost.Elapsed,
            $"hold {cost.WriteLockHold} must be a real section inside {cost.Elapsed}");
    }

    [Fact]
    public async Task RepublishingAnIdenticalSnapshotStillRewritesEveryByteOfIt()
    {
        using var store = NewStore();
        await store.EnsureReadyAsync();
        var repository = new ProtectedQueryStoreRepository(store);
        var families = Families(120, "gen");

        var first = await repository.PublishSnapshotAsync(Snapshot(1, families));
        var second = await repository.PublishSnapshotAsync(Snapshot(2, families));
        var third = await repository.PublishSnapshotAsync(Snapshot(3, families));

        // This is the claim in issue #82, as a measurement rather than an argument: cost is
        // O(all retained families) per publish and not O(changed families), so identical content
        // costs the same every time. If a later change makes persistence incremental, this fails
        // and forces that to be a decision rather than a silent regression in the reported figure.
        Assert.Equal(first.StoredBytes, second.StoredBytes);
        Assert.Equal(first.RecordsWritten, second.RecordsWritten);
        // The first publish found an empty slot; the third is reusing slot 0, which the first
        // filled, so it has a whole prior generation to delete before it writes.
        Assert.Equal(0, first.RecordsDeleted);
        Assert.Equal(first.RecordsWritten, third.RecordsDeleted);
        Assert.Equal(first.StoredBytes, third.Replacement.DeletedBytes);
    }

    [Fact]
    public async Task BothGenerationsStayOnDiskSoRetainedSnapshotBytesAreTwiceOnePublish()
    {
        using var store = NewStore();
        await store.EnsureReadyAsync();
        var repository = new ProtectedQueryStoreRepository(store);
        var families = Families(120, "gen");

        var first = await repository.PublishSnapshotAsync(Snapshot(1, families));
        await repository.PublishSnapshotAsync(Snapshot(2, families));
        var usage = await store.MeasureUsageAsync();

        // Only the inactive slot is rewritten per cycle, so the previous generation is still
        // there. Residency is therefore about twice the per-publish figure, which is the part an
        // operator sizing a volume needs and the per-publish number alone does not say.
        var familyBytes = usage.StoredBytesForKinds(["query-store-family-detail"]);
        var singleGeneration = first.StoredBytes;
        Assert.True(
            familyBytes > singleGeneration * 1.5,
            $"family bytes {familyBytes} should hold two generations of about {singleGeneration}");
        Assert.Equal(240, usage.RecordCountForKinds(["query-store-family-detail"]));
    }

    [Fact]
    public async Task ThePlanCacheKindsAreExactlyWhatOnDemandHydrationWrites()
    {
        using var store = NewStore();
        await store.EnsureReadyAsync();
        var repository = new ProtectedQueryStoreRepository(store);
        await repository.PublishSnapshotAsync(Snapshot(1, Families(20, "gen")));
        var snapshotOnly = (await store.MeasureUsageAsync()).StoredBytes;

        await repository.StoreQueryTextAsync("db", "text-1", Now, new string('t', 4_000));
        await repository.StorePlanXmlAsync("db", "plan-1", Now, new string('p', 40_000));
        await repository.StoreNormalizedPlanAsync(Plan("plan-1"), Now);
        var usage = await store.MeasureUsageAsync();

        var cacheBytes = usage.StoredBytesForKinds(ProtectedQueryStoreRepository.PlanCacheRecordKinds);
        var descriptorBytes = usage.StoredBytesForKinds(["query-store-text-descriptor"]);
        Assert.Equal(0, descriptorBytes);
        // Everything the store gained since the snapshot came from hydration, so the named kinds
        // have to account for all of it. Rename a kind constant without updating the set and this
        // fails -- which is the drift that would otherwise silently report a plan cache of zero,
        // exactly what the metric exists to prevent.
        Assert.Equal(usage.StoredBytes - snapshotOnly, cacheBytes);
        Assert.True(cacheBytes > 40_000, $"cache bytes {cacheBytes} is smaller than the plan XML written");
    }

    [Fact]
    public async Task TheQuotaEvictsOldestFirstAndStopsAsSoonAsItIsUnderTheLimit()
    {
        using var store = NewStore();
        await store.EnsureReadyAsync();
        var repository = new ProtectedQueryStoreRepository(store);
        for (var index = 0; index < 10; index++)
            await repository.StorePlanXmlAsync(
                "db", $"plan-{index:D2}", Now.AddMinutes(index), new string('p', 10_000));
        var before = await store.MeasureUsageAsync();
        var perPlan = before.StoredBytesForKinds(ProtectedQueryStoreRepository.PlanCacheRecordKinds) / 10;

        var eviction = await repository.EnforcePlanCacheQuotaAsync(before, perPlan * 6);
        var after = await store.MeasureUsageAsync();

        Assert.Equal(4, eviction.EvictedEntries);
        Assert.Equal(
            after.StoredBytesForKinds(ProtectedQueryStoreRepository.PlanCacheRecordKinds),
            eviction.RetainedBytesAfter);
        Assert.True(eviction.RetainedBytesAfter <= perPlan * 6);
        // Oldest first: the four earliest captured plans are gone and the six newest survive.
        for (var index = 0; index < 4; index++)
            Assert.Null(await repository.ReadSensitiveTextAsync("showplan", "db", $"plan-{index:D2}"));
        for (var index = 4; index < 10; index++)
            Assert.NotNull(await repository.ReadSensitiveTextAsync("showplan", "db", $"plan-{index:D2}"));
    }

    [Fact]
    public async Task TheQuotaNeverReachesTheSnapshotEvenWhenTheCacheAloneCannotSatisfyIt()
    {
        using var store = NewStore();
        await store.EnsureReadyAsync();
        var repository = new ProtectedQueryStoreRepository(store);
        await repository.PublishSnapshotAsync(Snapshot(1, Families(40, "gen")));
        await repository.StorePlanXmlAsync("db", "plan-1", Now, new string('p', 10_000));

        // A quota of one byte cannot be met by evicting the cache alone; the snapshot must still
        // survive it, because a snapshot is the system of record and a plan is a cache entry.
        var eviction = await repository.EnforcePlanCacheQuotaAsync(await store.MeasureUsageAsync(), 1);

        Assert.True(eviction.EvictedEntries > 0);
        Assert.Null(await repository.ReadSensitiveTextAsync("showplan", "db", "plan-1"));
        var snapshot = await repository.ReadPublishedSnapshotAsync();
        Assert.NotNull(snapshot);
        Assert.Equal(40, snapshot!.Families.Count);
    }

    [Fact]
    public async Task AChunkedNormalizedPlanIsEvictedWholeSoTheCacheMissesRatherThanTearing()
    {
        // Small enough that the normalized plan does not fit one record and is stored as a
        // manifest plus chunks -- the shape where evicting a record without its siblings turns a
        // miss into an InvalidDataException on the next read.
        using var store = NewStore(maxPayloadBytes: 4_096);
        await store.EnsureReadyAsync();
        var repository = new ProtectedQueryStoreRepository(store);
        await repository.StoreNormalizedPlanAsync(Plan("chunked", nodeCount: 400), Now);
        var usage = await store.MeasureUsageAsync();
        Assert.True(
            usage.RecordCountForKinds(["query-store-normalized-plan-chunk"]) > 1,
            "the fixture must actually chunk, or this proves nothing");

        var eviction = await repository.EnforcePlanCacheQuotaAsync(usage, 1);

        Assert.Equal(1, eviction.EvictedEntries);
        Assert.Equal(
            usage.RecordCountForKinds(ProtectedQueryStoreRepository.PlanCacheRecordKinds),
            eviction.EvictedRecords);
        Assert.Equal(0, (await store.MeasureUsageAsync())
            .RecordCountForKinds(ProtectedQueryStoreRepository.PlanCacheRecordKinds));
        // A cache miss re-hydrates. A torn entry throws, and the plan endpoint would 500 for as
        // long as the manifest survived.
        Assert.Null(await repository.ReadNormalizedPlanAsync("chunked"));
    }

    [Fact]
    public async Task AZeroQuotaMeansUnboundedRatherThanEvictEverything()
    {
        using var store = NewStore();
        await store.EnsureReadyAsync();
        var repository = new ProtectedQueryStoreRepository(store);
        await repository.StorePlanXmlAsync("db", "plan-1", Now, new string('p', 10_000));

        var eviction = await repository.EnforcePlanCacheQuotaAsync(await store.MeasureUsageAsync(), 0);

        Assert.Equal(0, eviction.EvictedEntries);
        Assert.NotNull(await repository.ReadSensitiveTextAsync("showplan", "db", "plan-1"));
    }

    private static QueryStorePublishedSnapshot Snapshot(
        long sequence, IReadOnlyList<QueryFamilyDetailV1> families) =>
        new("1.0", $"snapshot-{sequence}", sequence, Now.AddMinutes(sequence), families,
            new QueryStoreCollectorStatusV1(
                "1.0", QueryStoreCollectorState.Ready, sequence,
                Now, Now.AddMinutes(sequence), null, [], "ready"));

    private static QueryFamilyDetailV1[] Families(int count, string prefix)
    {
        var evidence = new QueryStoreEvidenceV1(
            QueryStoreSource.QueryStore, DataStatus.Available, Now, null, prefix, "aggregate");
        var text = new QueryTextDescriptorV1(QueryTextAvailability.Missing, null, null, "missing");
        return Enumerable.Range(0, count).Select(index =>
        {
            var id = $"{prefix}-family-{index:D6}";
            return new QueryFamilyDetailV1(
                "1.0",
                new QueryFamilySummaryV1(
                    id, "db", id, null, text, [], "1", "1", "1", "1", "0", Now, Now, evidence),
                [], []);
        }).ToArray();
    }

    private static NormalizedShowplanV1 Plan(string planId, int nodeCount = 1)
    {
        var evidence = new QueryStoreEvidenceV1(
            QueryStoreSource.QueryStore, DataStatus.Available, Now, null, "seeded", "aggregate");
        var nodes = Enumerable.Range(0, nodeCount).Select(index => new ShowplanNodeV1(
            index,
            index == 0 ? null : 0,
            "Index Scan",
            $"Clustered Index Scan over dbo.Table{index:D4}, named long enough to have real size",
            1_000m + index,
            1.5m,
            0.5m,
            2m,
            false,
            null,
            null,
            [])).ToArray();
        return new NormalizedShowplanV1(
            "1.0", planId, "1.539", null, null, null, nodes,
            QueryOptimizationKind.None, null, "fingerprint", "caveat", evidence);
    }
}
