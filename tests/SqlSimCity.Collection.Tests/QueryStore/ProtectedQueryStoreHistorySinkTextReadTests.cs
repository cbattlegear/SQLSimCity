using System.Globalization;
using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Storage;

namespace SqlSimCity.Collection.Tests.QueryStore;

/// <summary>
/// Pins the collection half of issue #77. Staging read one stored text descriptor per
/// identity, on its own storage connection, which made a first or backfill cycle one open
/// per identity. Most of those reads were avoidable: identities repeat query text, and a
/// descriptor already staged as available cannot be improved on by reading storage again.
///
/// The reduction must not change what text ends up published. In particular a descriptor
/// staged as <see cref="QueryTextAvailability.Missing"/> is not terminal -- the API hydrates
/// text on demand and writes it back -- so staging must keep re-reading those.
/// </summary>
public sealed class ProtectedQueryStoreHistorySinkTextReadTests
{
    private static readonly DateTimeOffset Now =
        new(2026, 8, 25, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task StagingReadsEachQueryTextOncePerPageRatherThanOncePerIdentity()
    {
        var store = new CountingStore();
        var repository = new ProtectedQueryStoreRepository(store);
        var sink = new ProtectedQueryStoreHistorySink(repository, new QueryStoreCollectionStatusTracker());
        await BeginAsync(sink);
        store.GetCount = 0;

        // Twelve identities, three distinct query texts: four identities each.
        await StageIdentitiesAsync(sink, Enumerable.Range(0, 12)
            .Select(index => ($"query-{index}", $"text-{index % 3}")));

        Assert.Equal(3, store.GetCount);
    }

    [Fact]
    public async Task StagingDoesNotReReadTextItAlreadyHasAvailable()
    {
        var store = new CountingStore();
        var repository = new ProtectedQueryStoreRepository(store);
        await repository.StoreTextDescriptorAsync(
            "db", "text-1", Available("select 1"), Now, default);
        var sink = new ProtectedQueryStoreHistorySink(repository, new QueryStoreCollectionStatusTracker());
        await BeginAsync(sink);
        store.GetCount = 0;

        await StageIdentitiesAsync(sink, [("query-1", "text-1")]);
        var afterFirstPage = store.GetCount;
        await StageIdentitiesAsync(sink, [("query-2", "text-1")]);
        await StageIdentitiesAsync(sink, [("query-3", "text-1")]);

        Assert.Equal(1, afterFirstPage);
        Assert.Equal(1, store.GetCount);
    }

    /// <summary>
    /// The semantics that must survive the optimisation. A <c>Missing</c> descriptor means
    /// "not fetched yet", and the API's on-demand hydration writes a real one behind the
    /// collector's back. Staging must therefore keep reading those ids, and the text must
    /// reach the published family.
    /// </summary>
    [Fact]
    public async Task StagingPicksUpTextHydratedOnDemandAfterAMissingDescriptor()
    {
        var store = new CountingStore();
        var repository = new ProtectedQueryStoreRepository(store);
        await repository.StoreTextDescriptorAsync(
            "db", "text-1",
            new QueryTextDescriptorV1(QueryTextAvailability.Missing, null, null, "not fetched yet"),
            Now, default);
        var sink = new ProtectedQueryStoreHistorySink(repository, new QueryStoreCollectionStatusTracker());
        await BeginAsync(sink);
        store.GetCount = 0;

        await StageIdentitiesAsync(sink, [("query-1", "text-1")]);
        var afterMissing = store.GetCount;

        // The API hydrates the text and stores it while the collector is between pages.
        await repository.StoreTextDescriptorAsync(
            "db", "text-1", Available("select hydrated"), Now, default);
        await StageIdentitiesAsync(sink, [("query-2", "text-1")]);

        Assert.Equal(1, afterMissing);
        Assert.Equal(2, store.GetCount);

        await PublishAsync(sink);
        var snapshot = await repository.ReadPublishedSnapshotAsync(default);
        Assert.NotNull(snapshot);
        var family = Assert.Single(snapshot!.Families);
        Assert.Equal(QueryTextAvailability.Available, family.Family.Text.Availability);
        Assert.Equal("select hydrated", family.Family.Text.NormalizedText);
    }

    /// <summary>
    /// A descriptor that storage does not hold at all must stay absent from the staged text,
    /// so the family falls back to the reason derived from the identity flags rather than
    /// silently inheriting another query's text.
    /// </summary>
    [Fact]
    public async Task StagingLeavesTextAbsentWhenStorageHoldsNoDescriptor()
    {
        var store = new CountingStore();
        var repository = new ProtectedQueryStoreRepository(store);
        var sink = new ProtectedQueryStoreHistorySink(repository, new QueryStoreCollectionStatusTracker());
        await BeginAsync(sink);

        await StageIdentitiesAsync(sink, [("query-1", "text-1")]);
        await PublishAsync(sink);

        var snapshot = await repository.ReadPublishedSnapshotAsync(default);
        var family = Assert.Single(snapshot!.Families);
        Assert.Equal(QueryTextAvailability.Restricted, family.Family.Text.Availability);
        Assert.Null(family.Family.Text.NormalizedText);
    }

    private static QueryTextDescriptorV1 Available(string text) =>
        new(QueryTextAvailability.Available, text, "fingerprint", "available");

    private static QueryStoreDatabaseState State() =>
        new("db", QueryStoreCollectionState.ReadWrite, "source", Now.AddDays(-1), Now,
            "available", 16, 160, true, false, false, false);

    private static Task BeginAsync(ProtectedQueryStoreHistorySink sink) =>
        sink.BeginDatabaseCycleAsync(State(), "epoch", false, default);

    private static Task StageIdentitiesAsync(
        ProtectedQueryStoreHistorySink sink,
        IEnumerable<(string QueryId, string TextId)> identities) =>
        sink.StageFactsAsync("db", new QueryStoreFactPage(
            QueryStoreFactKind.Identity,
            identities.Select(pair => (QueryStoreCollectedFact)new QueryIdentityFact(
                pair.QueryId, pair.TextId, "context", "hash", Now,
                false, true, null, null, null, null)).ToArray(),
            null, false), default);

    private static async Task PublishAsync(ProtectedQueryStoreHistorySink sink)
    {
        var state = State();
        await sink.CommitDatabaseCycleAsync(
            state,
            new QueryStoreWatermark("db", "source", "epoch", Now,
                new Dictionary<QueryStoreFactKind, string?>()),
            default);
        await sink.PublishAsync(new QueryStoreCollectionResult(
            false, Now.AddMinutes(-1), Now,
            [new QueryStoreDatabaseCollectionResult(
                "db", QueryStoreCollectionState.ReadWrite, 1, 1, false, "ready", null)]), default);
    }

    private sealed class CountingStore : IProtectedRecordStore
    {
        private readonly Dictionary<string, ProtectedRecord> _records = new(StringComparer.Ordinal);

        public int GetCount { get; set; }
        public int MaxPayloadBytes => 1_048_576;

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
            GetCount++;
            var value = _records.GetValueOrDefault(id.Value);
            return Task.FromResult(value is null ? null : new ProtectedRecord(
                value.Id, value.RecordKind, value.CapturedAt, value.Resolution, value.Payload));
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
    }
}
