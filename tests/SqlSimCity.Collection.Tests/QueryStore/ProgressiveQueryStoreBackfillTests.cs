using System.Numerics;
using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Storage;

namespace SqlSimCity.Collection.Tests.QueryStore;

/// <summary>
/// The progressive backfill and the low watermark that makes it resumable.
///
/// The fake source here holds real runtime intervals across a span and answers a window with what
/// falls inside it, because the property that matters most is not how far the collector reaches but
/// that <c>OldestAvailableAt</c> keeps describing what was collected and retained rather than what
/// the backfill was aiming at.
/// </summary>
public sealed class ProgressiveQueryStoreBackfillTests
{
    private static readonly DateTimeOffset Through = new(2026, 8, 17, 18, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task ConfiguringNothingReadsForwardOnlyAndStillRecordsHowFarBackItReached()
    {
        var source = new WindowedSource();
        var sink = new RecordingSink();
        using var collector = new IncrementalQueryStoreCollector(
            source, sink, Options(initialLookback: TimeSpan.FromDays(2)));

        await collector.CollectAsync(["db"], Through);
        source.Windows.Clear();
        await collector.CollectAsync(["db"], Through.AddHours(1));

        Assert.All(source.Windows, window => Assert.Equal(
            Through - TimeSpan.FromMinutes(65), window.Start));
        // Recorded even with the backfill off, so switching it on later resumes from a real figure
        // instead of adopting whatever the forward window happened to be that cycle.
        Assert.Equal(Through.AddDays(-2), sink.Watermark?.BackfilledFrom);
    }

    [Fact]
    public async Task FirstCycleDoesNotBackfillBecauseItAlreadyReadsAFullLookback()
    {
        var source = new WindowedSource();
        var sink = new RecordingSink();
        using var collector = new IncrementalQueryStoreCollector(
            source, sink,
            Options(initialLookback: TimeSpan.FromDays(2), increment: TimeSpan.FromDays(5)));

        await collector.CollectAsync(["db"], Through);

        Assert.All(source.Windows, window => Assert.Equal(Through.AddDays(-2), window.Start));
        Assert.Equal(Through.AddDays(-2), sink.Watermark?.BackfilledFrom);
    }

    [Fact]
    public async Task EachCycleReachesOneBoundedIncrementFurtherBack()
    {
        var source = new WindowedSource();
        var sink = new RecordingSink();
        using var collector = new IncrementalQueryStoreCollector(
            source, sink,
            Options(initialLookback: TimeSpan.FromDays(2), increment: TimeSpan.FromDays(10)));

        var reached = new List<DateTimeOffset?>();
        for (var cycle = 0; cycle < 4; cycle++)
        {
            await collector.CollectAsync(["db"], Through.AddHours(cycle));
            reached.Add(sink.Watermark?.BackfilledFrom);
        }

        Assert.Equal(
            [Through.AddDays(-2), Through.AddDays(-12), Through.AddDays(-22), Through.AddDays(-32)],
            reached);
    }

    [Fact]
    public async Task ABackfillStepReadsOnlyItsOwnIncrementRatherThanEverythingBelowTheWatermark()
    {
        var source = new WindowedSource();
        var sink = new RecordingSink();
        using var collector = new IncrementalQueryStoreCollector(
            source, sink,
            Options(initialLookback: TimeSpan.FromDays(2), increment: TimeSpan.FromDays(10)));

        await collector.CollectAsync(["db"], Through);
        source.Windows.Clear();
        await collector.CollectAsync(["db"], Through);

        var backward = source.Windows.Where(window => window.End < Through).Distinct().ToArray();
        var step = Assert.Single(backward);
        Assert.Equal(Through.AddDays(-12), step.Start);
        Assert.Equal(Through.AddDays(-2), step.End);
    }

    [Fact]
    public async Task TheWalkStopsAtTheRetainedHorizonEvenThoughTheSourceHoldsMore()
    {
        // 120 days on the server, 90 days of retention here: the last 30 are evidence the first
        // prune would discard, which is exactly the reading #87 removed.
        var source = new WindowedSource { Oldest = Through.AddDays(-120) };
        var sink = new RecordingSink();
        using var collector = new IncrementalQueryStoreCollector(
            source, sink,
            Options(initialLookback: TimeSpan.FromDays(2), increment: TimeSpan.FromDays(30)));

        for (var cycle = 0; cycle < 8; cycle++) await collector.CollectAsync(["db"], Through);
        source.Windows.Clear();
        await collector.CollectAsync(["db"], Through);

        Assert.Equal(Through - QueryStoreRetention.History, sink.Watermark?.BackfilledFrom);
        Assert.All(source.Windows, window => Assert.Equal(Through, window.End));
    }

    [Fact]
    public async Task AShallowerBackfillHorizonIsHonouredAndTheWalkThenStops()
    {
        var source = new WindowedSource { Oldest = Through.AddDays(-120) };
        var sink = new RecordingSink();
        using var collector = new IncrementalQueryStoreCollector(
            source, sink,
            Options(
                initialLookback: TimeSpan.FromDays(2),
                increment: TimeSpan.FromDays(10),
                horizon: TimeSpan.FromDays(25)));

        for (var cycle = 0; cycle < 6; cycle++) await collector.CollectAsync(["db"], Through);

        Assert.Equal(Through.AddDays(-25), sink.Watermark?.BackfilledFrom);
    }

    [Fact]
    public async Task TheWalkStopsAtWhatTheSourceStillRetainsWhenThatIsShallowerThanTheHorizon()
    {
        var source = new WindowedSource { Oldest = Through.AddDays(-9) };
        var sink = new RecordingSink();
        using var collector = new IncrementalQueryStoreCollector(
            source, sink,
            Options(initialLookback: TimeSpan.FromDays(2), increment: TimeSpan.FromDays(5)));

        for (var cycle = 0; cycle < 5; cycle++) await collector.CollectAsync(["db"], Through);
        source.Windows.Clear();
        await collector.CollectAsync(["db"], Through);

        Assert.Equal(Through.AddDays(-9), sink.Watermark?.BackfilledFrom);
        Assert.DoesNotContain(source.Windows, window => window.Start < Through.AddDays(-9));
    }

    [Fact]
    public async Task AnInterruptedBackfillResumesTheSameStepInsteadOfRestartingTheWalk()
    {
        var source = new WindowedSource();
        var sink = new RecordingSink();
        using var collector = new IncrementalQueryStoreCollector(
            source, sink,
            Options(initialLookback: TimeSpan.FromDays(2), increment: TimeSpan.FromDays(10)));

        await collector.CollectAsync(["db"], Through);
        await collector.CollectAsync(["db"], Through);
        var beforeFailure = sink.Watermark;
        Assert.Equal(Through.AddDays(-12), beforeFailure?.BackfilledFrom);

        source.FailBelow = Through.AddDays(-12);
        var failed = await collector.CollectAsync(["db"], Through);
        Assert.Equal(nameof(InvalidOperationException), failed.Databases[0].FailureType);
        Assert.Same(beforeFailure, sink.Watermark);

        source.FailBelow = null;
        source.Windows.Clear();
        await collector.CollectAsync(["db"], Through);

        // Resumed at the interrupted step, not back at the initial lookback and not past it.
        var backward = source.Windows.Where(window => window.End < Through).Distinct().ToArray();
        var step = Assert.Single(backward);
        Assert.Equal((Through.AddDays(-22), Through.AddDays(-12)), (step.Start, step.End));
        Assert.Equal(Through.AddDays(-22), sink.Watermark?.BackfilledFrom);
    }

    [Fact]
    public async Task AResetRestartsTheLowWatermarkWithTheEpochRatherThanKeepingTheDiscardedReach()
    {
        var source = new WindowedSource();
        var sink = new RecordingSink();
        using var collector = new IncrementalQueryStoreCollector(
            source, sink,
            Options(initialLookback: TimeSpan.FromDays(2), increment: TimeSpan.FromDays(10)));

        await collector.CollectAsync(["db"], Through);
        await collector.CollectAsync(["db"], Through);
        Assert.Equal(Through.AddDays(-12), sink.Watermark?.BackfilledFrom);

        source.ResetEpoch = "cleared";
        source.Windows.Clear();
        var result = await collector.CollectAsync(["db"], Through);

        Assert.True(result.Databases[0].ResetDetected);
        Assert.Equal(Through.AddDays(-2), sink.Watermark?.BackfilledFrom);
        Assert.All(source.Windows, window => Assert.Equal(Through.AddDays(-2), window.Start));
    }

    [Fact]
    public async Task AWatermarkWrittenBeforeTheLowWatermarkExistedResumesWithoutSkippingHistory()
    {
        var source = new WindowedSource();
        var sink = new RecordingSink
        {
            // No BackfilledFrom: written by a build that had no low watermark.
            Watermark = new QueryStoreWatermark(
                "db", "epoch", "storage", Through.AddHours(-1),
                new Dictionary<QueryStoreFactKind, string?>()),
        };
        using var collector = new IncrementalQueryStoreCollector(
            source, sink,
            Options(initialLookback: TimeSpan.FromDays(2), increment: TimeSpan.FromDays(10)));

        await collector.CollectAsync(["db"], Through);

        // Adopts this cycle's forward start and walks down from there: it re-reads a little rather
        // than assuming a reach it cannot evidence.
        var forwardStart = Through.AddHours(-1) - TimeSpan.FromMinutes(65);
        Assert.Equal(forwardStart - TimeSpan.FromDays(10), sink.Watermark?.BackfilledFrom);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(91 * 24)]
    public void AnIncrementThatIsNotPositiveOrReachesPastRetentionIsRejected(int hours)
    {
        var options = new QueryStoreCollectionOptions(BackfillIncrement: TimeSpan.FromHours(hours));

        Assert.Throws<ArgumentOutOfRangeException>(options.Validate);
    }

    [Fact]
    public void ABackfillHorizonBeyondWhatTheSinkRetainsIsRejected()
    {
        var options = new QueryStoreCollectionOptions(
            BackfillIncrement: TimeSpan.FromDays(1),
            BackfillHorizon: QueryStoreRetention.History + TimeSpan.FromDays(1));

        Assert.Throws<ArgumentOutOfRangeException>(options.Validate);
    }

    [Fact]
    public void ABackfillHorizonShallowerThanTheInitialLookbackIsRejected()
    {
        var options = new QueryStoreCollectionOptions(
            InitialLookback: TimeSpan.FromDays(30),
            BackfillIncrement: TimeSpan.FromDays(1),
            BackfillHorizon: TimeSpan.FromDays(10));

        Assert.Throws<ArgumentOutOfRangeException>(options.Validate);
    }

    [Fact]
    public async Task OldestAvailableAtFollowsCollectedRuntimeRatherThanHowFarTheBackfillReached()
    {
        var tracker = new QueryStoreCollectionStatusTracker();
        var repository = new ProtectedQueryStoreRepository(new MemoryStore());
        var sink = new ProtectedQueryStoreHistorySink(repository, tracker);
        // The backfill will walk to 32 days back; the source only ever produced runtime at 5 days.
        var source = new WindowedSource
        {
            Oldest = Through.AddDays(-120),
            RuntimeAt = [Through.AddDays(-5)],
        };
        using var collector = new IncrementalQueryStoreCollector(
            source, sink,
            Options(initialLookback: TimeSpan.FromDays(2), increment: TimeSpan.FromDays(10)));

        for (var cycle = 0; cycle < 4; cycle++) await collector.CollectAsync(["db"], Through);

        var watermark = await repository.ReadWatermarkAsync("db");
        Assert.Equal(Through.AddDays(-32), watermark?.BackfilledFrom);
        var status = Assert.Single(tracker.Current!.Databases);
        Assert.Equal(Through.AddDays(-5), status.OldestAvailableAt);
    }

    [Fact]
    public async Task OldestAvailableAtStaysNullWhileTheBackfillHasCollectedNoHistory()
    {
        var tracker = new QueryStoreCollectionStatusTracker();
        var repository = new ProtectedQueryStoreRepository(new MemoryStore());
        var sink = new ProtectedQueryStoreHistorySink(repository, tracker);
        var source = new WindowedSource { Oldest = Through.AddDays(-120), RuntimeAt = [] };
        using var collector = new IncrementalQueryStoreCollector(
            source, sink,
            Options(initialLookback: TimeSpan.FromDays(2), increment: TimeSpan.FromDays(10)));

        for (var cycle = 0; cycle < 4; cycle++) await collector.CollectAsync(["db"], Through);

        var watermark = await repository.ReadWatermarkAsync("db");
        Assert.Equal(Through.AddDays(-32), watermark?.BackfilledFrom);
        var status = Assert.Single(tracker.Current!.Databases);
        Assert.Null(status.OldestAvailableAt);
    }

    private static QueryStoreCollectionOptions Options(
        TimeSpan? initialLookback = null,
        TimeSpan? increment = null,
        TimeSpan? horizon = null) =>
        new(DatabaseConcurrency: 1, InitialLookback: initialLookback,
            BackfillIncrement: increment, BackfillHorizon: horizon);

    /// <summary>
    /// Enough of <see cref="IProtectedRecordStore"/> for a publish and a watermark round trip.
    /// Kept here rather than shared so this file stands alone; the real store's costs are measured
    /// elsewhere and are not what these tests are about.
    /// </summary>
    private sealed class MemoryStore : IProtectedRecordStore
    {
        private readonly Dictionary<string, ProtectedRecord> _records = new(StringComparer.Ordinal);

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
            ProtectedRecordId id, CancellationToken cancellationToken = default) =>
            // A copy: ProtectedRecord is disposable and the caller owns what it is handed.
            Task.FromResult(_records.GetValueOrDefault(id.Value) is { } record
                ? new ProtectedRecord(
                    record.Id, record.RecordKind, record.CapturedAt, record.Resolution,
                    record.Payload.ToArray())
                : null);

        public Task<bool> DeleteAsync(
            ProtectedRecordId id, CancellationToken cancellationToken = default) =>
            Task.FromResult(_records.Remove(id.Value));

        public Task<ProtectedSetReplacement> ReplaceSetAsync(
            string idPrefix, IEnumerable<ProtectedRecordWrite> records,
            CancellationToken cancellationToken = default)
        {
            var replacement = records.Select(record => new ProtectedRecord(
                record.Id, record.RecordKind, record.CapturedAt,
                record.Resolution, record.Payload.ToArray())).ToArray();
            foreach (var key in _records.Keys
                         .Where(key => key.StartsWith(idPrefix, StringComparison.Ordinal)).ToArray())
                _records.Remove(key);
            foreach (var record in replacement) _records[record.Id.Value] = record;
            var bytes = replacement.Sum(record => (long)record.Payload.Length);
            return Task.FromResult(new ProtectedSetReplacement(
                0, 0, replacement.Length, bytes, bytes, TimeSpan.Zero));
        }

        public Task<IReadOnlyList<ProtectedRecordId>> ListOldestAsync(
            IReadOnlyCollection<string> recordKinds, int limit,
            CancellationToken cancellationToken = default) =>
            Task.FromResult<IReadOnlyList<ProtectedRecordId>>([]);

        public Task<ProtectedStorageUsage> MeasureUsageAsync(
            CancellationToken cancellationToken = default) =>
            Task.FromResult(InMemoryUsage.Measure(_records.Values));

        public Task<int> PruneExpiredAsync(CancellationToken cancellationToken = default) =>
            Task.FromResult(0);
    }

