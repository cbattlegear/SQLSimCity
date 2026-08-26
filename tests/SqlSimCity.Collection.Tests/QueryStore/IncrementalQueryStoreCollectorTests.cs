using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Tests.QueryStore;

public sealed class IncrementalQueryStoreCollectorTests
{
    private static readonly DateTimeOffset Through = new(2026, 8, 17, 18, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task ReadsEveryKeysetPageAndPublishesWatermarkOnlyAfterCommit()
    {
        var source = new FakeSource();
        source.Pages[(QueryStoreFactKind.Identity, null)] = Page(QueryStoreFactKind.Identity, "next");
        source.Pages[(QueryStoreFactKind.Identity, "next")] = Page(QueryStoreFactKind.Identity, null);
        var sink = new FakeSink();
        using var collector = new IncrementalQueryStoreCollector(
            source, sink, new QueryStoreCollectionOptions(PageSize: 1, DatabaseConcurrency: 1));

        var result = await collector.CollectAsync(["db"], Through);

        Assert.Equal(4, result.Databases[0].PageCount);
        Assert.Equal(Through, sink.Watermark?.Through);
        Assert.True(sink.Published);
        Assert.False(sink.Aborted);
        Assert.Equal(["db"], result.RequestedDatabaseIds);
    }

    [Fact]
    public async Task PageFailureAbortsWithoutAdvancingWatermark()
    {
        var source = new FakeSource { FailKind = QueryStoreFactKind.Runtime };
        var prior = new QueryStoreWatermark("db", "signature", "epoch", Through.AddHours(-2),
            new Dictionary<QueryStoreFactKind, string?>());
        var sink = new FakeSink { Watermark = prior };
        using var collector = new IncrementalQueryStoreCollector(
            source, sink, new QueryStoreCollectionOptions(DatabaseConcurrency: 1));

        var result = await collector.CollectAsync(["db"], Through);

        Assert.Equal(nameof(InvalidOperationException), result.Databases[0].FailureType);
        Assert.Same(prior, sink.Watermark);
        Assert.True(sink.Aborted);
        Assert.False(sink.Committed);
    }

    [Fact]
    public async Task RetentionGapStartsNewEpochAtOldestAvailableInterval()
    {
        var oldest = Through.AddHours(-1);
        var source = new FakeSource { State = State(oldest) };
        var sink = new FakeSink
        {
            Watermark = new QueryStoreWatermark(
                "db", "signature", "epoch", Through.AddHours(-2), new Dictionary<QueryStoreFactKind, string?>()),
        };
        using var collector = new IncrementalQueryStoreCollector(
            source, sink, new QueryStoreCollectionOptions(DatabaseConcurrency: 1));

        var result = await collector.CollectAsync(["db"], Through);

        Assert.True(result.Databases[0].ResetDetected);
        Assert.All(source.Starts, start => Assert.Equal(oldest, start));
        Assert.True(sink.ResetDetected);
    }

    [Fact]
    public async Task IntervalIdRollbackDetectsClearAfterAnEmptyPeriod()
    {
        var source = new FakeSource
        {
            State = State() with { LatestIntervalId = 2 },
        };
        var sink = new FakeSink
        {
            Watermark = new QueryStoreWatermark(
                "db", "signature", "epoch", Through.AddMinutes(-1),
                new Dictionary<QueryStoreFactKind, string?>(), LatestIntervalId: 500),
        };
        using var collector = new IncrementalQueryStoreCollector(
            source, sink, new QueryStoreCollectionOptions(DatabaseConcurrency: 1));

        var result = await collector.CollectAsync(["db"], Through);

        Assert.True(result.Databases[0].ResetDetected);
        Assert.Equal(2, sink.Watermark?.LatestIntervalId);
    }

    [Fact]
    public async Task RepeatedResetsCreateDistinctPersistedEpochs()
    {
        var source = new FakeSource { State = State() with { LatestIntervalId = 2 } };
        var sink = new FakeSink
        {
            Watermark = new QueryStoreWatermark(
                "db", "epoch", "prior", Through.AddMinutes(-1),
                new Dictionary<QueryStoreFactKind, string?>(), 500),
        };
        using var collector = new IncrementalQueryStoreCollector(
            source, sink, new QueryStoreCollectionOptions(DatabaseConcurrency: 1));

        await collector.CollectAsync(["db"], Through);
        source.State = State() with { LatestIntervalId = 1 };
        await collector.CollectAsync(["db"], Through.AddMinutes(1));

        Assert.Equal(2, sink.StorageEpochs.Count);
        Assert.NotEqual(sink.StorageEpochs[0], sink.StorageEpochs[1]);
    }

    [Fact]
    public async Task ConcurrentCycleIsSkippedRatherThanOverlapping()
    {
        var source = new FakeSource { BlockState = true };
        var sink = new FakeSink();
        using var collector = new IncrementalQueryStoreCollector(
            source, sink, new QueryStoreCollectionOptions(DatabaseConcurrency: 1));
        var first = collector.CollectAsync(["db"], Through);
        await source.StateEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));

