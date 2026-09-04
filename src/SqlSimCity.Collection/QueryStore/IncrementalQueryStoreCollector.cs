using System.Collections.Concurrent;
using System.Globalization;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Collection.QueryStore;

public enum QueryStoreCollectionState
{
    ReadWrite, ReadOnly, ReadCaptureSecondary, Off, Error, PermissionDenied, Unsupported, Unknown,
}
public enum QueryStoreFactKind { Identity, Plan, Runtime, Wait, Variant, Replica }

public sealed record QueryStoreDatabaseState(
    string DatabaseId,
    QueryStoreCollectionState State,
    string ResetEpoch,
    DateTimeOffset? OldestIntervalStart,
    DateTimeOffset ObservedAt,
    string Reason,
    int EngineMajorVersion,
    int CompatibilityLevel,
    bool SupportsWaits,
    bool SupportsPlanVariants,
    bool SupportsReplicas,
    bool SupportsOppo,
    long? LatestIntervalId = null);

/// <param name="Through">
/// The forward (high) watermark: collection for this epoch is complete up to here.
/// </param>
/// <param name="BackfilledFrom">
/// The low watermark: the earliest instant this epoch has actually been collected from. It is
/// recorded on every commit, not only when <see cref="QueryStoreCollectionOptions.BackfillEnabled"/>
/// is on, so that enabling a progressive backfill later resumes from a real figure rather than
/// starting the walk again. <c>null</c> only on a watermark written before the low watermark
/// existed; a backfill then adopts that cycle's forward start, which re-reads a little rather than
/// skipping anything.
/// </param>
public sealed record QueryStoreWatermark(
    string DatabaseId,
    string SourceSignature,
    string StorageEpoch,
    DateTimeOffset Through,
    IReadOnlyDictionary<QueryStoreFactKind, string?> PageTokens,
    long? LatestIntervalId = null,
    DateTimeOffset? BackfilledFrom = null);

public abstract record QueryStoreCollectedFact;

public sealed record QueryIdentityFact(
    string QueryId,
    string QueryTextId,
    string ContextSettingsId,
    string QueryHash,
    DateTimeOffset LastExecutionAt,
    bool IsEncrypted,
    bool IsRestricted,
    string? SetOptions,
    string? Language,
    string? DateFormat,
    string? DateFirst) : QueryStoreCollectedFact;

public sealed record QueryPlanFact(
    string PlanId,
    string QueryId,
    string QueryPlanHash,
    QueryPlanType PlanType,
    string? PlanGroupId,
    bool IsForced,
    string? ForcingType,
    BigInteger ForceFailureCount,
    string? LastForceFailureReason,
    string EngineVersion,
    string CompatibilityLevel,
    DateTimeOffset LastExecutionAt) : QueryStoreCollectedFact;

public sealed record QueryRuntimeFact(RuntimeStatInput Value) : QueryStoreCollectedFact;

public sealed record QueryWaitFact(
    string PlanId,
    string IntervalId,
    QueryStoreExecutionType ExecutionType,
    string ReplicaGroupId,
    byte WaitCategoryId,
    string WaitCategory,
    BigInteger TotalWaitMilliseconds) : QueryStoreCollectedFact;

public sealed record QueryVariantFact(
    string VariantQueryId,
    string ParentQueryId,
    string DispatcherPlanId,
    QueryOptimizationKind Optimization) : QueryStoreCollectedFact;

public sealed record QueryReplicaFact(string ReplicaGroupId, string ReplicaName) : QueryStoreCollectedFact;

public sealed record QueryStoreFactPage(
    QueryStoreFactKind Kind,
    IReadOnlyList<QueryStoreCollectedFact> Facts,
    string? NextPageToken,
    bool ContainsActiveInterval);

