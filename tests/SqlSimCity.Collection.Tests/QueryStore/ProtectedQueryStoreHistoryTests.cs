using System.Numerics;
using System.Globalization;
using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;
using SqlSimCity.Storage;

namespace SqlSimCity.Collection.Tests.QueryStore;

public sealed class ProtectedQueryStoreHistoryTests
{
    private static readonly DateTimeOffset Now = new(2026, 8, 17, 18, 0, 0, TimeSpan.Zero);
    private static readonly string[] SensitiveRecordKinds =
        ["query-store-query-text", "query-store-showplan"];

    [Fact]
    public async Task SnapshotPointerPublishesAtomically()
    {
        var store = new MemoryProtectedStore();
        var repository = new ProtectedQueryStoreRepository(store);
        var first = Snapshot("first", 1);
        await repository.PublishSnapshotAsync(first);
        store.ThrowRecordKind = "query-store-snapshot-pointer";

        await Assert.ThrowsAsync<IOException>(() =>
            repository.PublishSnapshotAsync(Snapshot("partial", 2)));
        store.ThrowRecordKind = null;

        var current = await repository.ReadPublishedSnapshotAsync();
        Assert.Equal("first", current?.SnapshotId);
        Assert.Contains(store.Records.Values, record => record.RecordKind == "query-store-published-snapshot");
    }

    [Fact]
    public async Task ActiveRuntimeIsReplacedAndVariantRollsIntoParentAcrossRestart()
    {
        var store = new MemoryProtectedStore();
        var repository = new ProtectedQueryStoreRepository(store);
        var tracker = new QueryStoreCollectionStatusTracker();
        const string epoch = "query-store:db:generation:1";
        await PublishCycleAsync(new ProtectedQueryStoreHistorySink(repository, tracker), 40, epoch);

        var restarted = new ProtectedQueryStoreHistorySink(repository, tracker);
        await PublishCycleAsync(restarted, 47, epoch);

        var snapshot = await repository.ReadPublishedSnapshotAsync();
        var family = Assert.Single(snapshot!.Families);
        Assert.Equal("47", family.Family.ExecutionCount);
        Assert.Equal(2, family.Family.PhysicalQueries.Count);
        Assert.Equal(2, family.Plans.Count);
        Assert.False(family.Plans.Single(plan => plan.PlanType == QueryPlanType.Dispatcher).RuntimeCounted);
        Assert.Single(family.Runtime);
        Assert.Equal("db:variant-plan", family.Runtime[0].PlanId);
        Assert.Equal(epoch, family.Runtime[0].EpochId);
        Assert.Equal("active", family.Runtime[0].IntervalId);
    }

    [Fact]
    public async Task RawPayloadsUseOnlySensitiveProtectedRecordKinds()
    {
        var store = new MemoryProtectedStore();
        var repository = new ProtectedQueryStoreRepository(store);
        await repository.StoreQueryTextAsync("db", "text", Now, "private marker");
        await repository.StorePlanXmlAsync("db", "plan", Now, "<PrivatePlan marker='secret'/>");

        Assert.All(store.Records.Values, record =>
            Assert.Contains(record.RecordKind, SensitiveRecordKinds));
        Assert.Equal("private marker", await repository.ReadSensitiveTextAsync("query-text", "db", "text"));
        Assert.Equal("<PrivatePlan marker='secret'/>", await repository.ReadSensitiveTextAsync("showplan", "db", "plan"));
    }