        var second = await collector.CollectAsync(["db"], Through);
        source.ReleaseState.TrySetResult();
        await first;

        Assert.True(second.SkippedBecauseCycleActive);
    }

    [Fact]
    public async Task MixedRuntimePageMarksOnlyCurrentIntervalActive()
    {
        var source = new FakeSource();
        source.Pages[(QueryStoreFactKind.Runtime, null)] = new QueryStoreFactPage(
            QueryStoreFactKind.Runtime,
            [
                new QueryRuntimeFact(Runtime("closed", Through.AddHours(-2), Through.AddHours(-1))),
                new QueryRuntimeFact(Runtime("active", Through.AddHours(-1), Through.AddMinutes(10))),
            ], null, true);
        var sink = new FakeSink();
        using var collector = new IncrementalQueryStoreCollector(
            source, sink, new QueryStoreCollectionOptions(DatabaseConcurrency: 1));

        await collector.CollectAsync(["db"], Through);

        Assert.Equal(["closed"], sink.ClosedBuckets.Select(bucket => bucket.Key.IntervalId));
        Assert.Equal(["active"], sink.ActiveBuckets.Select(bucket => bucket.Key.IntervalId));
    }

    [Fact]
    public async Task ReadCaptureSecondaryIsCollectedWhileUnknownIsNotZero()
    {
        var readable = new FakeSource
        {
            State = State() with { State = QueryStoreCollectionState.ReadCaptureSecondary },
        };
        var readableSink = new FakeSink();
        using var readableCollector = new IncrementalQueryStoreCollector(
            readable, readableSink, new QueryStoreCollectionOptions(DatabaseConcurrency: 1));
        var readableResult = await readableCollector.CollectAsync(["db"], Through);

        var unknown = new FakeSource
        {
            State = State() with { State = QueryStoreCollectionState.Unknown },
        };
        var unknownSink = new FakeSink();
        using var unknownCollector = new IncrementalQueryStoreCollector(
            unknown, unknownSink, new QueryStoreCollectionOptions(DatabaseConcurrency: 1));
        var unknownResult = await unknownCollector.CollectAsync(["db"], Through);

        Assert.True(readableResult.Databases[0].PageCount > 0);
        Assert.Equal(QueryStoreCollectionState.Unknown, unknownResult.Databases[0].State);
        Assert.Equal(0, unknownResult.Databases[0].PageCount);
    }

    [Fact]
    public async Task SystemDatabasesAreExcludedFromAnExplicitCollectionList()
    {
        var source = new FakeSource();
        var sink = new FakeSink();
        using var collector = new IncrementalQueryStoreCollector(
            source, sink, new QueryStoreCollectionOptions(DatabaseConcurrency: 1));

        var result = await collector.CollectAsync(
            ["master", "sales", "tempdb", "msdb", "model"], Through);

        Assert.Equal(["sales"], result.RequestedDatabaseIds);
        Assert.Equal(["sales"], result.Databases.Select(database => database.DatabaseId));
        Assert.Equal(["sales"], source.StateRequests);
    }

    [Fact]
    public async Task SystemDatabasesAreExcludedFromDiscovery()
    {
        var source = new FakeSource { DiscoveredDatabases = ["MSDB", " master ", "sales"] };
        var sink = new FakeSink();
        using var collector = new IncrementalQueryStoreCollector(
            source, sink, new QueryStoreCollectionOptions(DatabaseConcurrency: 1));

        var result = await collector.CollectAsync(null, Through);

        Assert.Equal(["sales"], result.Databases.Select(database => database.DatabaseId));
    }

    [Fact]
    public async Task AnExplicitSystemOnlyListCollectsNothingRatherThanFallingBackToDiscovery()
    {
        var source = new FakeSource();
        var sink = new FakeSink();
        using var collector = new IncrementalQueryStoreCollector(
            source, sink, new QueryStoreCollectionOptions(DatabaseConcurrency: 1));

        var result = await collector.CollectAsync(["master", "tempdb"], Through);

        Assert.Empty(result.RequestedDatabaseIds!);
        Assert.Empty(result.Databases);
        Assert.Empty(source.StateRequests);
        Assert.True(sink.Published);
    }

    [Fact]
    public async Task FirstCycleStartsAtTheRetainedHorizonRatherThanTheSourcesOldestInterval()
    {
        var source = new FakeSource { State = State(Through.AddDays(-400)) };
        var sink = new FakeSink();
        using var collector = new IncrementalQueryStoreCollector(
            source, sink, new QueryStoreCollectionOptions(DatabaseConcurrency: 1));

        await collector.CollectAsync(["db"], Through);

        Assert.NotEmpty(source.Starts);
        Assert.All(source.Starts, start => Assert.Equal(Through - QueryStoreRetention.History, start));
    }

    [Fact]
    public async Task FirstCycleDoesNotReachPastWhatTheSourceStillRetains()
    {
        var oldest = Through.AddDays(-3);
        var source = new FakeSource { State = State(oldest) };
        var sink = new FakeSink();
        using var collector = new IncrementalQueryStoreCollector(
            source, sink, new QueryStoreCollectionOptions(DatabaseConcurrency: 1));

        await collector.CollectAsync(["db"], Through);

        Assert.All(source.Starts, start => Assert.Equal(oldest, start));
    }

    [Fact]
    public async Task ResetCycleIsBoundedByTheSameHorizonAsTheFirstCycle()
    {
        var source = new FakeSource { State = State(Through.AddDays(-400)) };
        var sink = new FakeSink
        {
            Watermark = new QueryStoreWatermark(
                "db", "other-signature", "epoch", Through.AddHours(-2),
                new Dictionary<QueryStoreFactKind, string?>()),
        };
        using var collector = new IncrementalQueryStoreCollector(
            source, sink, new QueryStoreCollectionOptions(DatabaseConcurrency: 1));

        var result = await collector.CollectAsync(["db"], Through);

        Assert.True(result.Databases[0].ResetDetected);
        Assert.All(source.Starts, start => Assert.Equal(Through - QueryStoreRetention.History, start));
    }

    [Fact]
    public async Task ConfiguredInitialLookbackBoundsTheFirstCycle()
    {
        var source = new FakeSource { State = State(Through.AddDays(-400)) };
        var sink = new FakeSink();
        using var collector = new IncrementalQueryStoreCollector(
            source, sink,
            new QueryStoreCollectionOptions(
                DatabaseConcurrency: 1, InitialLookback: TimeSpan.FromDays(2)));

        await collector.CollectAsync(["db"], Through);

        Assert.All(source.Starts, start => Assert.Equal(Through.AddDays(-2), start));
    }

    [Theory]
    [InlineData(91)]
    [InlineData(0)]
    public void InitialLookbackBeyondTheRetainedHorizonOrInsideTheOverlapIsRejected(int days)
    {
        var options = new QueryStoreCollectionOptions(InitialLookback: TimeSpan.FromDays(days));

        Assert.Throws<ArgumentOutOfRangeException>(options.Validate);
    }

    private static QueryStoreFactPage Page(QueryStoreFactKind kind, string? next) =>
        new(kind, [], next, false);

    private static QueryStoreDatabaseState State(DateTimeOffset? oldest = null) =>
        new("db", QueryStoreCollectionState.ReadWrite, "epoch", oldest, Through,
            "available", 16, 160, false, false, false, false);

    private static RuntimeStatInput Runtime(
        string intervalId, DateTimeOffset start, DateTimeOffset end) =>
        new("plan", intervalId, start, end, QueryStoreExecutionType.Regular, "primary",
            1, 1, 1, 1);

    private sealed class FakeSource : IQueryStoreIncrementalSource
    {
        public Dictionary<(QueryStoreFactKind, string?), QueryStoreFactPage> Pages { get; } = [];
        public List<DateTimeOffset> Starts { get; } = [];
        public List<string> StateRequests { get; } = [];
        public IReadOnlyList<string> DiscoveredDatabases { get; init; } = ["db"];
        public QueryStoreFactKind? FailKind { get; init; }
        public QueryStoreDatabaseState State { get; set; } = IncrementalQueryStoreCollectorTests.State();
        public bool BlockState { get; init; }
        public TaskCompletionSource StateEntered { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource ReleaseState { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task<IReadOnlyList<string>> DiscoverDatabasesAsync(CancellationToken cancellationToken) =>
            Task.FromResult(DiscoveredDatabases);

        public async Task<QueryStoreDatabaseState> GetStateAsync(
            string databaseId, CancellationToken cancellationToken)
        {
            lock (StateRequests) StateRequests.Add(databaseId);
            StateEntered.TrySetResult();
            if (BlockState) await ReleaseState.Task.WaitAsync(cancellationToken);
            return State;
        }

        public Task<QueryStoreFactPage> ReadPageAsync(
            string databaseId, QueryStoreFactKind kind, DateTimeOffset startInclusive,
            DateTimeOffset endExclusive, string? pageToken, int pageSize,
            CancellationToken cancellationToken)
        {
            Starts.Add(startInclusive);
            if (kind == FailKind) throw new InvalidOperationException("synthetic page failure");
            return Task.FromResult(Pages.GetValueOrDefault((kind, pageToken)) ?? Page(kind, null));
        }

        public Task<QueryTextPayload> ReadQueryTextAsync(
            string databaseId, string queryTextId, CancellationToken cancellationToken) =>
            Task.FromResult(new QueryTextPayload(null, false, false));

        public Task<string?> ReadPlanXmlAsync(
            string databaseId, string planId, CancellationToken cancellationToken) =>
            Task.FromResult<string?>(null);
    }

    private sealed class FakeSink : IQueryStoreHistorySink
    {
        public QueryStoreWatermark? Watermark { get; set; }
        public bool ResetDetected { get; private set; }
        public bool Committed { get; private set; }
        public bool Aborted { get; private set; }
        public bool Published { get; private set; }
        public List<string> StorageEpochs { get; } = [];
        public List<AggregatedRuntimeBucket> ActiveBuckets { get; } = [];
        public List<AggregatedRuntimeBucket> ClosedBuckets { get; } = [];

        public Task<QueryStoreWatermark?> GetWatermarkAsync(string databaseId, CancellationToken cancellationToken) =>
            Task.FromResult(Watermark);
        public Task BeginDatabaseCycleAsync(
            QueryStoreDatabaseState state, string storageEpoch, bool resetDetected,
            CancellationToken cancellationToken)
        {
            ResetDetected = resetDetected;
            StorageEpochs.Add(storageEpoch);
            return Task.CompletedTask;
        }
        public Task StageFactsAsync(
            string databaseId, QueryStoreFactPage page, CancellationToken cancellationToken) =>
            Task.CompletedTask;
        public Task StageRuntimeBucketsAsync(
            string databaseId, IReadOnlyList<AggregatedRuntimeBucket> buckets,
            bool activeInterval, CancellationToken cancellationToken)
        {
            (activeInterval ? ActiveBuckets : ClosedBuckets).AddRange(buckets);
            return Task.CompletedTask;
        }
        public Task CommitDatabaseCycleAsync(
            QueryStoreDatabaseState state, QueryStoreWatermark watermark,
            CancellationToken cancellationToken)
        {
            Watermark = watermark;
            Committed = true;
            return Task.CompletedTask;
        }
        public Task AbortDatabaseCycleAsync(string databaseId, CancellationToken cancellationToken)
        {
            Aborted = true;
            return Task.CompletedTask;
        }
        public Task PublishAsync(QueryStoreCollectionResult result, CancellationToken cancellationToken)
        {
            Published = true;
            return Task.CompletedTask;
        }
    }
}