public interface IQueryStoreIncrementalSource
{
    Task<IReadOnlyList<string>> DiscoverDatabasesAsync(CancellationToken cancellationToken);
    Task<QueryStoreDatabaseState> GetStateAsync(string databaseId, CancellationToken cancellationToken);
    Task<QueryStoreFactPage> ReadPageAsync(
        string databaseId,
        QueryStoreFactKind kind,
        DateTimeOffset startInclusive,
        DateTimeOffset endExclusive,
        string? pageToken,
        int pageSize,
        CancellationToken cancellationToken);
    Task<QueryTextPayload> ReadQueryTextAsync(
        string databaseId, string queryTextId, CancellationToken cancellationToken);
    Task<string?> ReadPlanXmlAsync(
        string databaseId, string planId, CancellationToken cancellationToken);
}

public sealed record QueryTextPayload(string? Text, bool IsEncrypted, bool IsRestricted);

public interface IQueryStoreHistorySink
{
    Task<QueryStoreWatermark?> GetWatermarkAsync(string databaseId, CancellationToken cancellationToken);
    Task BeginDatabaseCycleAsync(
        QueryStoreDatabaseState state, string storageEpoch, bool resetDetected,
        CancellationToken cancellationToken);
    Task StageFactsAsync(
        string databaseId, QueryStoreFactPage page, CancellationToken cancellationToken);
    Task StageRuntimeBucketsAsync(
        string databaseId,
        IReadOnlyList<AggregatedRuntimeBucket> buckets,
        bool activeInterval,
        CancellationToken cancellationToken);
    Task CommitDatabaseCycleAsync(
        QueryStoreDatabaseState state,
        QueryStoreWatermark watermark,
        CancellationToken cancellationToken);
    Task AbortDatabaseCycleAsync(string databaseId, CancellationToken cancellationToken);
    Task PublishAsync(QueryStoreCollectionResult result, CancellationToken cancellationToken);
}

