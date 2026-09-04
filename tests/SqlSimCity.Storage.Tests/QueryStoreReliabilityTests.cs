using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SqlSimCity.Collection.Probes;
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

    [Theory]
    [InlineData(QueryStoreCollectionState.ReadWrite, DataStatus.Unknown)]
    [InlineData(QueryStoreCollectionState.Off, DataStatus.Disabled)]
    [InlineData(QueryStoreCollectionState.PermissionDenied, DataStatus.PermissionDenied)]
    [InlineData(QueryStoreCollectionState.Unsupported, DataStatus.Unsupported)]
    public async Task LegacyPublicationTimestampIsUnknownRatherThanClaimedAsAnObservation(
        QueryStoreCollectionState attempt, DataStatus expected)
    {
        using var store = await OpenStoreAsync();
        var repository = new ProtectedQueryStoreRepository(store);
        var source = new ReliabilitySource(_clock);
        await CollectAsync(repository, source);
        source.States["db"] = attempt;
        source.States["sibling"] = attempt;
        await CollectAsync(repository, source);
        var snapshot = (await repository.ReadPublishedSnapshotAsync())!;
        await repository.PublishSnapshotAsync(snapshot with { DatabaseObservations = null });
        _clock.Advance(TimeSpan.FromMinutes(5));
        var sink = new ProtectedQueryStoreHistorySink(repository, new QueryStoreCollectionStatusTracker());
        await sink.PublishAsync(new(false, _clock.GetUtcNow(), _clock.GetUtcNow(), []), default);

        var restored = (await repository.ReadPublishedSnapshotAsync())!;
        Assert.All(restored.Families, family =>
        {
            AssertEvidence(family.Family.Evidence, null, expected);
            Assert.All(family.Runtime, bucket => AssertEvidence(bucket.Evidence, null, expected));
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

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task WaitIdentitySurvivesRestartWithoutRecollectingHistoricalIntervals(bool hourly, bool legacy)
    {
        var retention = new QueryStoreRetentionOptions(Detail: TimeSpan.FromHours(hourly ? 1 : 24));
        QueryStorePublishedSnapshot before;
        using (var store = await OpenStoreAsync())
        {
            var repository = new ProtectedQueryStoreRepository(store);
            var sink = new ProtectedQueryStoreHistorySink(repository, new QueryStoreCollectionStatusTracker(),
                retention: retention);
            await StageWaitHistoryAsync(sink, "epoch:1", false, true);
            await StageWaitHistoryAsync(sink, "epoch:2", true, true);
            before = (await repository.ReadPublishedSnapshotAsync())!;
            Assert.Equal(2, before.Families.Count);
            Assert.All(before.Families, family =>
            {
                Assert.Equal("252", family.Family.TotalWaitMilliseconds);
                Assert.Equal(hourly ? 24 : 36, family.Runtime.Count);
                Assert.All(family.Runtime, bucket => Assert.Equal(3, bucket.WaitMilliseconds.Count));
            });
            if (legacy)
                await repository.PublishSnapshotAsync(before with { DatabaseObservations = null });
        }

        using (var store = await OpenStoreAsync())
        {
            var repository = new ProtectedQueryStoreRepository(store);
            var sink = new ProtectedQueryStoreHistorySink(repository, new QueryStoreCollectionStatusTracker(),
                retention: retention);
            // No old runtime or wait facts are supplied. Begin still prunes restored wait keys.
            await StageWaitHistoryAsync(sink, "epoch:2", false, false);
            var after = (await repository.ReadPublishedSnapshotAsync())!;
            Assert.Equal(WaitSignature(before), WaitSignature(after));

            // Replaying recent facts with real catalog category IDs replaces, not adds to,
            // the category-name identity restored from the published contract.
            await StageWaitHistoryAsync(sink, "epoch:2", false, true, recentOnly: true);
            Assert.Equal(WaitSignature(before), WaitSignature((await repository.ReadPublishedSnapshotAsync())!));
        }
    }

    [Fact]
    public async Task TransientTextRetrySurvivesRestartAndRecoversWithoutClearingStorage()
    {
        var source = new ReliabilitySource(_clock)
        {
            TextFailure = new ProbeTransientConnectionException("connection reset", 10054, 20),
        };
        string familyId;
        using (var store = await OpenStoreAsync())
        {
            var repository = new ProtectedQueryStoreRepository(store);
            familyId = await PrepareTextFamilyAsync(repository, source);
            using var history = History(repository, source);
            var results = await Task.WhenAll(Enumerable.Range(0, 12).Select(_ => history.GetFamilyAsync(familyId, default)));
            Assert.All(results, family => Assert.Equal(QueryTextAvailability.Missing, family!.Family.Text.Availability));
            Assert.Equal(1, source.TextReads);
            Assert.Null(await repository.ReadTextDescriptorAsync("db", "text"));
        }
        using (var store = await OpenStoreAsync())
        {
            var repository = new ProtectedQueryStoreRepository(store);
            using var history = History(repository, source);
            source.TextFailure = null;
            _clock.Advance(TimeSpan.FromSeconds(59));
            Assert.Equal(QueryTextAvailability.Missing, (await history.GetFamilyAsync(familyId, default))!.Family.Text.Availability);
            Assert.Equal(1, source.TextReads);
            _clock.Advance(TimeSpan.FromSeconds(1));
            Assert.Equal(QueryTextAvailability.Available, (await history.GetFamilyAsync(familyId, default))!.Family.Text.Availability);
            Assert.Equal(2, source.TextReads);
            Assert.Null(await repository.ReadTextRetryAsync("db", "text"));
            _clock.Advance(TimeSpan.FromHours(1));
            await history.GetFamilyAsync(familyId, default);
            Assert.Equal(2, source.TextReads);
        }
    }

    [Fact]
    public async Task LegacyTransientDescriptorIdDoesNotSuppressRecovery()
    {
        using var store = await OpenStoreAsync();
        var repository = new ProtectedQueryStoreRepository(store);
        var source = new ReliabilitySource(_clock);
        var familyId = await PrepareTextFamilyAsync(repository, source);
        const string legacyKind = "query-store-text-descriptor-v2";
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes($"{legacyKind}\ndb\ntext"));
        await store.PutAsync(new($"qs:{Convert.ToHexString(hash).ToLowerInvariant()}"), legacyKind, Now,
            StorageResolution.Detail, JsonSerializer.SerializeToUtf8Bytes(new QueryTextDescriptorV1(
                QueryTextAvailability.Missing, null, null, "Query Store text is unavailable from the connected source.")));
        using var history = History(repository, source);

        var family = await history.GetFamilyAsync(familyId, default);

        Assert.Equal(QueryTextAvailability.Available, family!.Family.Text.Availability);
        Assert.Equal(1, source.TextReads);
        Assert.True((await store.MeasureUsageAsync()).StoredBytesForKinds(
            ProtectedQueryStoreRepository.PlanCacheRecordKinds) > 0);
        Assert.Contains(legacyKind, ProtectedQueryStoreRepository.PlanCacheRecordKinds);
    }

    [Theory]
    [InlineData("missing", QueryTextAvailability.Missing)]
    [InlineData("permission", QueryTextAvailability.Restricted)]
    [InlineData("unsupported", QueryTextAvailability.Missing)]
    public async Task TerminalTextOutcomesRemainCached(string outcome, QueryTextAvailability expected)
    {
        using var store = await OpenStoreAsync();
        var repository = new ProtectedQueryStoreRepository(store);
        var source = new ReliabilitySource(_clock)
        {
            Text = outcome == "missing" ? null : "SELECT 1",
            TextFailure = outcome switch
            {
                "permission" => new ProbePermissionDeniedException("denied", 297, 14),
                "unsupported" => new ProbeObjectUnavailableException("unsupported", 208, 16),
                _ => null,
            },
        };
        var familyId = await PrepareTextFamilyAsync(repository, source);
        using var history = History(repository, source);
        Assert.Equal(expected, (await history.GetFamilyAsync(familyId, default))!.Family.Text.Availability);
        _clock.Advance(TimeSpan.FromHours(1));
        source.TextFailure = null;
        source.Text = "SELECT 1";
        Assert.Equal(expected, (await history.GetFamilyAsync(familyId, default))!.Family.Text.Availability);
        Assert.Equal(1, source.TextReads);
    }

    private ConnectedQueryStoreHistorySource History(ProtectedQueryStoreRepository repository, ReliabilitySource source) =>
        new(repository, source, new SecureShowplanParser(), new QueryStoreCollectionStatusTracker(), _clock);

    private async Task<string> PrepareTextFamilyAsync(ProtectedQueryStoreRepository repository, ReliabilitySource source)
    {
        await CollectAsync(repository, source);
        var snapshot = (await repository.ReadPublishedSnapshotAsync())!;
        var missing = new QueryTextDescriptorV1(QueryTextAvailability.Missing, null, null, "not requested");
        var family = snapshot.Families.Single(item => item.Family.DatabaseId == "db");
        family = family with { Family = family.Family with
        {
            Text = missing,
            PhysicalQueries = family.Family.PhysicalQueries.Select(identity => identity with { Text = missing }).ToArray(),
        }};
        await repository.PublishSnapshotAsync(snapshot with { Families = [family] });
        return family.Family.FamilyId;
    }

    [Fact]
    public async Task ArchivedDetailedIntervalsRollUpTogetherAfterRestart()
    {
        using (var store = await OpenStoreAsync())
        {
            var repository = new ProtectedQueryStoreRepository(store);
            var sink = new ProtectedQueryStoreHistorySink(repository, new QueryStoreCollectionStatusTracker());
            await StageWaitHistoryAsync(sink, "epoch:1", false, true);
            await StageWaitHistoryAsync(sink, "epoch:2", true, true);
        }
        using (var store = await OpenStoreAsync())
        {
            var repository = new ProtectedQueryStoreRepository(store);
            var sink = new ProtectedQueryStoreHistorySink(repository, new QueryStoreCollectionStatusTracker(),
                retention: new QueryStoreRetentionOptions(Detail: TimeSpan.FromHours(1)));
            await StageWaitHistoryAsync(sink, "epoch:2", false, false);
            var snapshot = (await repository.ReadPublishedSnapshotAsync())!;
            Assert.All(snapshot.Families, family =>
            {
                Assert.Equal("252", family.Family.TotalWaitMilliseconds);
                Assert.Equal(24, family.Runtime.Count);
                Assert.All(family.Runtime.Where(bucket => bucket.IntervalId.StartsWith("hour:", StringComparison.Ordinal)),
                    bucket =>
                    {
                        Assert.Equal("2", bucket.ExecutionCount);
                        Assert.Equal("2", bucket.WaitMilliseconds["CPU"]);
                        Assert.Equal("4", bucket.WaitMilliseconds["Lock"]);
                        Assert.Equal("8", bucket.WaitMilliseconds["Buffer IO"]);
                    });
            });
        }
    }

    [Fact]
    public async Task MalformedRestoredWaitTotalsFailExplicitly()
    {
        using var store = await OpenStoreAsync();
        var repository = new ProtectedQueryStoreRepository(store);
        var sink = new ProtectedQueryStoreHistorySink(repository, new QueryStoreCollectionStatusTracker());
        await StageWaitHistoryAsync(sink, "epoch:1", false, true);
        var snapshot = (await repository.ReadPublishedSnapshotAsync())!;
        var family = Assert.Single(snapshot.Families);
        await repository.PublishSnapshotAsync(snapshot with
        {
            Families = [family with
            {
                Runtime = [family.Runtime[0] with { WaitMilliseconds = new Dictionary<string, string> { ["CPU"] = "invalid" } }],
            }],
        });
        var restarted = new ProtectedQueryStoreHistorySink(repository, new QueryStoreCollectionStatusTracker());
        await Assert.ThrowsAsync<FormatException>(() =>
            restarted.PublishAsync(new(false, Now, Now, []), default));
        await repository.PublishSnapshotAsync(snapshot);
        await restarted.PublishAsync(new(false, Now, Now, []), default);
        Assert.Equal(WaitSignature(snapshot), WaitSignature((await repository.ReadPublishedSnapshotAsync())!));
    }

    private static string[] WaitSignature(QueryStorePublishedSnapshot snapshot) =>
        snapshot.Families.SelectMany(family => family.Runtime.Select(bucket =>
            $"{family.Family.FamilyId}|{bucket.EpochId}|{bucket.PlanId}|{bucket.IntervalId}|" +
            $"{bucket.IntervalStart:O}|{bucket.IntervalEnd:O}|{bucket.ExecutionType}|{bucket.ReplicaGroupId}|" +
            $"{bucket.ExecutionCount}|{string.Join(",", bucket.WaitMilliseconds.OrderBy(pair => pair.Key)
                .Select(pair => $"{pair.Key}={pair.Value}"))}"))
            .Order(StringComparer.Ordinal).ToArray();

    private static async Task StageWaitHistoryAsync(
        ProtectedQueryStoreHistorySink sink, string epoch, bool reset, bool supplyFacts, bool recentOnly = false)
    {
        var state = new QueryStoreDatabaseState(
            "db", QueryStoreCollectionState.ReadWrite, epoch, Now.AddHours(-12), Now,
            "available", 16, 160, true, false, true, false);
        await sink.BeginDatabaseCycleAsync(state, epoch, reset, default);
        if (supplyFacts)
        {
            await sink.StageFactsAsync("db", new(QueryStoreFactKind.Identity,
                [new QueryIdentityFact("q", "text", "ctx", "hash", Now, false, true, null, null, null, null)],
                null, false), default);
            foreach (var plan in new[] { "42", "43" })
            {
                await sink.StageFactsAsync("db", new(QueryStoreFactKind.Plan,
                    [new QueryPlanFact(plan, "q", "hash", QueryPlanType.Compiled, null, false, null,
                        BigInteger.Zero, null, "16", "160", Now)], null, false), default);
                foreach (var type in Enum.GetValues<QueryStoreExecutionType>())
                foreach (var replica in new[] { "primary", "replica:2" })
                foreach (var minute in recentOnly ? new[] { -10 } : new[] { -240, -230, -10 })
                {
                    var id = $"interval:{minute}";
                    var rows = QueryStoreRuntimeAggregator.Aggregate([new(
                        plan, id, Now.AddMinutes(minute), Now.AddMinutes(minute + 5),
                        type, replica, BigInteger.One, 1, 1, 1)]);
                    await sink.StageRuntimeBucketsAsync("db", rows, false, default);
                    await sink.StageFactsAsync("db", new(QueryStoreFactKind.Wait,
                    [
                        new QueryWaitFact(plan, id, type, replica, 1, "CPU", 1),
                        new QueryWaitFact(plan, id, type, replica, 3, "Lock", 2),
                        new QueryWaitFact(plan, id, type, replica, 6, "Buffer IO", 4),
                    ], null, false), default);
                }
            }
        }
        await sink.CommitDatabaseCycleAsync(state,
            new("db", epoch, epoch, Now, new Dictionary<QueryStoreFactKind, string?>()), default);
        await sink.PublishAsync(new(false, Now, Now,
            [new("db", QueryStoreCollectionState.ReadWrite, 1, 1, reset, "available", null)], ["db"]), default);
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
        public ProbeExecutionException? TextFailure { get; set; }
        public string? Text { get; set; } = "SELECT 1";
        public int TextReads { get; private set; }

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
            string databaseId, string queryTextId, CancellationToken cancellationToken)
        {
            TextReads++;
            if (TextFailure is { } failure) throw failure;
            return Task.FromResult(new QueryTextPayload(Text, false, false));
        }
        public Task<string?> ReadPlanXmlAsync(
            string databaseId, string planId, CancellationToken cancellationToken) => throw new NotSupportedException();
    }
}
