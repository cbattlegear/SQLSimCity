using Microsoft.Extensions.Logging;
using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Storage;

namespace SqlSimCity.Collection.Tests.QueryStore;

/// <summary>
/// The reporting half of issue #82's instrumentation. Measuring composition walks every retained
/// record, so it must not run on the collection loop's cadence; and the prune backlog is only
/// worth an operator's attention when it is actually beyond what one prune per cycle can clear.
/// </summary>
public sealed class QueryStoreStorageTelemetryTests
{
    private static readonly DateTimeOffset Now = new(2026, 8, 20, 9, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task MeasurementIsSkippedUntilItsOwnIntervalHasElapsed()
    {
        var clock = new FakeClock(Now);
        var store = new UsageStore();
        var telemetry = NewTelemetry(store, clock, MeasurementInterval: TimeSpan.FromMinutes(5));

        Assert.NotNull(await telemetry.ReportAsync(0));
        clock.Advance(TimeSpan.FromMinutes(2));
        Assert.Null(await telemetry.ReportAsync(0));
        clock.Advance(TimeSpan.FromMinutes(2));
        Assert.Null(await telemetry.ReportAsync(0));
        clock.Advance(TimeSpan.FromMinutes(2));
        Assert.NotNull(await telemetry.ReportAsync(0));

        // Three of the four cycles must not have touched the store. A skip that still measured
        // would leave the loop paying a full scan per cycle while looking like it did not.
        Assert.Equal(2, store.MeasureCount);
    }

    [Fact]
    public async Task TheBacklogIsReportedOnlyWhenItIsBeyondWhatOnePruneClears()
    {
        var retention = new RetentionOptions { PruneBatchSize = 500 };

        Assert.Empty(await BacklogWarningsAsync(500, retention));
        Assert.Empty(await BacklogWarningsAsync(0, retention));

        var warning = Assert.Single(await BacklogWarningsAsync(1_501, retention));
        // Four cycles, not three: 1,501 records need a fourth batch for the last one. Rounding
        // down would tell an operator the backlog clears a cycle before it does.
        Assert.Contains("1501", warning);
        Assert.Contains(" 4 ", warning);
    }

    [Fact]
    public async Task TheReportedPlanCacheIsDerivedFromRealRecordsRatherThanTheTotal()
    {
        var store = new UsageStore
        {
            Usage = new ProtectedStorageUsage(
                6, 1_000, 4_096, 0,
                [
                    new ProtectedRecordKindUsage("query-store-family-detail", 3, 700),
                    new ProtectedRecordKindUsage("query-store-showplan", 2, 250),
                    new ProtectedRecordKindUsage("query-store-normalized-plan", 1, 50),
                ]),
        };
        var logger = new CapturingLogger();
        var telemetry = NewTelemetry(store, new FakeClock(Now), logger);

        await telemetry.ReportAsync(0);

        var usage = Assert.Single(logger.Messages, message => message.Contains("Protected storage holds"));
        Assert.Contains("1000 bytes", usage);
        // 300, not 1,000: the snapshot is not part of the cache, and a metric that reported the
        // whole store would look plausible while overstating the cache by more than three times.
        Assert.Contains("300 bytes of that", usage);
        Assert.Contains("3 records and", usage);
    }

    [Fact]
    public async Task AQuotaPassRunsOnTheSameMeasurementAndIsReportedWhenItEvicts()
    {
        var store = new UsageStore
        {
            Usage = new ProtectedStorageUsage(
                2, 90_000, 200_000, 0,
                [new ProtectedRecordKindUsage("query-store-showplan", 2, 90_000)]),
        };
        var logger = new CapturingLogger();
        var telemetry = NewTelemetry(
            store, new FakeClock(Now), logger, planCache: new QueryStorePlanCacheOptions(40_000));

        await telemetry.ReportAsync(0);

        Assert.True(telemetry.LastEviction.EvictedEntries > 0);
        Assert.Contains(logger.Messages, message => message.Contains("exceeded its quota"));
        // Enforcement reuses the measurement it was just handed rather than taking its own.
        Assert.Equal(1, store.MeasureCount);
    }

    private static async Task<IReadOnlyList<string>> BacklogWarningsAsync(
        long expired, RetentionOptions retention)
    {
        var store = new UsageStore
        {
            Usage = new ProtectedStorageUsage(
                expired, 10, 20, expired,
                [new ProtectedRecordKindUsage("query-store-showplan", expired, 10)]),
        };
        var logger = new CapturingLogger();
        await NewTelemetry(store, new FakeClock(Now), logger, retention).ReportAsync(0);
        return logger.Messages.Where(message => message.Contains("retention is behind")).ToArray();
    }

    private static QueryStoreStorageTelemetry NewTelemetry(
        UsageStore store,
        FakeClock clock,
        CapturingLogger? logger = null,
        RetentionOptions? retention = null,
        QueryStorePlanCacheOptions? planCache = null,
        TimeSpan? MeasurementInterval = null) =>
        new(store,
            new ProtectedQueryStoreRepository(store),
            retention ?? new RetentionOptions(),
            planCache ?? QueryStorePlanCacheOptions.Unbounded,
            clock,
            logger)
        {
            MeasurementInterval = MeasurementInterval ?? TimeSpan.Zero,
        };

    private sealed class FakeClock(DateTimeOffset start) : TimeProvider
    {
        private DateTimeOffset _now = start;
        public override DateTimeOffset GetUtcNow() => _now;
        public void Advance(TimeSpan delta) => _now += delta;
    }

    /// <summary>
    /// Answers usage from a fixed value and counts how often it was asked, so a test can prove a
    /// skipped measurement really did not happen rather than merely returning null.
    /// </summary>
    private sealed class UsageStore : IProtectedRecordStore
    {
        private readonly Dictionary<string, ProtectedRecord> _records = new(StringComparer.Ordinal);

        public int MeasureCount { get; private set; }
        public ProtectedStorageUsage Usage { get; set; } = ProtectedStorageUsage.Empty;
        public int MaxPayloadBytes => 1_048_576;

        public Task<ProtectedStorageUsage> MeasureUsageAsync(CancellationToken cancellationToken = default)
        {
            MeasureCount++;
            return Task.FromResult(Usage);
        }

        public Task<IReadOnlyList<ProtectedRecordId>> ListOldestAsync(
            IReadOnlyCollection<string> recordKinds, int limit,
            CancellationToken cancellationToken = default)
        {
            var pending = Usage.Kinds
                .Where(kind => recordKinds.Contains(kind.RecordKind))
                .SelectMany(kind => Enumerable.Range(0, (int)kind.RecordCount)
                    .Select(index => new ProtectedRecordId($"qs:{kind.RecordKind}:{index:D4}")))
                .Take(limit)
                .ToArray();
            return Task.FromResult<IReadOnlyList<ProtectedRecordId>>(pending);
        }

        public Task<ProtectedSetReplacement> ReplaceSetAsync(
            string idPrefix, IEnumerable<ProtectedRecordWrite> records,
            CancellationToken cancellationToken = default)
        {
            _ = records.ToArray();
            var kind = Usage.Kinds.FirstOrDefault(item => idPrefix.Contains(item.RecordKind, StringComparison.Ordinal));
            if (kind is null || kind.RecordCount == 0)
                return Task.FromResult(default(ProtectedSetReplacement));
            var perRecord = kind.StoredBytes / kind.RecordCount;
            Usage = Usage with
            {
                Kinds = Usage.Kinds
                    .Select(item => item == kind
                        ? item with { RecordCount = item.RecordCount - 1, StoredBytes = item.StoredBytes - perRecord }
                        : item)
                    .ToArray(),
            };
            return Task.FromResult(new ProtectedSetReplacement(1, perRecord, 0, 0, 0, TimeSpan.Zero));
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
            ProtectedRecordId id, CancellationToken cancellationToken = default) =>
            Task.FromResult(_records.GetValueOrDefault(id.Value));

        public Task<bool> DeleteAsync(
            ProtectedRecordId id, CancellationToken cancellationToken = default) =>
            Task.FromResult(_records.Remove(id.Value));

        public Task<int> PruneExpiredAsync(CancellationToken cancellationToken = default) =>
            Task.FromResult(0);
    }

    private sealed class CapturingLogger : ILogger<QueryStoreStorageTelemetry>
    {
        public List<string> Messages { get; } = [];

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter) =>
            Messages.Add(formatter(state, exception));
    }
}
