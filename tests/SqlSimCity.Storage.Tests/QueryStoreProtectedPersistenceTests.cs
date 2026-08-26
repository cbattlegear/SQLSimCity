using System.Text;
using Microsoft.Data.Sqlite;
using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Storage;
using SqlSimCity.Storage.Sqlite;

namespace SqlSimCity.Storage.Tests;

public sealed class QueryStoreProtectedPersistenceTests
{
    [Fact]
    public async Task HundredThousandFamilyGenerationIsReplacedWithinTwoSqliteSlots()
    {
        var directory = NewDirectory("query-store-bounded-generations");
        try
        {
            using var store = NewStore(directory);
            await store.EnsureReadyAsync();
            var repository = new ProtectedQueryStoreRepository(store);
            var captured = DateTimeOffset.UtcNow;

            await repository.PublishSnapshotAsync(Snapshot(
                "generation-1", 1, captured, Families(100_000, "first", captured)));
            await repository.PublishSnapshotAsync(Snapshot(
                "generation-2", 2, captured.AddMinutes(2), Families(1_000, "second", captured)));
            await repository.PublishSnapshotAsync(Snapshot(
                "generation-3", 3, captured.AddMinutes(4), Families(500, "third", captured)));

            await using var connection = new SqliteConnection(
                $"Data Source={Path.Combine(directory, "history.db")};Pooling=False");
            await connection.OpenAsync();
            await using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT
                    SUM(CASE WHEN record_kind = 'query-store-family-detail' THEN 1 ELSE 0 END),
                    COUNT(DISTINCT CASE
                        WHEN id LIKE 'qs:query-store-slot:%' THEN substr(id, 21, 1)
                    END)
                FROM protected_records;
                """;
            await using var reader = await command.ExecuteReaderAsync();
            Assert.True(await reader.ReadAsync());
            Assert.Equal(1_500, reader.GetInt32(0));
            Assert.Equal(2, reader.GetInt32(1));

            var restored = await repository.ReadPublishedSnapshotHeaderAsync();
            Assert.Equal("generation-3", restored?.SnapshotId);
        }
        finally { Cleanup(directory); }
    }

    [Fact]
    public async Task QueryTextPlanAndSnapshotsArePersistedInTheClear()
    {
        var directory = NewDirectory("query-store-persistence");
        try
        {
            using (var store = NewStore(directory))
            {
                await store.EnsureReadyAsync();
                var repository = new ProtectedQueryStoreRepository(store);
                await repository.StoreQueryTextAsync("db", "text", DateTimeOffset.UtcNow,
                    "QUERY_TEXT_MARKER");
                await repository.StorePlanXmlAsync("db", "plan", DateTimeOffset.UtcNow,
                    "<ShowPlanXML PLAN_MARKER='yes' />");
                await repository.PublishSnapshotAsync(new QueryStorePublishedSnapshot(
                    "1.0", "SNAPSHOT_MARKER", 1, DateTimeOffset.UtcNow, [],
                    new("1.0", QueryStoreCollectorState.Ready, 1,
                        DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, null, [], "STATUS_MARKER")));
            }

            // Captured plans and query text are the product, not a secret. An operator must be able
            // to open the store with sqlite3 and read exactly what was collected.
            var persisted = string.Concat(await Task.WhenAll(Directory
                .EnumerateFiles(directory)
                .Select(async path => Encoding.Latin1.GetString(await File.ReadAllBytesAsync(path)))));
            Assert.Contains("QUERY_TEXT_MARKER", persisted, StringComparison.Ordinal);
            Assert.Contains("PLAN_MARKER", persisted, StringComparison.Ordinal);
            Assert.Contains("SNAPSHOT_MARKER", persisted, StringComparison.Ordinal);
            Assert.Contains("STATUS_MARKER", persisted, StringComparison.Ordinal);
        }
        finally { Cleanup(directory); }
    }

    [Fact]
    public async Task PublishedSnapshotSurvivesDetailPruneAndExpiresAfterNinetyDays()
    {
        var directory = NewDirectory("query-store-retention");
        var captured = new DateTimeOffset(2026, 8, 17, 18, 0, 0, TimeSpan.Zero);
        var clock = new TestTimeProvider(captured);
        try
        {
            using (var store = NewStore(directory, clock))
            {
                await store.EnsureReadyAsync();
                var repository = new ProtectedQueryStoreRepository(store);
                await repository.StoreQueryTextAsync("db", "raw", captured, "short-lived raw SQL");
                await repository.PublishSnapshotAsync(Snapshot(
                    "retained", 1, captured, Families(1, "retained", captured)));

                clock.Advance(TimeSpan.FromDays(8));
                await DrainPruneAsync(store);
                Assert.Null(await repository.ReadSensitiveTextAsync("query-text", "db", "raw"));
                Assert.Equal("retained", (await repository.ReadPublishedSnapshotAsync())?.SnapshotId);
            }

            using (var store = NewStore(directory, clock))
            {
                await store.EnsureReadyAsync();
                var repository = new ProtectedQueryStoreRepository(store);
                Assert.Equal("retained", (await repository.ReadPublishedSnapshotAsync())?.SnapshotId);

                clock.SetUtcNow(captured.AddDays(90));
                await DrainPruneAsync(store);
                Assert.Equal("retained", (await repository.ReadPublishedSnapshotAsync())?.SnapshotId);

                clock.Advance(TimeSpan.FromMilliseconds(1));
                await DrainPruneAsync(store);
                Assert.Null(await repository.ReadPublishedSnapshotAsync());
            }
        }
        finally { Cleanup(directory); }
    }

    [Fact]
    public async Task PublishedEpochAndIndexesSurviveRealSqliteRestart()
    {
        var directory = NewDirectory("query-store-restart");
        try
        {
            var captured = DateTimeOffset.UtcNow;
            var evidence = new QueryStoreEvidenceV1(
                QueryStoreSource.QueryStore, DataStatus.Available, captured, null, "restart", "aggregate");
            var summary = new QueryFamilySummaryV1(
                "family", "db", "hash", null,
                new QueryTextDescriptorV1(QueryTextAvailability.Missing, null, null, "missing"),
                [], "1", "1", "1", "1", "0", captured, captured, evidence);
            var runtime = new RuntimeBucketV1(
                "db:plan", "interval:with:colon", "query-store:db:generation:7",
                captured.AddMinutes(-1), captured, QueryStoreExecutionType.Regular, "primary",
                "1", 1, 1, 1, "1", "1", "1", new Dictionary<string, string>(), evidence);
            var snapshot = new QueryStorePublishedSnapshot(
                "1.0", "restart-snapshot", 1, captured,
                [new QueryFamilyDetailV1("1.0", summary, [], [runtime])],
                new QueryStoreCollectorStatusV1(
                    "1.0", QueryStoreCollectorState.Ready, 1, captured, captured, null, [], "ready"));

            using (var store = NewStore(directory))
            {
                await store.EnsureReadyAsync();
                var repository = new ProtectedQueryStoreRepository(store);
                await repository.PublishSnapshotAsync(snapshot);
                var failed = snapshot with { SnapshotId = "unpublished", Sequence = 2 };
                await Assert.ThrowsAsync<IOException>(() =>
                    new ProtectedQueryStoreRepository(new FailPointerStore(store))
                        .PublishSnapshotAsync(failed));
            }
            using (var store = NewStore(directory))
            {
                await store.EnsureReadyAsync();
                var restored = await new ProtectedQueryStoreRepository(store).ReadPublishedSnapshotAsync();
                Assert.Equal("restart-snapshot", restored!.SnapshotId);
                var restoredRuntime = Assert.Single(Assert.Single(restored.Families).Runtime);
                Assert.Equal("query-store:db:generation:7", restoredRuntime.EpochId);
                Assert.Equal("interval:with:colon", restoredRuntime.IntervalId);
            }
        }
        finally { Cleanup(directory); }
    }

    private static string NewDirectory(string name)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, name, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }
    private static SqliteProtectedRecordStore NewStore(
        string directory,
        TimeProvider? timeProvider = null) =>
        new(directory, "history.db", new RetentionOptions(), timeProvider ?? TimeProvider.System);

    private static async Task DrainPruneAsync(SqliteProtectedRecordStore store)
    {
        while (await store.PruneExpiredAsync() > 0) { }
    }

    private static QueryStorePublishedSnapshot Snapshot(
        string id,
        long sequence,
        DateTimeOffset captured,
        IReadOnlyList<QueryFamilyDetailV1> families) =>
        new("1.0", id, sequence, captured, families,
            new QueryStoreCollectorStatusV1(
                "1.0", QueryStoreCollectorState.Ready, sequence,
                captured, captured, null, [], "ready"));

    private static QueryFamilyDetailV1[] Families(
        int count,
        string marker,
        DateTimeOffset captured)
    {
        var evidence = new QueryStoreEvidenceV1(
            QueryStoreSource.QueryStore, DataStatus.Available, captured, null, marker, "aggregate");
        var text = new QueryTextDescriptorV1(
            QueryTextAvailability.Missing, null, null, "missing");
        return Enumerable.Range(0, count).Select(index =>
        {
            var id = $"{marker}-{index:D6}";
            var summary = new QueryFamilySummaryV1(
                id, "db", id, null, text, [], "1", "1", "1", "1", "0",
                captured, captured, evidence);
            return new QueryFamilyDetailV1("1.0", summary, [], []);
        }).ToArray();
    }

    private static void Cleanup(string directory)
    {
        Directory.Delete(directory, recursive: true);
    }

    private sealed class FailPointerStore(IProtectedRecordStore inner) : IProtectedRecordStore
    {
        public int MaxPayloadBytes => inner.MaxPayloadBytes;
        public Task PutAsync(
            ProtectedRecordId id, string recordKind, DateTimeOffset capturedAt,
            StorageResolution resolution, ReadOnlyMemory<byte> payload,
            CancellationToken cancellationToken = default) =>
            id.Value == "qs:current-snapshot-pointer"
                ? Task.FromException(new IOException("synthetic pointer failure"))
                : inner.PutAsync(id, recordKind, capturedAt, resolution, payload, cancellationToken);
        public Task<ProtectedRecord?> GetAsync(
            ProtectedRecordId id, CancellationToken cancellationToken = default) =>
            inner.GetAsync(id, cancellationToken);
        public Task<bool> DeleteAsync(
            ProtectedRecordId id, CancellationToken cancellationToken = default) =>
            inner.DeleteAsync(id, cancellationToken);
        public Task<ProtectedSetReplacement> ReplaceSetAsync(
            string idPrefix, IEnumerable<ProtectedRecordWrite> records,
            CancellationToken cancellationToken = default) =>
            inner.ReplaceSetAsync(idPrefix, records, cancellationToken);
        public Task<ProtectedStorageUsage> MeasureUsageAsync(CancellationToken cancellationToken = default) =>
            inner.MeasureUsageAsync(cancellationToken);
        public Task<IReadOnlyList<ProtectedRecordId>> ListOldestAsync(
            IReadOnlyCollection<string> recordKinds, int limit,
            CancellationToken cancellationToken = default) =>
            inner.ListOldestAsync(recordKinds, limit, cancellationToken);
        public Task<int> PruneExpiredAsync(CancellationToken cancellationToken = default) =>
            inner.PruneExpiredAsync(cancellationToken);
    }
}
