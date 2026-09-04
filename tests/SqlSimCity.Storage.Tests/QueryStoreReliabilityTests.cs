using System.Numerics;
using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Storage;
using SqlSimCity.Storage.Sqlite;

namespace SqlSimCity.Storage.Tests;

public sealed class QueryStoreReliabilityTests : IDisposable
{
    private static readonly DateTimeOffset Now = new(2026, 9, 4, 12, 0, 0, TimeSpan.Zero);
    private readonly string _directory = Path.Combine(
        AppContext.BaseDirectory, "query-store-reliability", Guid.NewGuid().ToString("N"));
    private readonly TestTimeProvider _clock = new(Now);

    public void Dispose() => Directory.Delete(_directory, recursive: true);

    [Theory]
    [InlineData(QueryStoreCollectionState.Error, DataStatus.Stale, false)]
    [InlineData(QueryStoreCollectionState.Error, DataStatus.Stale, true)]
    [InlineData(QueryStoreCollectionState.Off, DataStatus.Disabled, false)]
    [InlineData(QueryStoreCollectionState.PermissionDenied, DataStatus.PermissionDenied, false)]
    [InlineData(QueryStoreCollectionState.Unsupported, DataStatus.Unsupported, false)]
    [InlineData(QueryStoreCollectionState.Unknown, DataStatus.Unknown, false)]
    public async Task FailedCyclesAndRestartNeverRenewRetainedObservations(
        QueryStoreCollectionState failure, DataStatus expected, bool healthySibling)
    {
        var source = new ReliabilitySource(_clock);
        using (var store = await OpenStoreAsync())
            await CollectAsync(new ProtectedQueryStoreRepository(store), source);

        source.States["db"] = failure;
        source.States["sibling"] = healthySibling ? QueryStoreCollectionState.ReadWrite : failure;
        for (var cycle = 0; cycle < 2; cycle++)
        {
            _clock.Advance(TimeSpan.FromMinutes(5));
            using var store = await OpenStoreAsync();
            var repository = new ProtectedQueryStoreRepository(store);
            await CollectAsync(repository, source);
            var snapshot = (await repository.ReadPublishedSnapshotAsync())!;
            Assert.Equal(_clock.GetUtcNow(), snapshot.PublishedAt);
            var failed = snapshot.Families.Single(item => item.Family.DatabaseId == "db");
            AssertEvidence(failed.Family.Evidence, Now, expected);
            Assert.All(failed.Runtime, bucket => AssertEvidence(bucket.Evidence, Now, expected));
            Assert.Equal(Now, snapshot.Status.Databases.Single(item => item.DatabaseId == "db").CollectedThrough);
            Assert.Equal("7", failed.Family.ExecutionCount);
            var sibling = snapshot.Families.Single(item => item.Family.DatabaseId == "sibling");
            AssertEvidence(sibling.Family.Evidence, healthySibling ? _clock.GetUtcNow() : Now,
                healthySibling ? DataStatus.Available : expected);

            // A publication without any observation must also preserve the restored attempt.
            var restarted = new ProtectedQueryStoreHistorySink(repository, new QueryStoreCollectionStatusTracker());
            await restarted.PublishAsync(new(false, _clock.GetUtcNow(), _clock.GetUtcNow(), []), default);
            var republished = (await repository.ReadPublishedSnapshotAsync())!;
            AssertEvidence(republished.Families.Single(item => item.Family.DatabaseId == "db").Family.Evidence,
                Now, expected);
        }

        _clock.Advance(TimeSpan.FromMinutes(5));
        source.States.Clear();
        using (var store = await OpenStoreAsync())
        {
            var repository = new ProtectedQueryStoreRepository(store);
            await CollectAsync(repository, source);
            var recovered = (await repository.ReadPublishedSnapshotAsync())!.Families
                .Single(item => item.Family.DatabaseId == "db");
            AssertEvidence(recovered.Family.Evidence, _clock.GetUtcNow(), DataStatus.Available);
            AssertEvidence(recovered.Runtime.Single(bucket => bucket.IntervalId == "old").Evidence,
                Now, DataStatus.Stale);
            AssertEvidence(recovered.Runtime.Single(bucket => bucket.IntervalId == "recent").Evidence,
                _clock.GetUtcNow(), DataStatus.Available);
        }
    }

    [Fact]
    public async Task LegacyPublicationTimestampIsUnknownRatherThanClaimedAsAnObservation()
    {
        using var store = await OpenStoreAsync();
        var repository = new ProtectedQueryStoreRepository(store);
        await CollectAsync(repository, new ReliabilitySource(_clock));
        var snapshot = (await repository.ReadPublishedSnapshotAsync())!;
        await repository.PublishSnapshotAsync(snapshot with { DatabaseObservations = null });
        _clock.Advance(TimeSpan.FromMinutes(5));
        var sink = new ProtectedQueryStoreHistorySink(repository, new QueryStoreCollectionStatusTracker());
        await sink.PublishAsync(new(false, _clock.GetUtcNow(), _clock.GetUtcNow(), []), default);

        var restored = (await repository.ReadPublishedSnapshotAsync())!;
        Assert.All(restored.Families, family =>
        {
            AssertEvidence(family.Family.Evidence, null, DataStatus.Unknown);
            Assert.All(family.Runtime, bucket => AssertEvidence(bucket.Evidence, null, DataStatus.Unknown));
        });
    }