    [Fact]
    public async Task LargeSnapshotsUseBoundedEncryptedFamilyRecordsAndIndexes()
    {
        var store = new MemoryProtectedStore();
        var repository = new ProtectedQueryStoreRepository(store);
        var evidence = new QueryStoreEvidenceV1(
            QueryStoreSource.QueryStore, DataStatus.Available, Now, Now.AddMinutes(3), "ready", "aggregate");
        var largeText = new string('x', 300_000);
        var families = Enumerable.Range(0, 4).Select(index =>
        {
            var text = new QueryTextDescriptorV1(QueryTextAvailability.Available, largeText, $"fp-{index}", "safe");
            var physical = new PhysicalQueryIdentityV1(
                "db", $"q-{index}", $"t-{index}", $"h-{index}",
                new QueryContextSettingsV1("c", null, null, null, "160", null), text);
            var summary = new QueryFamilySummaryV1(
                $"f-{index}", "db", $"h-{index}", $"fp-{index}", text, [physical],
                "1", "1", "1", "1", "0", Now, Now, evidence);
            return new QueryFamilyDetailV1("1.0", summary, [], []);
        }).ToArray();

        await repository.PublishSnapshotAsync(Snapshot("chunked", 1) with { Families = families });
        var restored = await repository.ReadPublishedSnapshotAsync();

        Assert.Equal(4, restored!.Families.Count);
        Assert.Equal(4, store.Records.Values.Count(record =>
            record.RecordKind == "query-store-family-detail"));
        Assert.Contains(store.Records.Values, record =>
            record.RecordKind == "query-store-family-index-page");
        Assert.All(store.Records.Values, record => Assert.True(record.Payload.Length < 1_048_576));
    }

    [Fact]
    public async Task ResetEpochArchivesOldIdsWithoutMixingTheirRuntime()
    {
        var store = new MemoryProtectedStore();
        var repository = new ProtectedQueryStoreRepository(store);
        var sink = new ProtectedQueryStoreHistorySink(repository, new QueryStoreCollectionStatusTracker());
        await PublishCycleAsync(sink, 40, "epoch-1");
        await PublishCycleAsync(sink, 5, "epoch-2", reset: true);

        var snapshot = await repository.ReadPublishedSnapshotAsync();
        Assert.Equal(2, snapshot!.Families.Count);
        var archived = snapshot.Families.Single(detail =>
            detail.Family.FamilyId.Contains(":epoch:", StringComparison.Ordinal));
        var current = snapshot.Families.Single(detail =>
            !detail.Family.FamilyId.Contains(":epoch:", StringComparison.Ordinal));
        Assert.Equal("40", archived.Family.ExecutionCount);
        Assert.Equal(DataStatus.Stale, archived.Family.Evidence.Status);
        Assert.Equal("5", current.Family.ExecutionCount);
    }

    [Fact]
    public async Task ArchivedEpochIsRemovedAtRetentionBoundary()
    {
        var store = new MemoryProtectedStore();
        var repository = new ProtectedQueryStoreRepository(store);
        var sink = new ProtectedQueryStoreHistorySink(repository, new QueryStoreCollectionStatusTracker());
        await PublishCycleAsync(sink, 40, "epoch-1", observedAt: Now);
        await PublishCycleAsync(sink, 5, "epoch-2", reset: true, observedAt: Now.AddDays(1));
        await PublishCycleAsync(sink, 7, "epoch-2", observedAt: Now.AddDays(91));

        var snapshot = await repository.ReadPublishedSnapshotAsync();
        Assert.DoesNotContain(snapshot!.Families, detail =>
            detail.Family.FamilyId.Contains(":epoch:", StringComparison.Ordinal));
    }

    [Fact]
    public async Task RepeatedResetsDoNotRetainExpiredArchivedEpochs()
    {
        var repository = new ProtectedQueryStoreRepository(new MemoryProtectedStore());
        var sink = new ProtectedQueryStoreHistorySink(repository, new QueryStoreCollectionStatusTracker());
        await PublishCycleAsync(sink, 40, "epoch-1", observedAt: Now);
        await PublishCycleAsync(sink, 5, "epoch-2", reset: true, observedAt: Now.AddDays(1));
        await PublishCycleAsync(sink, 7, "epoch-3", reset: true, observedAt: Now.AddDays(2));
        await PublishCycleAsync(sink, 9, "epoch-3", observedAt: Now.AddDays(93));

        var snapshot = await repository.ReadPublishedSnapshotAsync();

        Assert.DoesNotContain(snapshot!.Families, detail =>
            detail.Family.FamilyId.Contains(":epoch:", StringComparison.Ordinal));
        Assert.Equal("9", Assert.Single(snapshot.Families).Family.ExecutionCount);
    }

