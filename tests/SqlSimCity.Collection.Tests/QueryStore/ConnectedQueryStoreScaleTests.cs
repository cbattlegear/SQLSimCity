using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;
using SqlSimCity.Storage;

namespace SqlSimCity.Collection.Tests.QueryStore;

public sealed class ConnectedQueryStoreScaleTests
{
    [Fact]
    public async Task HundredThousandFamilyPageReadsBoundedRecords()
    {
        const string snapshotId = "scale-snapshot";
        var store = new CountingStore();
        var repository = new ProtectedQueryStoreRepository(store);
        var evidence = new QueryStoreEvidenceV1(
            QueryStoreSource.QueryStore, DataStatus.Available, DateTimeOffset.UtcNow, null, "scale", "aggregate");
        var ids = Enumerable.Range(0, 200).Select(index => $"family-{index:D6}").ToArray();
        foreach (var id in ids)
        {
            var summary = new QueryFamilySummaryV1(
                id, "db", id, null,
                new QueryTextDescriptorV1(QueryTextAvailability.Missing, null, null, "missing"),
                [], "1", "1", "1", "1", "0", DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, evidence);
            await PutJsonAsync(store, Id("family-detail", snapshotId, id),
                new QueryFamilyDetailV1("1.0", summary, [], []));
        }
        await PutJsonAsync(store, Id("family-index:cpu", snapshotId, "*\n0"),
            new QueryStoreIndexPage(ids));
        var snapshot = new QueryStorePublishedSnapshot(
            "1.0", snapshotId, 7, DateTimeOffset.UtcNow, [],
            new QueryStoreCollectorStatusV1(
                "1.0", QueryStoreCollectorState.Ready, 7, null, DateTimeOffset.UtcNow, null, [], "ready"),
            IndexSets: [new QueryStoreIndexSet("cpu", null, 100_000, 500)]);
        var snapshotRecordId = Id("snapshot", snapshotId, "7");
        await PutJsonAsync(store, snapshotRecordId, snapshot);
        await PutJsonAsync(store, "qs:current-snapshot-pointer", new QueryStoreSnapshotPointer(snapshotRecordId));
        store.GetCount = 0;
        var source = new ConnectedQueryStoreHistorySource(
            repository, new NoDetailSource(), new SecureShowplanParser(),
            new QueryStoreCollectionStatusTracker(), TimeProvider.System);

        var page = await source.GetQueriesAsync(null, "cpu", 100, null, default);

        Assert.Equal(100, page.Items.Count);
        Assert.Equal("100000", page.TotalCount);
        Assert.NotNull(page.NextPageToken);
        Assert.InRange(store.GetCount, 1, 103);

        await Assert.ThrowsAsync<QueryStorePageTokenException>(() =>
            source.GetQueriesAsync(null, "cpu", 100, new string('A', 2_049), default));
        var invalid = Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(new
        {
            SnapshotId = snapshotId,
            Metric = "cpu",
            DatabaseId = (string?)null,
            PageIndex = int.MaxValue,
            Offset = 199,
        }));
        await Assert.ThrowsAsync<QueryStorePageTokenException>(() =>
            source.GetQueriesAsync(null, "cpu", 100, invalid, default));
        var terminal = Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(new
        {
            SnapshotId = snapshotId,
            Metric = "cpu",
            DatabaseId = (string?)null,
            PageIndex = 500,
            Offset = 0,
        }));
        await Assert.ThrowsAsync<QueryStorePageTokenException>(() =>
            source.GetQueriesAsync(null, "cpu", 100, terminal, default));
        var missingSnapshot = Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(new
        {
            SnapshotId = (string?)null,
            Metric = "cpu",
            DatabaseId = (string?)null,
            PageIndex = 0,
            Offset = 0,
        }));
        await Assert.ThrowsAsync<QueryStorePageTokenException>(() =>
            source.GetQueriesAsync(null, "cpu", 100, missingSnapshot, default));
    }

    [Fact]
    public async Task LegacyChunkSnapshotRemainsQueryableAfterUpgrade()
    {
        const string snapshotId = "legacy-snapshot";
        var store = new CountingStore();
        var repository = new ProtectedQueryStoreRepository(store);
        var evidence = new QueryStoreEvidenceV1(
            QueryStoreSource.QueryStore, DataStatus.Stale, DateTimeOffset.UtcNow, null, "legacy", "aggregate");
        var text = new QueryTextDescriptorV1(QueryTextAvailability.Restricted, null, null, "restricted");
        var identity = new PhysicalQueryIdentityV1(
            "db", "query-1", "text-1", "hash-1",
            new QueryContextSettingsV1("context-1", null, null, null, "160", null), text);
        var summary = new QueryFamilySummaryV1(
            "family-1", "db", "hash-1", null, text, [identity],
            "47", "200", "300", "400", "5", DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, evidence);
        var detail = new QueryFamilyDetailV1("1.0", summary, [], []);
        var chunkId = "legacy-family-chunk";
        await PutJsonAsync(store, chunkId, new QueryStoreFamilyChunk([detail]));
        var snapshot = new QueryStorePublishedSnapshot(
            "1.0", snapshotId, 3, DateTimeOffset.UtcNow, [],
            new QueryStoreCollectorStatusV1(
                "1.0", QueryStoreCollectorState.Ready, 3, null, DateTimeOffset.UtcNow, null, [], "ready"),
            FamilyChunkRecordIds: [chunkId]);
        var snapshotRecordId = Id("snapshot", snapshotId, "3");
        await PutJsonAsync(store, snapshotRecordId, snapshot);
        await PutJsonAsync(store, "qs:current-snapshot-pointer", new QueryStoreSnapshotPointer(snapshotRecordId));
        var source = new ConnectedQueryStoreHistorySource(
            repository, new NoDetailSource(), new SecureShowplanParser(),
            new QueryStoreCollectionStatusTracker(), TimeProvider.System);

        var page = await source.GetQueriesAsync(null, "execution", 100, null, default);
        var restored = await source.GetFamilyAsync("family-1", default);

        Assert.Equal("47", Assert.Single(page.Items).ExecutionCount);
        Assert.Equal("family-1", restored?.Family.FamilyId);
    }

    [Fact]
    public async Task ListReadRetriesWhenTwoPublicationsReuseItsSlot()
    {
        var store = new CountingStore();
        var repository = new ProtectedQueryStoreRepository(store);
        await repository.PublishSnapshotAsync(SnapshotWithFamily("snapshot-a", 1, "family-a"));
        store.OnFirstIndexRead = async () =>
        {
            await repository.PublishSnapshotAsync(SnapshotWithFamily("snapshot-b", 2, "family-b"));
            await repository.PublishSnapshotAsync(SnapshotWithFamily("snapshot-c", 3, "family-c"));
        };
        var source = new ConnectedQueryStoreHistorySource(
            repository, new NoDetailSource(), new SecureShowplanParser(),
            new QueryStoreCollectionStatusTracker(), TimeProvider.System);

        var page = await source.GetQueriesAsync(null, "cpu", 100, null, default);

        Assert.Equal("family-c", Assert.Single(page.Items).FamilyId);
        Assert.Equal(1, store.IndexReadRaceCount);
    }

    private static async Task PutJsonAsync<T>(CountingStore store, string id, T value)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(value);
        await store.PutAsync(id, "test", DateTimeOffset.UtcNow, StorageResolution.Detail, bytes);
    }

    private static string Id(string kind, string databaseId, string sourceId)
    {
        var opaque = SHA256.HashData(Encoding.UTF8.GetBytes($"{kind}\n{databaseId}\n{sourceId}"));
        return $"qs:{Convert.ToHexString(opaque).ToLowerInvariant()}";
    }

    private static QueryStorePublishedSnapshot SnapshotWithFamily(
        string snapshotId,
        long sequence,
        string familyId)
    {
        var captured = DateTimeOffset.UtcNow;
        var evidence = new QueryStoreEvidenceV1(
            QueryStoreSource.QueryStore, DataStatus.Available, captured, null, "race", "aggregate");
        var summary = new QueryFamilySummaryV1(
            familyId, "db", familyId, null,
            new QueryTextDescriptorV1(QueryTextAvailability.Missing, null, null, "missing"),
            [], "1", "1", "1", "1", "0", captured, captured, evidence);
        return new QueryStorePublishedSnapshot(
            "1.0", snapshotId, sequence, captured,
            [new QueryFamilyDetailV1("1.0", summary, [], [])],
            new QueryStoreCollectorStatusV1(
                "1.0", QueryStoreCollectorState.Ready, sequence,
                captured, captured, null, [], "ready"));
    }

    private sealed class CountingStore : IProtectedRecordStore
    {
        private readonly Dictionary<string, ProtectedRecord> _records = new(StringComparer.Ordinal);
        public int GetCount { get; set; }
        public int MaxPayloadBytes => 1_048_576;
        public Func<Task>? OnFirstIndexRead { get; set; }
        public int IndexReadRaceCount { get; private set; }
        public Task PutAsync(
            ProtectedRecordId id, string recordKind, DateTimeOffset capturedAt,
            StorageResolution resolution, ReadOnlyMemory<byte> payload,
            CancellationToken cancellationToken = default)
        {
            _records[id.Value] = new(id, recordKind, capturedAt, resolution, payload.ToArray());
            return Task.CompletedTask;
        }
        public async Task<ProtectedRecord?> GetAsync(
            ProtectedRecordId id, CancellationToken cancellationToken = default)
        {
            GetCount++;
            var value = _records.GetValueOrDefault(id.Value);
            if (value?.RecordKind == "query-store-family-index-page" &&
                OnFirstIndexRead is { } race && IndexReadRaceCount == 0)
            {
                IndexReadRaceCount = 1;
                await race();
            }
            return value is null ? null : new ProtectedRecord(
                value.Id, value.RecordKind, value.CapturedAt, value.Resolution, value.Payload);
        }
        public Task<bool> DeleteAsync(
            ProtectedRecordId id, CancellationToken cancellationToken = default) =>
            Task.FromResult(_records.Remove(id.Value));
        public Task<ProtectedSetReplacement> ReplaceSetAsync(
            string idPrefix, IEnumerable<ProtectedRecordWrite> records,
            CancellationToken cancellationToken = default)
        {
            var deleted = 0;
            var deletedBytes = 0L;
            foreach (var key in _records.Keys.Where(key =>
                         key.StartsWith(idPrefix, StringComparison.Ordinal)).ToArray())
            {
                deletedBytes += _records[key].Payload.Length;
                _records.Remove(key);
                deleted++;
            }
            var written = 0;
            var bytes = 0L;
            foreach (var record in records)
            {
                _records[record.Id.Value] = new(
                    record.Id, record.RecordKind, record.CapturedAt,
                    record.Resolution, record.Payload.ToArray());
                written++;
                bytes += record.Payload.Length;
            }
            return Task.FromResult(
                new ProtectedSetReplacement(deleted, deletedBytes, written, bytes, bytes, TimeSpan.Zero));
        }
        public Task<IReadOnlyList<ProtectedRecordId>> ListOldestAsync(
            IReadOnlyCollection<string> recordKinds, int limit,
            CancellationToken cancellationToken = default) =>
            Task.FromResult(InMemoryUsage.ListOldest(_records, recordKinds, limit));
        public Task<ProtectedStorageUsage> MeasureUsageAsync(CancellationToken cancellationToken = default) =>
            Task.FromResult(InMemoryUsage.Measure(_records.Values));
        public Task<int> PruneExpiredAsync(CancellationToken cancellationToken = default) =>
            Task.FromResult(0);
    }

    private sealed class NoDetailSource : IQueryStoreIncrementalSource
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
            Task.FromResult<string?>(null);
    }
}
