using SqlSimCity.Collection.Probes;
using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;
using SqlSimCity.Storage;

namespace SqlSimCity.Collection.Tests.QueryStore;

/// <summary>
/// The API half of issue #77. A single <c>/api/v1/query-store/queries</c> request reads a
/// pointer, a header, an index page and one record per family. With
/// <see cref="SqliteProtectedRecordStore"/> disabling connection pooling on purpose, doing
/// that through <see cref="IProtectedRecordStore.GetAsync"/> meant one connection open per
/// row -- roughly 55 at the default page size and about 205 at the maximum -- which is
/// end-user latency, not background cost.
///
/// These count connections rather than reads: the reads were never the expensive part.
/// </summary>
public sealed class ConnectedQueryStoreConnectionCountTests
{
    [Theory]
    [InlineData(50)]
    [InlineData(200)]
    public async Task AQueryPageUsesOneConnectionRatherThanOnePerFamily(int pageSize)
    {
        var store = new SessionCountingStore();
        var source = await SeededSourceAsync(store, familyCount: 200);
        store.Reset();

        var page = await source.GetQueriesAsync(null, "cpu", pageSize, null, default);

        Assert.Equal(pageSize, page.Items.Count);
        Assert.Equal(1, store.SessionCount);
        Assert.Equal(0, store.DirectGetCount);
        Assert.True(
            store.SessionGetCount >= pageSize,
            $"Only {store.SessionGetCount} of {pageSize} family reads went through the session.");
    }

    [Fact]
    public async Task AFamilyDetailReadUsesOneConnection()
    {
        var store = new SessionCountingStore();
        var source = await SeededSourceAsync(store, familyCount: 8);
        store.Reset();

        var detail = await source.GetFamilyAsync("family-000003", default);

        Assert.NotNull(detail);
        Assert.Equal(1, store.SessionCount);
        Assert.Equal(0, store.DirectGetCount);
    }

    /// <summary>
    /// A plan read outside any batch still takes a session, so a cold database-city page --
    /// which hydrates up to 96 plans, each a manifest plus chunk records -- pays one
    /// connection per plan rather than one per record.
    /// </summary>
    [Fact]
    public async Task APlanReadTakesOneConnectionForItsManifestAndChunks()
    {
        var store = new SessionCountingStore();
        var repository = new ProtectedQueryStoreRepository(store);
        var source = new ConnectedQueryStoreHistorySource(
            repository, new NoSource(), new SecureShowplanParser(),
            new QueryStoreCollectionStatusTracker(), TimeProvider.System,
            allowRawPayloadHydration: false);
        await repository.StoreNormalizedPlanAsync(
            new NormalizedShowplanV1(
                "1.0", "db:plan-1", "1.539", null, null, null, [],
                QueryOptimizationKind.None, null, "fingerprint", "no runtime overlay",
                new QueryStoreEvidenceV1(
                    QueryStoreSource.QueryStore, DataStatus.Available,
                    DateTimeOffset.UnixEpoch, null, "seed", "compiled plan structure")),
            DateTimeOffset.UnixEpoch, default);
        store.Reset();

        var plan = await source.GetPlanAsync("db:plan-1", default);

        Assert.NotNull(plan);
        Assert.Equal(1, store.SessionCount);
        Assert.Equal(0, store.DirectGetCount);
    }

    private static async Task<ConnectedQueryStoreHistorySource> SeededSourceAsync(
        SessionCountingStore store, int familyCount)
    {
        var repository = new ProtectedQueryStoreRepository(store);
        var sink = new ProtectedQueryStoreHistorySink(repository, new QueryStoreCollectionStatusTracker());
        var now = new DateTimeOffset(2026, 8, 25, 12, 0, 0, TimeSpan.Zero);
        var evidence = new QueryStoreEvidenceV1(
            QueryStoreSource.QueryStore, DataStatus.Available, now, null, "seed", "aggregate");
        var families = Enumerable.Range(0, familyCount).Select(index =>
        {
            var id = $"family-{index:D6}";
            var text = new QueryTextDescriptorV1(
                QueryTextAvailability.Restricted, null, null, "restricted");
            var identity = new PhysicalQueryIdentityV1(
                "db", $"query-{index}", $"text-{index}", id,
                new QueryContextSettingsV1($"context-{index}", null, null, null, "160", null),
                text);
            var summary = new QueryFamilySummaryV1(
                id, "db", id, null, text, [identity],
                "1", "1", "1", "1", "0", now, now, evidence);
            return new QueryFamilyDetailV1("1.0", summary, [], []);
        }).ToArray();
        await repository.PublishSnapshotAsync(
            new QueryStorePublishedSnapshot(
                "1.0", "snapshot", 1, now, families,
                new QueryStoreCollectorStatusV1(
                    "1.0", QueryStoreCollectorState.Ready, 1, now, now, null, [], "ready")),
            default);
        _ = sink;
        return new ConnectedQueryStoreHistorySource(
            repository, new NoSource(), new SecureShowplanParser(),
            new QueryStoreCollectionStatusTracker(), TimeProvider.System,
            allowRawPayloadHydration: false);
    }