    [Fact]
    public async Task AuthoritativeDatabaseSetRemovesOnlyAbsentDatabasesAcrossRestart()
    {
        var repository = new ProtectedQueryStoreRepository(new MemoryProtectedStore());
        var sink = new ProtectedQueryStoreHistorySink(repository, new QueryStoreCollectionStatusTracker());
        await PublishCycleAsync(sink, 4, "epoch-a", databaseId: "db-a");
        await PublishCycleAsync(sink, 8, "epoch-b", databaseId: "db-b");

        await sink.PublishAsync(new QueryStoreCollectionResult(
            false, Now.AddMinutes(-1), Now,
            [
                DatabaseResult("db-a"),
                DatabaseResult("db-b", "synthetic failure"),
            ],
            ["db-a", "db-b"]), default);

        var failedCycle = await repository.ReadPublishedSnapshotAsync();
        Assert.Equal(["db-a", "db-b"], failedCycle!.Families
            .Select(family => family.Family.DatabaseId).Order(StringComparer.Ordinal));

        await sink.PublishAsync(new QueryStoreCollectionResult(
            false, Now, Now.AddMinutes(1),
            [DatabaseResult("db-a")],
            ["db-a"]), default);

        var removed = await repository.ReadPublishedSnapshotAsync();
        Assert.All(removed!.Families, family => Assert.Equal("db-a", family.Family.DatabaseId));
        Assert.Null(await repository.ReadWatermarkAsync("db-b"));

        var restarted = new ProtectedQueryStoreHistorySink(
            repository, new QueryStoreCollectionStatusTracker());
        await restarted.PublishAsync(new QueryStoreCollectionResult(
            false, Now.AddMinutes(1), Now.AddMinutes(2),
            [DatabaseResult("db-a")],
            ["db-a"]), default);

        var afterRestart = await repository.ReadPublishedSnapshotAsync();
        Assert.All(afterRestart!.Families, family => Assert.Equal("db-a", family.Family.DatabaseId));
    }

    [Fact]
    public async Task OversizedFamilyDetailIsChunkedAndRoundTrips()
    {
        var store = new MemoryProtectedStore { MaxPayloadBytes = 32 * 1024 };
        var repository = new ProtectedQueryStoreRepository(store);
        var evidence = new QueryStoreEvidenceV1(
            QueryStoreSource.QueryStore, DataStatus.Available, Now, null, "large", "aggregate");
        var text = new QueryTextDescriptorV1(QueryTextAvailability.Missing, null, null, "missing");
        var summary = new QueryFamilySummaryV1(
            "large-family", "db", "hash", null, text, [], "2160", "1", "1", "1", "1",
            Now.AddDays(-90), Now, evidence);
        var plans = Enumerable.Range(0, 800).Select(index => new QueryPlanSummaryV1(
            $"db:plan-{index}", $"query-{index}", $"hash-{index}", QueryPlanType.Compiled,
            QueryOptimizationKind.None, null, true, false, null, "0", null, "16", "160",
            Now, evidence)).ToArray();
        var runtime = Enumerable.Range(0, 90 * 24).Select(index => new RuntimeBucketV1(
            $"db:plan-{index % plans.Length}", $"interval-{index}", "epoch",
            Now.AddHours(-index - 1), Now.AddHours(-index), QueryStoreExecutionType.Regular,
            "primary", "1", 1, 1, 1, "1", "1", "1",
            new Dictionary<string, string> { ["CPU"] = "1" }, evidence)).ToArray();
        var detail = new QueryFamilyDetailV1("1.0", summary, plans, runtime);

        await repository.PublishSnapshotAsync(
            Snapshot("large-detail", 1) with { Families = [detail] });
        var restored = await repository.ReadPublishedSnapshotAsync();

        var family = Assert.Single(restored!.Families);
        Assert.Equal(plans.Length, family.Plans.Count);
        Assert.Equal(runtime.Length, family.Runtime.Count);
        Assert.Contains(store.Records.Values, record =>
            record.RecordKind == "query-store-family-detail-chunk");
        Assert.All(store.Records.Values, record =>
            Assert.InRange(record.Payload.Length, 1, store.MaxPayloadBytes));
    }