    /// <summary>
    /// Answers a window with the runtime intervals that fall inside it, so a backfill step that
    /// reaches ground the source has nothing for stages nothing -- which is the case that separates
    /// a published horizon derived from data from one derived from intent.
    /// </summary>
    private sealed class WindowedSource : IQueryStoreIncrementalSource
    {
        public List<(DateTimeOffset Start, DateTimeOffset End)> Windows { get; } = [];
        public DateTimeOffset? Oldest { get; init; }
        public string ResetEpoch { get; set; } = "epoch";
        public DateTimeOffset? FailBelow { get; set; }
        public IReadOnlyList<DateTimeOffset> RuntimeAt { get; init; } = [Through.AddHours(-1)];

        public Task<IReadOnlyList<string>> DiscoverDatabasesAsync(CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<string>>(["db"]);

        public Task<QueryStoreDatabaseState> GetStateAsync(
            string databaseId, CancellationToken cancellationToken) =>
            Task.FromResult(new QueryStoreDatabaseState(
                databaseId, QueryStoreCollectionState.ReadWrite, ResetEpoch, Oldest, Through,
                "available", 16, 160, false, false, false, false));

        public Task<QueryStoreFactPage> ReadPageAsync(
            string databaseId, QueryStoreFactKind kind, DateTimeOffset startInclusive,
            DateTimeOffset endExclusive, string? pageToken, int pageSize,
            CancellationToken cancellationToken)
        {
            Windows.Add((startInclusive, endExclusive));
            if (FailBelow is { } floor && startInclusive < floor)
                throw new InvalidOperationException("synthetic backfill failure");
            var starts = RuntimeAt
                .Where(at => at >= startInclusive && at < endExclusive)
                .ToArray();
            QueryStoreCollectedFact[] facts = kind switch
            {
                QueryStoreFactKind.Identity when starts.Length > 0 =>
                    [new QueryIdentityFact(
                        "q", "q-text", "context", "hash", Through, false, true, null, null, null, null)],
                QueryStoreFactKind.Plan when starts.Length > 0 =>
                    [new QueryPlanFact(
                        "plan", "q", "plan-hash", QueryPlanType.Compiled, null, false, null,
                        BigInteger.Zero, null, "16", "160", Through)],
                QueryStoreFactKind.Runtime =>
                    [.. starts.Select(at => new QueryRuntimeFact(new RuntimeStatInput(
                        "plan", at.UtcTicks.ToString(System.Globalization.CultureInfo.InvariantCulture),
                        at, at.AddMinutes(1), QueryStoreExecutionType.Regular, "primary", 1, 1, 1, 1)))],
                _ => [],
            };
            return Task.FromResult(new QueryStoreFactPage(kind, facts, null, false));
        }

        public Task<QueryTextPayload> ReadQueryTextAsync(
            string databaseId, string queryTextId, CancellationToken cancellationToken) =>
            Task.FromResult(new QueryTextPayload(null, false, true));

        public Task<string?> ReadPlanXmlAsync(
            string databaseId, string planId, CancellationToken cancellationToken) =>
            Task.FromResult<string?>(null);
    }