/// <param name="BackfillIncrement">
/// How much further back each cycle reaches once the forward window is collected. <c>null</c> uses
/// <see cref="DefaultBackfillIncrement"/>. Progressive backfill is on by default: a collector that
/// reaches its whole horizon in one cold-start cycle is the thing that stalls a fresh deployment,
/// and walking back an increment per cycle publishes a usable city after the first one.
/// </param>
/// <param name="BackfillHorizon">
/// How far back the backfill is allowed to walk. <c>null</c> uses <see cref="DefaultBackfillHorizon"/>,
/// and it is capped at the configured retention horizon: reading past what the sink retains would
/// re-create the waste the initial lookback cap removed.
/// </param>
/// <param name="Retention">
/// How much history the sink keeps. <c>null</c> uses <see cref="QueryStoreRetentionOptions.Default"/>.
/// Every cap below is expressed against this rather than against a constant, so lowering retention
/// lowers what the collector reads in the same step and the two cannot drift apart.
/// </param>
public sealed record QueryStoreCollectionOptions(
    int PageSize = 1_000,
    int DatabaseConcurrency = 4,
    TimeSpan? Overlap = null,
    TimeSpan? InitialLookback = null,
    TimeSpan? BackfillIncrement = null,
    TimeSpan? BackfillHorizon = null,
    QueryStoreRetentionOptions? Retention = null)
{
    /// <summary>One hour: the step each cycle reaches further back by.</summary>
    public static readonly TimeSpan DefaultBackfillIncrement = TimeSpan.FromHours(1);

    /// <summary>
    /// Three hours: how far back the backfill walks in total.
    ///
    /// Deliberately far short of retention. What the collector <em>reads</em> and what the sink
    /// <em>keeps</em> answer different questions — the city needs enough past to grade current
    /// traffic against, not the whole retained horizon re-read on every deployment.
    /// </summary>
    public static readonly TimeSpan DefaultBackfillHorizon = TimeSpan.FromHours(3);

    public TimeSpan EffectiveOverlap => Overlap ?? TimeSpan.FromMinutes(65);

    public QueryStoreRetentionOptions EffectiveRetention => Retention ?? QueryStoreRetentionOptions.Default;

    /// <summary>
    /// How far back the first cycle for a database reads when there is no watermark to resume from.
    ///
    /// One backfill increment, floored at the overlap so the first cycle cannot ask for a window
    /// narrower than the re-read it is obliged to perform. The rest of the horizon arrives an
    /// increment per cycle, which is what keeps a wiped volume from turning into one unbounded
    /// cold-start read that publishes nothing until it finishes.
    /// </summary>
    public TimeSpan EffectiveInitialLookback =>
        InitialLookback ?? (EffectiveBackfillIncrement > EffectiveOverlap
            ? EffectiveBackfillIncrement
            : EffectiveOverlap);

    /// <summary>How much further back each cycle reaches. Never null: backfill is always on.</summary>
    public TimeSpan EffectiveBackfillIncrement => BackfillIncrement ?? DefaultBackfillIncrement;

    /// <summary>Whether cycles reach backwards past what the first cycle collected.</summary>
    public bool BackfillEnabled => EffectiveBackfillIncrement > TimeSpan.Zero;

    /// <summary>
    /// How far back the backfill walks, never past what the sink retains. The cap is applied here
    /// rather than rejected in <see cref="Validate"/> only for the default, so lowering retention
    /// below three hours narrows the backfill with it instead of failing to start.
    ///
    /// The derived value is also floored at the initial lookback, because the first cycle reads
    /// that far back whether the horizon agrees or not: a deployment that widens the lookback past
    /// the three-hour default would otherwise refuse to boot on a contradiction it never wrote. An
    /// explicitly configured horizon is left alone and still validated, since a horizon set
    /// shallower than a lookback set beside it is a genuine contradiction worth reporting.
    /// </summary>
    public TimeSpan EffectiveBackfillHorizon
    {
        get
        {
            var history = EffectiveRetention.EffectiveHistory;
            if (BackfillHorizon is { } configured) return configured;
            var derived = DefaultBackfillHorizon < history ? DefaultBackfillHorizon : history;
            var lookback = EffectiveInitialLookback;
            if (derived < lookback) derived = lookback;
            return derived < history ? derived : history;
        }
    }

    public void Validate()
    {
        EffectiveRetention.Validate();
        var history = EffectiveRetention.EffectiveHistory;
        if (PageSize is < 1 or > 10_000) throw new ArgumentOutOfRangeException(nameof(PageSize));
        if (DatabaseConcurrency is < 1 or > 16) throw new ArgumentOutOfRangeException(nameof(DatabaseConcurrency));
        if (EffectiveOverlap < TimeSpan.Zero || EffectiveOverlap > TimeSpan.FromHours(24))
            throw new ArgumentOutOfRangeException(nameof(Overlap));
        if (EffectiveInitialLookback < EffectiveOverlap ||
            EffectiveInitialLookback > history)
            throw new ArgumentOutOfRangeException(
                nameof(InitialLookback),
                "The initial Query Store lookback must be at least the overlap window and at most " +
                $"the {Describe(history)} horizon retained history covers.");
        if (EffectiveBackfillIncrement <= TimeSpan.Zero || EffectiveBackfillIncrement > history)
            throw new ArgumentOutOfRangeException(
                nameof(BackfillIncrement),
                "The Query Store backfill increment must be positive and no larger than the " +
                $"{Describe(history)} horizon retained history covers.");
        if (EffectiveBackfillHorizon > history ||
            EffectiveBackfillHorizon < EffectiveInitialLookback)
            throw new ArgumentOutOfRangeException(
                nameof(BackfillHorizon),
                "The Query Store backfill horizon must be at least the initial lookback and at most " +
                $"the {Describe(history)} horizon retained history covers; " +
                "reaching past what the sink retains collects evidence the first prune discards.");
    }

    /// <summary>
    /// Renders a horizon in whichever unit states it without a fraction. Retention is measured in
    /// hours now as often as in days, and "the 0-day horizon" is what a days-only message says
    /// about a three-hour one.
    /// </summary>
    internal static string Describe(TimeSpan span) =>
        span.TotalDays >= 1 && span.TotalDays == Math.Floor(span.TotalDays)
            ? $"{span.TotalDays:0}-day"
            : $"{span.TotalHours:0.##}-hour";
}