    [Fact]
    public async Task OversizedRawPlanStillCachesNormalizedPlan()
    {
        var store = new MemoryProtectedStore { MaxPayloadBytes = 16 * 1024 };
        var repository = new ProtectedQueryStoreRepository(store);
        var source = new LargePlanSource();
        var history = new ConnectedQueryStoreHistorySource(
            repository, source, new SecureShowplanParser(),
            new QueryStoreCollectionStatusTracker(), TimeProvider.System);

        var plan = await history.GetPlanAsync("db:42", default);

        Assert.NotNull(plan);
        Assert.NotNull(await repository.ReadNormalizedPlanAsync("db:42"));
        Assert.Null(await repository.ReadSensitiveTextAsync("showplan", "db", "42"));
        Assert.DoesNotContain(
            "RAW_PRIVATE_MARKER",
            System.Text.Json.JsonSerializer.Serialize(plan),
            StringComparison.Ordinal);
    }

    [Fact]
    public async Task OversizedNormalizedPlanIsChunkedAndRoundTrips()
    {
        var store = new MemoryProtectedStore { MaxPayloadBytes = 16 * 1024 };
        var repository = new ProtectedQueryStoreRepository(store);
        var evidence = new QueryStoreEvidenceV1(
            QueryStoreSource.QueryStore, DataStatus.Available, Now, null, "plan", "compiled");
        var nodes = Enumerable.Range(0, 1_000).Select(index => new ShowplanNodeV1(
            index, index == 0 ? null : index - 1, "Scan", "Index Scan",
            1, 1, 1, 1, false, null, new string('x', 200), [])).ToArray();
        var plan = new NormalizedShowplanV1(
            "1.0", "db:large-plan", "1.6", null, null, null, nodes,
            QueryOptimizationKind.None, null, "fingerprint",
            "Compiled estimates only.", evidence);

        await repository.StoreNormalizedPlanAsync(plan, Now);
        var restored = await repository.ReadNormalizedPlanAsync(plan.PlanId);

        Assert.Equal(nodes.Length, restored?.Nodes.Count);
        Assert.Contains(store.Records.Values, record =>
            record.RecordKind == "query-store-normalized-plan-chunk");
        Assert.All(store.Records.Values, record =>
            Assert.InRange(record.Payload.Length, 1, store.MaxPayloadBytes));
    }