    [Fact]
    public async Task CancellationDoesNotPublishOrRenewThePriorGeneration()
    {
        using var store = await OpenStoreAsync();
        var repository = new ProtectedQueryStoreRepository(store);
        var source = new ReliabilitySource(_clock);
        await CollectAsync(repository, source);
        var before = (await repository.ReadPublishedSnapshotAsync())!;
        _clock.Advance(TimeSpan.FromMinutes(5));
        using var cancellation = new CancellationTokenSource();
        source.CancelOnRuntime = cancellation.Cancel;
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            CollectAsync(repository, source, cancellation.Token));
        var after = (await repository.ReadPublishedSnapshotAsync())!;
        Assert.Equal(before.SnapshotId, after.SnapshotId);
        Assert.All(after.Families, family => AssertEvidence(family.Family.Evidence, Now, DataStatus.Available));
    }

    private static void AssertEvidence(QueryStoreEvidenceV1 evidence, DateTimeOffset? observed, DataStatus status)
    {
        Assert.Equal(observed, evidence.ObservedAt);
        Assert.Equal(observed?.AddMinutes(3), evidence.FreshUntil);
        Assert.Equal(status, evidence.Status);
    }

    private async Task<SqliteProtectedRecordStore> OpenStoreAsync()
    {
        Directory.CreateDirectory(_directory);
        var store = new SqliteProtectedRecordStore(_directory, "history.db", new RetentionOptions(), _clock);
        await store.EnsureReadyAsync();
        return store;
    }

    private async Task CollectAsync(
        ProtectedQueryStoreRepository repository, ReliabilitySource source, CancellationToken token = default)
    {
        using var collector = new IncrementalQueryStoreCollector(
            source, new ProtectedQueryStoreHistorySink(repository, new QueryStoreCollectionStatusTracker()),
            new QueryStoreCollectionOptions(DatabaseConcurrency: 1,
                InitialLookback: TimeSpan.FromHours(6), BackfillHorizon: TimeSpan.FromHours(6)), _clock);
        await collector.CollectAsync(["db", "sibling"], _clock.GetUtcNow(), token);
    }

    private sealed class ReliabilitySource(TimeProvider clock) : IQueryStoreIncrementalSource
    {
        public Dictionary<string, QueryStoreCollectionState> States { get; } = [];
        public Action? CancelOnRuntime { get; set; }

        public Task<IReadOnlyList<string>> DiscoverDatabasesAsync(CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<string>>(["db", "sibling"]);

        public Task<QueryStoreDatabaseState> GetStateAsync(string databaseId, CancellationToken cancellationToken) =>
            Task.FromResult(new QueryStoreDatabaseState(databaseId,
                States.GetValueOrDefault(databaseId) is QueryStoreCollectionState.Error
                    ? QueryStoreCollectionState.ReadWrite : States.GetValueOrDefault(databaseId),
                "source", Now.AddHours(-12), clock.GetUtcNow(), "source state",
                16, 160, false, false, false, false));

        public Task<QueryStoreFactPage> ReadPageAsync(
            string databaseId, QueryStoreFactKind kind, DateTimeOffset startInclusive,
            DateTimeOffset endExclusive, string? pageToken, int pageSize, CancellationToken cancellationToken)
        {
            if (kind == QueryStoreFactKind.Runtime)
            {
                CancelOnRuntime?.Invoke();
                cancellationToken.ThrowIfCancellationRequested();
                if (States.GetValueOrDefault(databaseId) == QueryStoreCollectionState.Error)
                    throw new IOException("transient runtime read failure");
            }
            QueryStoreCollectedFact[] facts = kind switch
            {
                QueryStoreFactKind.Identity => [new QueryIdentityFact(
                    "query", "text", "context", "hash", clock.GetUtcNow(), false, true, null, null, null, null)],
                QueryStoreFactKind.Plan => [new QueryPlanFact(
                    "42", "query", "plan-hash", QueryPlanType.Compiled, null, false, null,
                    BigInteger.Zero, null, "16", "160", clock.GetUtcNow())],
                QueryStoreFactKind.Runtime =>
                    new[] { Runtime("old", Now.AddHours(-4), 3), Runtime("recent", Now.AddMinutes(-10), 4) }
                        .Where(row => row.Value.IntervalEnd > startInclusive && row.Value.IntervalStart < endExclusive)
                        .Cast<QueryStoreCollectedFact>().ToArray(),
                _ => [],
            };
            return Task.FromResult(new QueryStoreFactPage(kind, facts, null, false));
        }

        private static QueryRuntimeFact Runtime(string id, DateTimeOffset start, int count) =>
            new(new RuntimeStatInput("42", id, start, start.AddMinutes(5),
                QueryStoreExecutionType.Regular, "primary", count, 2, 1, 1));

        public Task<QueryTextPayload> ReadQueryTextAsync(
            string databaseId, string queryTextId, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<string?> ReadPlanXmlAsync(
            string databaseId, string planId, CancellationToken cancellationToken) => throw new NotSupportedException();
    }
}