public sealed record QueryStoreDatabaseCollectionResult(
    string DatabaseId,
    QueryStoreCollectionState State,
    int PageCount,
    int BucketCount,
    bool ResetDetected,
    string Reason,
    string? FailureType);

public sealed record QueryStoreCollectionResult(
    bool SkippedBecauseCycleActive,
    DateTimeOffset StartedAt,
    DateTimeOffset CompletedAt,
    IReadOnlyList<QueryStoreDatabaseCollectionResult> Databases,
    IReadOnlyList<string>? RequestedDatabaseIds = null);

public sealed class IncrementalQueryStoreCollector : IDisposable
{
    private readonly IQueryStoreIncrementalSource _source;
    private readonly IQueryStoreHistorySink _sink;
    private readonly QueryStoreCollectionOptions _options;
    private readonly TimeProvider _timeProvider;
    private readonly SemaphoreSlim _cycleGate = new(1, 1);

    public IncrementalQueryStoreCollector(
        IQueryStoreIncrementalSource source,
        IQueryStoreHistorySink sink,
        QueryStoreCollectionOptions options,
        TimeProvider? timeProvider = null)
    {
        _source = source ?? throw new ArgumentNullException(nameof(source));
        _sink = sink ?? throw new ArgumentNullException(nameof(sink));
        _options = options ?? throw new ArgumentNullException(nameof(options));
        _timeProvider = timeProvider ?? TimeProvider.System;
        _options.Validate();
    }

    public void Dispose() => _cycleGate.Dispose();

    public async Task<QueryStoreCollectionResult> CollectAsync(
        IEnumerable<string>? databaseIds,
        DateTimeOffset throughExclusive,
        CancellationToken cancellationToken = default)
    {
        if (!await _cycleGate.WaitAsync(0, cancellationToken).ConfigureAwait(false))
            return new QueryStoreCollectionResult(true, _timeProvider.GetUtcNow(), _timeProvider.GetUtcNow(), []);

        var startedAt = _timeProvider.GetUtcNow();
        try
        {
            var databases = databaseIds?.Distinct(StringComparer.Ordinal).ToArray();
            if (databases is null || databases.Length == 0)
                databases = [.. await _source.DiscoverDatabasesAsync(cancellationToken).ConfigureAwait(false)];
            // Applied after resolution so an explicit list of only system databases collects nothing
            // instead of silently falling back to discovery.
            databases = [.. databases.Where(name => !SystemDatabases.IsSystemDatabase(name))];
            var results = new ConcurrentBag<QueryStoreDatabaseCollectionResult>();
            await Parallel.ForEachAsync(
                databases,
                new ParallelOptions
                {
                    MaxDegreeOfParallelism = _options.DatabaseConcurrency,
                    CancellationToken = cancellationToken,
                },
                async (databaseId, token) =>
                {
                    results.Add(await CollectDatabaseGuardedAsync(databaseId, throughExclusive, token)
                        .ConfigureAwait(false));
                }).ConfigureAwait(false);
            var result = new QueryStoreCollectionResult(
                false, startedAt, _timeProvider.GetUtcNow(),
                results.OrderBy(item => item.DatabaseId, StringComparer.Ordinal).ToArray(),
                databases);
            await _sink.PublishAsync(result, cancellationToken).ConfigureAwait(false);
            return result;
        }
        finally
        {
            _cycleGate.Release();
        }
    }