    [Fact]
    public async Task FamilyBuildIndexesEachFactSetOnce()
    {
        const int familyCount = 500;
        var repository = new ProtectedQueryStoreRepository(new MemoryProtectedStore());
        var sink = new ProtectedQueryStoreHistorySink(repository, new QueryStoreCollectionStatusTracker());
        var state = new QueryStoreDatabaseState(
            "db", QueryStoreCollectionState.ReadWrite, "source", Now.AddDays(-1), Now,
            "available", 16, 160, true, false, false, false);
        await sink.BeginDatabaseCycleAsync(state, "epoch", false, default);
        await sink.StageFactsAsync("db", new QueryStoreFactPage(
            QueryStoreFactKind.Identity,
            Enumerable.Range(0, familyCount).Select(index => (QueryStoreCollectedFact)new QueryIdentityFact(
                $"query-{index}", $"text-{index}", "context", $"hash-{index}", Now,
                false, true, null, null, null, null)).ToArray(), null, false), default);
        await sink.StageFactsAsync("db", new QueryStoreFactPage(
            QueryStoreFactKind.Plan,
            Enumerable.Range(0, familyCount).Select(index => (QueryStoreCollectedFact)new QueryPlanFact(
                $"plan-{index}", $"query-{index}", $"plan-hash-{index}", QueryPlanType.Compiled,
                null, false, null, BigInteger.Zero, null, "16", "160", Now)).ToArray(),
            null, false), default);
        await sink.StageFactsAsync("db", new QueryStoreFactPage(
            QueryStoreFactKind.Wait,
            Enumerable.Range(0, familyCount).Select(index => (QueryStoreCollectedFact)new QueryWaitFact(
                $"plan-{index}", $"interval-{index}", QueryStoreExecutionType.Regular,
                "primary", 1, "CPU", BigInteger.One)).ToArray(), null, false), default);
        await sink.StageRuntimeBucketsAsync("db",
            Enumerable.Range(0, familyCount).Select(index => Bucket(
                $"plan-{index}", 1, Now) with
            {
                Key = new RuntimeBucketKey(
                    $"plan-{index}", $"interval-{index}", Now.AddHours(-1), Now,
                    QueryStoreExecutionType.Regular, "primary"),
            }).ToArray(), false, default);
        await sink.CommitDatabaseCycleAsync(state,
            new QueryStoreWatermark("db", "source", "epoch", Now,
                new Dictionary<QueryStoreFactKind, string?>()), default);
        await sink.PublishAsync(new QueryStoreCollectionResult(
            false, Now.AddMinutes(-1), Now,
            [new QueryStoreDatabaseCollectionResult(
                "db", QueryStoreCollectionState.ReadWrite, 3, familyCount, false, "ready", null)]), default);

        var inspected = sink.LastBuildInspection;
        Assert.Equal(familyCount, inspected.RuntimeRowsIndexed);
        Assert.Equal(familyCount, inspected.PlanRowsIndexed);
        Assert.Equal(familyCount, inspected.WaitRowsIndexed);
        Assert.Equal(familyCount, inspected.RuntimeIndexLookups);
        Assert.Equal(familyCount, inspected.PlanIndexLookups);
        Assert.Equal(familyCount, inspected.WaitIndexLookups);
    }

    [Fact]
    public async Task PublishedHorizonFollowsCollectedHistoryNotTheSourcesOlderBoundary()
    {
        var repository = new ProtectedQueryStoreRepository(new MemoryProtectedStore());
        var tracker = new QueryStoreCollectionStatusTracker();
        var sink = new ProtectedQueryStoreHistorySink(repository, tracker);
        // The server still holds well over a year; the collector only ever walked back 30 days.
        var state = new QueryStoreDatabaseState(
            "db", QueryStoreCollectionState.ReadWrite, "epoch", Now.AddDays(-400), Now,
            "available", 16, 160, true, true, false, false);
        var collectedFrom = Now.AddDays(-30);
        await sink.BeginDatabaseCycleAsync(state, "epoch", false, default);
        await sink.StageFactsAsync("db", new QueryStoreFactPage(QueryStoreFactKind.Identity,
            [new QueryIdentityFact(
                "q", "q-text", "context", "hash", Now, false, true, null, null, null, null)],
            null, false), default);
        await sink.StageFactsAsync("db", new QueryStoreFactPage(QueryStoreFactKind.Plan,
            [new QueryPlanFact(
                "plan", "q", "plan-hash", QueryPlanType.Compiled, null, false, null,
                BigInteger.Zero, null, "16", "160", Now)],
            null, false), default);
        await sink.StageRuntimeBucketsAsync(
            "db", [Bucket("plan", 3, collectedFrom.AddHours(1))], false, default);
        await sink.CommitDatabaseCycleAsync(state, new QueryStoreWatermark(
            "db", state.ResetEpoch, "epoch", Now,
            new Dictionary<QueryStoreFactKind, string?>()), default);
        await sink.PublishAsync(new QueryStoreCollectionResult(
            false, Now.AddSeconds(-1), Now, [DatabaseResult("db")], ["db"]), default);

        var status = Assert.Single(tracker.Current!.Databases);
        Assert.Equal(collectedFrom, status.OldestAvailableAt);
        Assert.NotEqual(state.OldestIntervalStart, status.OldestAvailableAt);
        var snapshot = await repository.ReadPublishedSnapshotAsync();
        Assert.Equal(
            collectedFrom,
            snapshot!.Families.SelectMany(family => family.Runtime).Min(bucket => bucket.IntervalStart));
    }