    private sealed class RecordingSink : IQueryStoreHistorySink
    {
        public QueryStoreWatermark? Watermark { get; set; }

        public Task<QueryStoreWatermark?> GetWatermarkAsync(
            string databaseId, CancellationToken cancellationToken) => Task.FromResult(Watermark);

        public Task BeginDatabaseCycleAsync(
            QueryStoreDatabaseState state, string storageEpoch, bool resetDetected,
            CancellationToken cancellationToken) => Task.CompletedTask;

        public Task StageFactsAsync(
            string databaseId, QueryStoreFactPage page, CancellationToken cancellationToken) =>
            Task.CompletedTask;

        public Task StageRuntimeBucketsAsync(
            string databaseId, IReadOnlyList<AggregatedRuntimeBucket> buckets, bool activeInterval,
            CancellationToken cancellationToken) => Task.CompletedTask;

        public Task CommitDatabaseCycleAsync(
            QueryStoreDatabaseState state, QueryStoreWatermark watermark,
            CancellationToken cancellationToken)
        {
            Watermark = watermark;
            return Task.CompletedTask;
        }

        public Task AbortDatabaseCycleAsync(string databaseId, CancellationToken cancellationToken) =>
            Task.CompletedTask;

        public Task PublishAsync(QueryStoreCollectionResult result, CancellationToken cancellationToken) =>
            Task.CompletedTask;
    }
}