    private async Task<QueryStoreDatabaseCollectionResult> CollectDatabaseGuardedAsync(
        string databaseId,
        DateTimeOffset throughExclusive,
        CancellationToken cancellationToken)
    {
        try
        {
            return await CollectDatabaseAsync(databaseId, throughExclusive, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            await _sink.AbortDatabaseCycleAsync(databaseId, CancellationToken.None).ConfigureAwait(false);
            throw;
        }
        catch (Exception ex)
        {
            await _sink.AbortDatabaseCycleAsync(databaseId, cancellationToken).ConfigureAwait(false);
            return new QueryStoreDatabaseCollectionResult(
                databaseId, QueryStoreCollectionState.Error, 0, 0, false,
                "Collection failed for this database; prior history is retained without renewing its observation time.",
                ex.GetType().Name);
        }
    }

    private async Task<QueryStoreDatabaseCollectionResult> CollectDatabaseAsync(
        string databaseId,
        DateTimeOffset throughExclusive,
        CancellationToken cancellationToken)
    {
        var state = await _source.GetStateAsync(databaseId, cancellationToken).ConfigureAwait(false);
        if (state.State is QueryStoreCollectionState.Off or QueryStoreCollectionState.Error or
            QueryStoreCollectionState.PermissionDenied or QueryStoreCollectionState.Unsupported or
            QueryStoreCollectionState.Unknown)
            return new QueryStoreDatabaseCollectionResult(
                databaseId, state.State, 0, 0, false, state.Reason, null);

        var watermark = await _sink.GetWatermarkAsync(databaseId, cancellationToken).ConfigureAwait(false);
        var retentionGap = watermark is not null && state.OldestIntervalStart is not null &&
                           watermark.Through < state.OldestIntervalStart;
        var reset = watermark is not null &&
                    (!string.Equals(watermark.SourceSignature, state.ResetEpoch, StringComparison.Ordinal) ||
                     retentionGap ||
                     watermark.LatestIntervalId is not null && state.LatestIntervalId is null ||
                     state.LatestIntervalId is { } latest &&
                     watermark.LatestIntervalId is { } priorLatest &&
                     latest < priorLatest);
        var storageEpoch = watermark is null || reset
            ? CreateStorageEpoch(state, watermark?.StorageEpoch)
            : watermark.StorageEpoch;
        await _sink.BeginDatabaseCycleAsync(
            state, storageEpoch, reset, cancellationToken).ConfigureAwait(false);
        var forwardStart = watermark is null || reset
            ? InitialStart(state, throughExclusive)
            : watermark.Through - _options.EffectiveOverlap;
        // A reset restarts the epoch, so the low watermark restarts with it rather than claiming
        // the discarded epoch's reach.
        DateTimeOffset? reachedBack = watermark is null || reset
            ? null
            : watermark.BackfilledFrom ?? forwardStart;
        var windows = new List<(DateTimeOffset Start, DateTimeOffset End)> { (forwardStart, throughExclusive) };
        if (reachedBack is { } reached && NextBackfillWindow(state, throughExclusive, reached) is { } step)
            windows.Add(step);

        var pageCount = 0;
        var bucketCount = 0;
        var kinds = KindsFor(state);
        foreach (var (start, end) in windows)
        {
            foreach (var kind in kinds)
            {
                string? token = null;
                do
                {
                    var page = await _source.ReadPageAsync(
                        databaseId, kind, start, end, token,
                        _options.PageSize, cancellationToken).ConfigureAwait(false);
                    await _sink.StageFactsAsync(databaseId, page, cancellationToken).ConfigureAwait(false);
                    if (kind == QueryStoreFactKind.Runtime)
                    {
                        var rows = page.Facts.Cast<QueryRuntimeFact>().Select(fact => fact.Value);
                        var buckets = QueryStoreRuntimeAggregator.Aggregate(rows);
                        var active = buckets.Where(bucket => bucket.Key.IntervalEnd >= throughExclusive).ToArray();
                        var closed = buckets.Where(bucket => bucket.Key.IntervalEnd < throughExclusive).ToArray();
                        if (closed.Length > 0)
                            await _sink.StageRuntimeBucketsAsync(
                                databaseId, closed, false, cancellationToken).ConfigureAwait(false);
                        if (active.Length > 0)
                            await _sink.StageRuntimeBucketsAsync(
                                databaseId, active, true, cancellationToken).ConfigureAwait(false);
                        bucketCount += buckets.Count;
                    }
                    pageCount++;
                    token = page.NextPageToken;
                }
                while (token is not null);
            }
        }

        // Published only now, with the rest of the cycle. A run interrupted anywhere above leaves
        // both watermarks where they were, so the next cycle repeats this step rather than skipping
        // past it -- which is the whole reason the backfill has a watermark instead of a counter.
        var earliestThisCycle = windows.Min(window => window.Start);
        var backfilledFrom = reachedBack is { } prior && prior < earliestThisCycle
            ? prior
            : earliestThisCycle;
        var newWatermark = new QueryStoreWatermark(
            databaseId, state.ResetEpoch, storageEpoch, throughExclusive,
            kinds.ToDictionary(kind => kind, _ => (string?)null),
            state.LatestIntervalId ?? watermark?.LatestIntervalId,
            backfilledFrom);
        await _sink.CommitDatabaseCycleAsync(state, newWatermark, cancellationToken).ConfigureAwait(false);
        return new QueryStoreDatabaseCollectionResult(
            databaseId, state.State, pageCount, bucketCount, reset, state.Reason, null);
    }

    /// <summary>
    /// One bounded step backwards, or <c>null</c> when there is nothing left to take. The backfill
    /// is off unless <see cref="QueryStoreCollectionOptions.BackfillIncrement"/> is configured, and
    /// it never starts on a first or post-reset cycle: that cycle already reads a full initial
    /// lookback, and adding to it would front-load exactly the work this spreads out.
    ///
    /// The floor is the later of the backfill horizon and what the source still holds. Walking past
    /// the horizon would read a production instance for evidence the first prune discards, which is
    /// the waste the initial lookback cap removed; walking past the source's own boundary would
    /// read nothing at all, forever, because the low watermark would never reach a floor below it.
    /// </summary>
    private (DateTimeOffset Start, DateTimeOffset End)? NextBackfillWindow(
        QueryStoreDatabaseState state,
        DateTimeOffset throughExclusive,
        DateTimeOffset reachedBack)
    {
        if (!_options.BackfillEnabled) return null;
        var increment = _options.EffectiveBackfillIncrement;
        var floor = throughExclusive - _options.EffectiveBackfillHorizon;
        if (state.OldestIntervalStart is { } oldest && oldest > floor) floor = oldest;
        if (reachedBack <= floor) return null;
        var start = reachedBack - increment;
        return (start < floor ? floor : start, reachedBack);
    }

    /// <summary>
    /// Where a first (or post-reset) cycle begins. The source can retain months of Query Store
    /// history, and the sink discards anything older than <see cref="QueryStoreRetention.History"/>,
    /// so starting at the source's oldest interval reads a production instance for evidence the
    /// first prune throws away. Start no earlier than the configured lookback, and no earlier than
    /// what the source still holds when it reports a boundary.
    /// </summary>
    private DateTimeOffset InitialStart(QueryStoreDatabaseState state, DateTimeOffset throughExclusive)
    {
        var floor = throughExclusive - _options.EffectiveInitialLookback;
        return state.OldestIntervalStart is { } oldest && oldest > floor ? oldest : floor;
    }

    private static string CreateStorageEpoch(QueryStoreDatabaseState state, string? priorStorageEpoch)
    {
        var source = $"{state.DatabaseId}\n{state.ObservedAt.UtcTicks}\n{state.LatestIntervalId?.ToString(CultureInfo.InvariantCulture) ?? "none"}\n{priorStorageEpoch ?? "initial"}";
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(source)))
            .ToLowerInvariant()[..16];
        return $"qs-epoch-{state.ObservedAt:yyyyMMddHHmmssfffffff}-{hash}";
    }

    private static QueryStoreFactKind[] KindsFor(QueryStoreDatabaseState state)
    {
        var kinds = new List<QueryStoreFactKind>
        {
            QueryStoreFactKind.Identity, QueryStoreFactKind.Plan, QueryStoreFactKind.Runtime,
        };
        if (state.SupportsWaits) kinds.Add(QueryStoreFactKind.Wait);
        if (state.SupportsPlanVariants) kinds.Add(QueryStoreFactKind.Variant);
        if (state.SupportsReplicas) kinds.Add(QueryStoreFactKind.Replica);
        return [.. kinds];
    }
}