    private static async Task PublishCycleAsync(
        ProtectedQueryStoreHistorySink sink,
        long count,
        string epoch = "epoch",
        bool reset = false,
        DateTimeOffset? observedAt = null,
        string databaseId = "db")
    {
        var observed = observedAt ?? Now;
        var state = new QueryStoreDatabaseState(
            databaseId, QueryStoreCollectionState.ReadWrite, epoch, observed.AddDays(-1), observed,
            "available", 16, 160, true, true, false, false);
        await sink.BeginDatabaseCycleAsync(state, epoch, reset, default);
        await sink.StageFactsAsync(databaseId, new QueryStoreFactPage(QueryStoreFactKind.Identity,
        [
            new QueryIdentityFact("parent", "parent-text", "context-a", "hash-a", observed, false, true, null, null, null, null),
            new QueryIdentityFact("variant", "variant-text", "context-b", "hash-b", observed, false, true, null, null, null, null),
        ], null, false), default);
        await sink.StageFactsAsync(databaseId, new QueryStoreFactPage(QueryStoreFactKind.Plan,
        [
            new QueryPlanFact("dispatcher", "parent", "dispatcher-hash", QueryPlanType.Dispatcher, null,
                false, null, BigInteger.Zero, null, "16", "160", observed),
            new QueryPlanFact("variant-plan", "variant", "variant-hash", QueryPlanType.Variant, "dispatcher",
                false, null, BigInteger.One, "NO_INDEX", "16", "160", observed),
        ], null, false), default);
        await sink.StageFactsAsync(databaseId, new QueryStoreFactPage(QueryStoreFactKind.Variant,
        [
            new QueryVariantFact("variant", "parent", "dispatcher", QueryOptimizationKind.ParameterSensitivePlan),
        ], null, false), default);
        await sink.StageRuntimeBucketsAsync(databaseId,
        [
            Bucket("dispatcher", 999, observed),
            Bucket("variant-plan", count, observed),
        ], true, default);
        await sink.CommitDatabaseCycleAsync(state,
            new QueryStoreWatermark(
                databaseId, state.ResetEpoch, epoch, observed,
                new Dictionary<QueryStoreFactKind, string?>()), default);
        await sink.PublishAsync(new QueryStoreCollectionResult(false, observed.AddSeconds(-1), observed,
        [
            new QueryStoreDatabaseCollectionResult(
                databaseId, QueryStoreCollectionState.ReadWrite, 4, 2, false, "available", null),
        ]), default);
    }

    private static QueryStoreDatabaseCollectionResult DatabaseResult(
        string databaseId,
        string? failure = null) =>
        new(
            databaseId,
            failure is null ? QueryStoreCollectionState.ReadWrite : QueryStoreCollectionState.Error,
            failure is null ? 3 : 0,
            failure is null ? 1 : 0,
            false,
            failure ?? "available",
            failure is null ? null : nameof(IOException));

    private static AggregatedRuntimeBucket Bucket(
        string planId, long count, DateTimeOffset? observedAt = null)
    {
        var observed = observedAt ?? Now;
        return new(new RuntimeBucketKey(planId, "active", observed.AddHours(-1), observed,
                QueryStoreExecutionType.Regular, "primary"),
            count, 2_000m, 1_000m, 2m,
            (count * 2_000).ToString(CultureInfo.InvariantCulture),
            (count * 1_000).ToString(CultureInfo.InvariantCulture),
            (count * 2).ToString(CultureInfo.InvariantCulture));
    }

    private static QueryStorePublishedSnapshot Snapshot(string id, long sequence) =>
        new("1.0", id, sequence, Now, [],
            new QueryStoreCollectorStatusV1(
                "1.0", QueryStoreCollectorState.Ready, sequence, Now, Now, null, [], "ready"));

    private sealed class MemoryProtectedStore : IProtectedRecordStore
    {
        public Dictionary<string, ProtectedRecord> Records { get; } = new(StringComparer.Ordinal);
        public string? ThrowRecordKind { get; set; }
        public int MaxPayloadBytes { get; init; } = 1_048_576;