    /// <summary>
    /// Counts connections, not reads: <see cref="BeginReadSessionAsync"/> stands in for a
    /// connection open, and a read arriving through <see cref="GetAsync"/> instead is one
    /// that escaped the batch.
    /// </summary>
    private sealed class SessionCountingStore : IProtectedRecordStore
    {
        private readonly Dictionary<string, ProtectedRecord> _records = new(StringComparer.Ordinal);

        public int SessionCount { get; private set; }
        public int SessionGetCount { get; private set; }
        public int DirectGetCount { get; private set; }
        public int MaxPayloadBytes => 1_048_576;

        public void Reset()
        {
            SessionCount = 0;
            SessionGetCount = 0;
            DirectGetCount = 0;
        }

        public Task<IProtectedRecordReadSession> BeginReadSessionAsync(
            CancellationToken cancellationToken = default)
        {
            SessionCount++;
            return Task.FromResult<IProtectedRecordReadSession>(new Session(this));
        }

        public Task PutAsync(
            ProtectedRecordId id, string recordKind, DateTimeOffset capturedAt,
            StorageResolution resolution, ReadOnlyMemory<byte> payload,
            CancellationToken cancellationToken = default)
        {
            _records[id.Value] = new ProtectedRecord(
                id, recordKind, capturedAt, resolution, payload.ToArray());
            return Task.CompletedTask;
        }

        public Task<ProtectedRecord?> GetAsync(
            ProtectedRecordId id, CancellationToken cancellationToken = default)
        {
            DirectGetCount++;
            return Task.FromResult(Read(id));
        }

        public Task<bool> DeleteAsync(
            ProtectedRecordId id, CancellationToken cancellationToken = default) =>
            Task.FromResult(_records.Remove(id.Value));

        public Task ReplaceSetAsync(
            string idPrefix, IEnumerable<ProtectedRecordWrite> records,
            CancellationToken cancellationToken = default)
        {
            var replacement = records.Select(record => new ProtectedRecord(
                record.Id, record.RecordKind, record.CapturedAt,
                record.Resolution, record.Payload.ToArray())).ToArray();
            foreach (var key in _records.Keys
                         .Where(key => key.StartsWith(idPrefix, StringComparison.Ordinal))
                         .ToArray())
                _records.Remove(key);
            foreach (var record in replacement) _records[record.Id.Value] = record;
            return Task.CompletedTask;
        }

        public Task<int> PruneExpiredAsync(CancellationToken cancellationToken = default) =>
            Task.FromResult(0);

        private ProtectedRecord? Read(ProtectedRecordId id)
        {
            var value = _records.GetValueOrDefault(id.Value);
            return value is null ? null : new ProtectedRecord(
                value.Id, value.RecordKind, value.CapturedAt, value.Resolution, value.Payload);
        }

        private sealed class Session(SessionCountingStore owner) : IProtectedRecordReadSession
        {
            public Task<ProtectedRecord?> GetAsync(
                ProtectedRecordId id, CancellationToken cancellationToken = default)
            {
                owner.SessionGetCount++;
                return Task.FromResult(owner.Read(id));
            }

            public ValueTask DisposeAsync() => ValueTask.CompletedTask;
        }
    }

    private sealed class NoSource : IQueryStoreIncrementalSource
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
            throw new NotSupportedException();
        public Task<string?> ReadPlanXmlAsync(
            string databaseId, string planId, CancellationToken cancellationToken) =>
            throw new NotSupportedException();
    }
}
