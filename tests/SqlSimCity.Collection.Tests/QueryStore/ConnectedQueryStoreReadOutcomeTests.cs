using SqlSimCity.Collection.Probes;
using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Storage;

namespace SqlSimCity.Collection.Tests.QueryStore;

/// <summary>
/// Issue #95. <c>GetPlanAsync</c> answered "there is no such plan" and "I could not read this plan"
/// with the same null, so a connection blip, a timeout, or a permission problem against the
/// monitored instance silently reduced whatever evidence was built on top of it. These pin the
/// distinction where it is knowable -- at the source, which is the only place that can tell the two
/// apart -- and pin that the nullable methods still answer exactly as they did.
/// </summary>
public sealed class ConnectedQueryStoreReadOutcomeTests
{
    [Fact]
    public async Task AProbeFailureReadsAsUnavailableRatherThanAsAMissingPlan()
    {
        var source = Source(new ThrowingPlanSource(
            new ProbeTransientConnectionException("The connection to the target was reset.", 10054, 20)));

        var read = await source.ReadPlanAsync("db:42", default);

        Assert.Equal(QueryStoreReadOutcome.Unavailable, read.Outcome);
        Assert.Equal(DataStatus.Disconnected, read.Status);
        Assert.Equal("The connection to the target was reset.", read.Reason);
        Assert.Null(read.Value);
    }

    [Fact]
    public async Task ADeniedPrincipalReadsAsPermissionDeniedRatherThanAsAMissingPlan()
    {
        var source = Source(new ThrowingPlanSource(
            new ProbePermissionDeniedException("The principal cannot read Query Store plans.", 297, 14)));

        var read = await source.ReadPlanAsync("db:42", default);

        Assert.Equal(QueryStoreReadOutcome.Unavailable, read.Outcome);
        Assert.Equal(DataStatus.PermissionDenied, read.Status);
        Assert.Equal("The principal cannot read Query Store plans.", read.Reason);
    }

    /// <summary>
    /// The distinction has to cut both ways. A probe that ran and came back with nothing really has
    /// established that there is no such plan, and reporting that as unavailable would make the
    /// disclosure it feeds meaningless.
    /// </summary>
    [Fact]
    public async Task AProbeThatReturnsNothingReadsAsAbsent()
    {
        var source = Source(new EmptyPlanSource());

        var read = await source.ReadPlanAsync("db:42", default);

        Assert.Equal(QueryStoreReadOutcome.Absent, read.Outcome);
        Assert.Equal(DataStatus.Available, read.Status);
        Assert.Null(read.Value);
    }

    [Fact]
    public async Task TheNullablePlanReadStillAnswersNullForBoth()
    {
        var unavailable = Source(new ThrowingPlanSource(
            new ProbeTimeoutException("The Query Store plan read timed out.", -2, 11)));
        var absent = Source(new EmptyPlanSource());

        Assert.Null(await unavailable.GetPlanAsync("db:42", default));
        Assert.Null(await absent.GetPlanAsync("db:42", default));
    }

    [Fact]
    public async Task AComparisonBlockedByAnUnreadableSideReadsAsUnavailable()
    {
        var source = Source(new ThrowingPlanSource(
            new ProbeTransientConnectionException("The connection to the target was reset.", 10054, 20)));

        var read = await source.ReadComparisonAsync("db:42", "db:43", default);

        Assert.Equal(QueryStoreReadOutcome.Unavailable, read.Outcome);
        Assert.Equal(DataStatus.Disconnected, read.Status);
        Assert.Contains("left Showplan could not be read", read.Reason, StringComparison.Ordinal);
        Assert.Contains("The connection to the target was reset.", read.Reason, StringComparison.Ordinal);
        Assert.Null(await source.ComparePlansAsync("db:42", "db:43", default));
    }

    [Fact]
    public async Task AComparisonMissingAPlanReadsAsAbsent()
    {
        var source = Source(new EmptyPlanSource());

        var read = await source.ReadComparisonAsync("db:42", "db:43", default);

        Assert.Equal(QueryStoreReadOutcome.Absent, read.Outcome);
        Assert.Contains("left Showplan is not there", read.Reason, StringComparison.Ordinal);
        Assert.Contains("right Showplan is not there", read.Reason, StringComparison.Ordinal);
    }

    /// <summary>
    /// A family read before the first publish is not evidence that the family is absent -- there is
    /// nothing to have looked in.
    /// </summary>
    [Fact]
    public async Task AFamilyReadBeforeTheFirstPublishReadsAsUnavailable()
    {
        var source = Source(new EmptyPlanSource());

        var read = await source.ReadFamilyAsync("family-1", default);

        Assert.Equal(QueryStoreReadOutcome.Unavailable, read.Outcome);
        Assert.Equal(DataStatus.Unknown, read.Status);
        Assert.Contains("has been published", read.Reason, StringComparison.Ordinal);
        Assert.Null(await source.GetFamilyAsync("family-1", default));
    }

    /// <summary>
    /// A source that will not hydrate raw payloads -- the edge connector's -- has not established
    /// anything about a plan protected storage does not already hold.
    /// </summary>
    [Fact]
    public async Task ASourceThatCannotHydrateReadsAsUnavailable()
    {
        var source = new ConnectedQueryStoreHistorySource(
            new ProtectedQueryStoreRepository(new MemoryStore()), new EmptyPlanSource(),
            new SecureShowplanParser(), new QueryStoreCollectionStatusTracker(), TimeProvider.System,
            allowRawPayloadHydration: false);

        var read = await source.ReadPlanAsync("db:42", default);

        Assert.Equal(QueryStoreReadOutcome.Unavailable, read.Outcome);
        Assert.Equal(DataStatus.Disabled, read.Status);
    }

    private static ConnectedQueryStoreHistorySource Source(IQueryStoreIncrementalSource incremental) =>
        new(new ProtectedQueryStoreRepository(new MemoryStore()), incremental,
            new SecureShowplanParser(), new QueryStoreCollectionStatusTracker(), TimeProvider.System);

    private abstract class PlanSourceBase : IQueryStoreIncrementalSource
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
        public abstract Task<string?> ReadPlanXmlAsync(
            string databaseId, string planId, CancellationToken cancellationToken);
    }

    private sealed class ThrowingPlanSource(ProbeExecutionException exception) : PlanSourceBase
    {
        public override Task<string?> ReadPlanXmlAsync(
            string databaseId, string planId, CancellationToken cancellationToken) => throw exception;
    }

    private sealed class EmptyPlanSource : PlanSourceBase
    {
        public override Task<string?> ReadPlanXmlAsync(
            string databaseId, string planId, CancellationToken cancellationToken) =>
            Task.FromResult<string?>(null);
    }

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
            Task.FromResult(_records.GetValueOrDefault(id.Value));

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
                         .Where(key => key.StartsWith(idPrefix, StringComparison.Ordinal))
                         .ToArray())
                _records.Remove(key);
            foreach (var record in replacement) _records[record.Id.Value] = record;
            var bytes = replacement.Sum(record => (long)record.Payload.Length);
            return Task.FromResult(new ProtectedSetReplacement(
                0, 0, replacement.Length, bytes, bytes, TimeSpan.Zero));
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
}