        public Task PutAsync(
            ProtectedRecordId id, string recordKind, DateTimeOffset capturedAt,
            StorageResolution resolution, ReadOnlyMemory<byte> payload,
            CancellationToken cancellationToken = default)
        {
            if (recordKind == ThrowRecordKind) throw new IOException("synthetic protected-store failure");
            if (payload.Length > MaxPayloadBytes)
                throw new ArgumentException(
                    $"Payload must be {MaxPayloadBytes} bytes or fewer.", nameof(payload));
            Records[id.Value] = new ProtectedRecord(
                id, recordKind, capturedAt, resolution, payload.ToArray());
            return Task.CompletedTask;
        }

        public Task<ProtectedRecord?> GetAsync(
            ProtectedRecordId id, CancellationToken cancellationToken = default)
        {
            var value = Records.GetValueOrDefault(id.Value);
            return Task.FromResult(value is null ? null : new ProtectedRecord(
                value.Id, value.RecordKind, value.CapturedAt, value.Resolution, value.Payload));
        }

        public Task<bool> DeleteAsync(
            ProtectedRecordId id, CancellationToken cancellationToken = default) =>
            Task.FromResult(Records.Remove(id.Value));

        public Task<ProtectedSetReplacement> ReplaceSetAsync(
            string idPrefix, IEnumerable<ProtectedRecordWrite> records,
            CancellationToken cancellationToken = default)
        {
            var replacement = records.Select(record => new ProtectedRecord(
                record.Id, record.RecordKind, record.CapturedAt,
                record.Resolution, record.Payload.Length <= MaxPayloadBytes
                    ? record.Payload.ToArray()
                    : throw new ArgumentException(
                        $"Payload must be {MaxPayloadBytes} bytes or fewer.", nameof(records)))).ToArray();
            var deleted = 0;
            var deletedBytes = 0L;
            foreach (var key in Records.Keys.Where(key =>
                         key.StartsWith(idPrefix, StringComparison.Ordinal)).ToArray())
            {
                deletedBytes += Records[key].Payload.Length;
                Records.Remove(key);
                deleted++;
            }
            foreach (var record in replacement)
                Records[record.Id.Value] = record;
            var bytes = replacement.Sum(record => (long)record.Payload.Length);
            return Task.FromResult(new ProtectedSetReplacement(
                deleted, deletedBytes, replacement.Length, bytes, bytes, TimeSpan.Zero));
        }

        public Task<IReadOnlyList<ProtectedRecordId>> ListOldestAsync(
            IReadOnlyCollection<string> recordKinds, int limit,
            CancellationToken cancellationToken = default) =>
            Task.FromResult(InMemoryUsage.ListOldest(Records, recordKinds, limit));

        public Task<ProtectedStorageUsage> MeasureUsageAsync(CancellationToken cancellationToken = default) =>
            Task.FromResult(InMemoryUsage.Measure(Records.Values));

        public Task<int> PruneExpiredAsync(CancellationToken cancellationToken = default) =>
            Task.FromResult(0);
    }

    private sealed class LargePlanSource : IQueryStoreIncrementalSource
    {
        public Task<IReadOnlyList<string>> DiscoverDatabasesAsync(CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<string>>([]);
        public Task<QueryStoreDatabaseState> GetStateAsync(
            string databaseId, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<QueryStoreFactPage> ReadPageAsync(
            string databaseId, QueryStoreFactKind kind, DateTimeOffset startInclusive,
            DateTimeOffset endExclusive, string? pageToken, int pageSize,
            CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<QueryTextPayload> ReadQueryTextAsync(
            string databaseId, string queryTextId, CancellationToken cancellationToken) =>
            Task.FromResult(new QueryTextPayload(null, false, false));
        public Task<string?> ReadPlanXmlAsync(
            string databaseId, string planId, CancellationToken cancellationToken) =>
            Task.FromResult<string?>(
                $"<ShowPlanXML><!--RAW_PRIVATE_MARKER{new string('x', 40_000)}-->" +
                "<RelOp NodeId=\"0\" LogicalOp=\"Scan\" PhysicalOp=\"Index Scan\" /></ShowPlanXML>");
    }
}
