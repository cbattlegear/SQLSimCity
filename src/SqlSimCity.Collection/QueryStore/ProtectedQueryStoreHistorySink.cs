using System.Collections.Concurrent;
using System.Globalization;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.QueryStore;

public sealed class ProtectedQueryStoreHistorySink(
    ProtectedQueryStoreRepository repository,
    QueryStoreCollectionStatusTracker statusTracker) : IQueryStoreHistorySink
{
    private readonly ConcurrentDictionary<string, DatabaseFacts> _committed = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, DatabaseFacts> _staged = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, QueryStoreWatermark> _pendingWatermarks = new(StringComparer.Ordinal);
    private long _sequence;
    public QueryStoreBuildInspection LastBuildInspection { get; private set; } = new(0, 0, 0, 0, 0, 0);

    public Task<QueryStoreWatermark?> GetWatermarkAsync(
        string databaseId,
        CancellationToken cancellationToken) =>
        repository.ReadWatermarkAsync(databaseId, cancellationToken);

    public async Task BeginDatabaseCycleAsync(
        QueryStoreDatabaseState state,
        string storageEpoch,
        bool resetDetected,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await EnsureLoadedAsync(cancellationToken).ConfigureAwait(false);
        var current = _committed.TryGetValue(state.DatabaseId, out var existing)
            ? existing.Clone() : new DatabaseFacts(state.DatabaseId);
        if (resetDetected)
        {
            var archivedIds = current.ArchivedFamilies.Select(detail => detail.Family.FamilyId)
                .ToHashSet(StringComparer.Ordinal);
            foreach (var archived in BuildCurrentFamilies(current, state.ObservedAt, out _)
                         .Select(detail => Archive(detail, current.CurrentEpoch)))
                if (archivedIds.Add(archived.Family.FamilyId))
                    current.ArchivedFamilies.Add(archived);
            current.Identities.Clear();
            current.Plans.Clear();
            current.Runtime.Clear();
            current.Waits.Clear();
            current.Variants.Clear();
            current.Replicas.Clear();
            current.Text.Clear();
        }

        PruneCommitted(current, state.ObservedAt);
        var activeBuckets = current.Runtime.Where(pair => pair.Value.ActiveInterval).ToArray();
        var activeWaitKeys = activeBuckets.Select(pair => WaitBucketKey(pair.Value)).ToHashSet();
        foreach (var key in activeBuckets.Select(pair => pair.Key))
            current.Runtime.Remove(key);
        foreach (var wait in current.Waits.Where(pair =>
                     activeWaitKeys.Contains(WaitBucketKey(pair.Value))).Select(pair => pair.Key).ToArray())
            current.Waits.Remove(wait);
        current.State = state;
        current.CurrentEpoch = storageEpoch;
        _staged[state.DatabaseId] = current;
    }

    public async Task StageFactsAsync(
        string databaseId,
        QueryStoreFactPage page,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var state = GetStage(databaseId);
        HashSet<string>? pendingTextIds = null;
        foreach (var fact in page.Facts)
        {
            switch (fact)
            {
                case QueryIdentityFact identity:
                    state.Identities[identity.QueryId] = identity;
                    // An Available descriptor is terminal: storage only ever gains one for an
                    // id that had none, and that is where this in-memory value came from. Any
                    // weaker descriptor is still re-read, so a Missing one that the API
                    // hydrated on demand between cycles is picked up exactly as before.
                    if (state.Text.TryGetValue(identity.QueryTextId, out var staged) &&
                        staged.Availability == QueryTextAvailability.Available)
                        break;
                    pendingTextIds ??= new HashSet<string>(StringComparer.Ordinal);
                    pendingTextIds.Add(identity.QueryTextId);
                    break;
                case QueryPlanFact plan:
                    state.Plans[plan.PlanId] = plan;
                    break;
                case QueryWaitFact wait:
                    state.Waits[WaitKey(state.CurrentEpoch, wait)] =
                        new EpochWaitFact(state.CurrentEpoch, wait);
                    break;
                case QueryVariantFact variant:
                    state.Variants[variant.VariantQueryId] = variant;
                    break;
                case QueryReplicaFact replica:
                    state.Replicas[replica.ReplicaGroupId] = replica;
                    break;
            }
        }

        if (pendingTextIds is null) return;
        // One storage connection for the whole page. A first or backfill cycle stages tens of
        // thousands of identities, and opening a connection per identity costs orders of
        // magnitude more than the read it carries.
        await repository.ReadBatchAsync(
            async (reader, token) =>
            {
                foreach (var queryTextId in pendingTextIds)
                {
                    token.ThrowIfCancellationRequested();
                    if (await reader.ReadTextDescriptorAsync(databaseId, queryTextId, token)
                            .ConfigureAwait(false) is { } descriptor)
                        state.Text[queryTextId] = descriptor;
                }
            },
            cancellationToken).ConfigureAwait(false);
    }

    public Task StageRuntimeBucketsAsync(
        string databaseId,
        IReadOnlyList<AggregatedRuntimeBucket> buckets,
        bool activeInterval,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var state = GetStage(databaseId);
        foreach (var bucket in buckets)
        {
            var key = RuntimeKey(state.CurrentEpoch, bucket.Key);
            // Both active and closed rows are deterministic upserts. Replaying an active interval
            // replaces its complete logical bucket instead of adding another in-memory/flushed row.
            state.Runtime[key] = new EpochRuntimeBucket(state.CurrentEpoch, bucket, activeInterval);
        }
        return Task.CompletedTask;
    }

    public Task CommitDatabaseCycleAsync(
        QueryStoreDatabaseState state,
        QueryStoreWatermark watermark,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!_staged.TryRemove(state.DatabaseId, out var staged))
            throw new InvalidOperationException("No staged Query Store database cycle exists.");
        _committed[state.DatabaseId] = staged;
        _pendingWatermarks[state.DatabaseId] = watermark;
        return Task.CompletedTask;
    }

    public Task AbortDatabaseCycleAsync(string databaseId, CancellationToken cancellationToken)
    {
        _staged.TryRemove(databaseId, out _);
        return Task.CompletedTask;
    }

    public async Task PublishAsync(QueryStoreCollectionResult result, CancellationToken cancellationToken)
    {
        await EnsureLoadedAsync(cancellationToken).ConfigureAwait(false);
        var publishedAt = result.CompletedAt;
        var sequence = Interlocked.Increment(ref _sequence);
        HashSet<string>? requested = null;
        string[] removedDatabases = [];
        if (result.RequestedDatabaseIds is not null)
        {
            requested = result.RequestedDatabaseIds.ToHashSet(StringComparer.Ordinal);
            if (requested.Count != result.RequestedDatabaseIds.Count ||
                !requested.SetEquals(result.Databases.Select(database => database.DatabaseId)))
                throw new InvalidOperationException(
                    "The authoritative Query Store database set must exactly match the cycle results.");
            removedDatabases = _committed.Keys.Where(databaseId => !requested.Contains(databaseId)).ToArray();
        }
        var inspections = new List<QueryStoreBuildInspection>();
        var details = _committed.Values
            .Where(state => requested is null || requested.Contains(state.DatabaseId))
            .SelectMany(state => BuildFamilies(state, publishedAt, inspections))
            .OrderBy(detail => detail.Family.FamilyId, StringComparer.Ordinal)
            .ToArray();
        LastBuildInspection = inspections.Aggregate(
            new QueryStoreBuildInspection(0, 0, 0, 0, 0, 0),
            (sum, value) => sum + value);
        var statuses = result.Databases.Select(item =>
        {
            var state = _committed.TryGetValue(item.DatabaseId, out var facts) ? facts.State : null;
            return new QueryStoreDatabaseStatusV1(
                item.DatabaseId, ContractState(item.State),
                state?.ResetEpoch ?? "", state is null ? null : result.CompletedAt,
                state?.OldestIntervalStart, item.Reason);
        }).ToArray();
        var failures = result.Databases.Count(item => item.FailureType is not null);
        var status = new QueryStoreCollectorStatusV1(
            "1.0", failures == 0 ? QueryStoreCollectorState.Ready : QueryStoreCollectorState.Partial,
            sequence, result.StartedAt, publishedAt, null, statuses,
            failures == 0
                ? "Connected Query Store history cycle published atomically."
                : $"{failures} database collections failed; their prior published history was retained.");
        var snapshot = new QueryStorePublishedSnapshot(
            "1.0", Guid.NewGuid().ToString("N"), sequence, publishedAt, details, status);

        await repository.PublishSnapshotAsync(snapshot, cancellationToken).ConfigureAwait(false);
        foreach (var databaseId in removedDatabases)
        {
            await repository.DeleteWatermarkAsync(databaseId, cancellationToken).ConfigureAwait(false);
            _committed.TryRemove(databaseId, out _);
            _staged.TryRemove(databaseId, out _);
            _pendingWatermarks.TryRemove(databaseId, out _);
        }
        statusTracker.Set(status);
        // The snapshot pointer above is the current-state commit. Watermarks follow it; a crash
        // between these writes only causes safe overlap replay, never skipped or partial history.
        foreach (var pair in _pendingWatermarks.ToArray())
        {
            await repository.StoreWatermarkAsync(pair.Value, cancellationToken).ConfigureAwait(false);
            _pendingWatermarks.TryRemove(pair.Key, out _);
        }
    }

    private async Task EnsureLoadedAsync(CancellationToken cancellationToken)
    {
        if (!_committed.IsEmpty || Volatile.Read(ref _sequence) != 0) return;
        var snapshot = await repository.ReadPublishedSnapshotAsync(cancellationToken).ConfigureAwait(false);
        if (snapshot is null)
        {
            Interlocked.CompareExchange(ref _sequence, 0, 0);
            return;
        }
        Interlocked.Exchange(ref _sequence, snapshot.Sequence);
        foreach (var group in snapshot.Families.GroupBy(detail => detail.Family.DatabaseId))
            _committed.TryAdd(group.Key, DatabaseFacts.FromPublished(group.Key, group));
    }

    private DatabaseFacts GetStage(string databaseId) =>
        _staged.TryGetValue(databaseId, out var state)
            ? state : throw new InvalidOperationException("BeginDatabaseCycleAsync must precede staging.");

    private static QueryFamilyDetailV1[] BuildFamilies(
        DatabaseFacts state,
        DateTimeOffset observedAt,
        List<QueryStoreBuildInspection> inspections)
    {
        var current = BuildCurrentFamilies(state, observedAt, out var inspection);
        inspections.Add(inspection);
        return state.ArchivedFamilies.Concat(current).ToArray();
    }

    private static void PruneCommitted(DatabaseFacts state, DateTimeOffset observedAt)
    {
        var cutoff = observedAt.AddDays(-90);
        for (var index = state.ArchivedFamilies.Count - 1; index >= 0; index--)
        {
            var archived = state.ArchivedFamilies[index];
            if (archived.Family.LastObservedAt < cutoff)
            {
                state.ArchivedFamilies.RemoveAt(index);
                continue;
            }
            state.ArchivedFamilies[index] = WithRuntimeSummary(
                archived, RetainArchivedRuntime(archived.Runtime, observedAt), cutoff);
        }
        foreach (var key in state.Runtime.Where(pair => pair.Value.Bucket.Key.IntervalEnd < cutoff)
                     .Select(pair => pair.Key).ToArray())
            state.Runtime.Remove(key);
        var runtimeKeys = state.Runtime.Values.Select(WaitBucketKey).ToHashSet();
        foreach (var key in state.Waits.Where(pair => !runtimeKeys.Contains(WaitBucketKey(pair.Value)))
                     .Select(pair => pair.Key).ToArray())
            state.Waits.Remove(key);
        var retainedPlans = state.Runtime.Values.Select(value => value.Bucket.Key.PlanId)
            .ToHashSet(StringComparer.Ordinal);
        foreach (var key in state.Plans.Where(pair =>
                     pair.Value.LastExecutionAt < cutoff && !retainedPlans.Contains(pair.Key))
                     .Select(pair => pair.Key).ToArray())
            state.Plans.Remove(key);
        var retainedQueries = state.Plans.Values.Select(plan => plan.QueryId).ToHashSet(StringComparer.Ordinal);
        foreach (var key in state.Identities.Where(pair =>
                     pair.Value.LastExecutionAt < cutoff && !retainedQueries.Contains(pair.Key))
                     .Select(pair => pair.Key).ToArray())
            state.Identities.Remove(key);
        foreach (var key in state.Variants.Where(pair =>
                     !state.Identities.ContainsKey(pair.Value.VariantQueryId) ||
                     !state.Identities.ContainsKey(pair.Value.ParentQueryId))
                     .Select(pair => pair.Key).ToArray())
            state.Variants.Remove(key);
        var textIds = state.Identities.Values.Select(identity => identity.QueryTextId)
            .ToHashSet(StringComparer.Ordinal);
        foreach (var key in state.Text.Keys.Where(key => !textIds.Contains(key)).ToArray())
            state.Text.Remove(key);
    }

    private static RuntimeBucketV1[] RetainArchivedRuntime(
        IReadOnlyList<RuntimeBucketV1> runtime,
        DateTimeOffset observedAt)
    {
        var detailCutoff = observedAt.AddDays(-7);
        var retentionCutoff = observedAt.AddDays(-90);
        var retained = runtime.Where(bucket => bucket.IntervalEnd >= detailCutoff).ToList();
        foreach (var group in runtime.Where(bucket =>
                     bucket.IntervalEnd >= retentionCutoff && bucket.IntervalEnd < detailCutoff)
                 .GroupBy(bucket => new
                 {
                     bucket.EpochId,
                     bucket.PlanId,
                     Hour = Hour(bucket.IntervalStart),
                     bucket.ExecutionType,
                     bucket.ReplicaGroupId,
                 }))
        {
            var aggregate = QueryStoreRuntimeAggregator.Aggregate(group.Select(bucket =>
                new RuntimeStatInput(
                    bucket.PlanId, bucket.IntervalId, bucket.IntervalStart, bucket.IntervalEnd,
                    bucket.ExecutionType, bucket.ReplicaGroupId,
                    BigInteger.Parse(bucket.ExecutionCount, CultureInfo.InvariantCulture),
                    bucket.AverageDurationMicroseconds, bucket.AverageCpuMicroseconds,
                    bucket.AverageLogicalReads8KiBPages))).Single();
            var waits = group.SelectMany(bucket => bucket.WaitMilliseconds)
                .GroupBy(pair => pair.Key, StringComparer.Ordinal)
                .ToDictionary(
                    pairs => pairs.Key,
                    pairs => pairs.Aggregate(BigInteger.Zero,
                            (sum, pair) => sum + BigInteger.Parse(pair.Value, CultureInfo.InvariantCulture))
                        .ToString(CultureInfo.InvariantCulture),
                    StringComparer.Ordinal);
            retained.Add(new RuntimeBucketV1(
                aggregate.Key.PlanId, $"hour:{group.Key.Hour.UtcTicks}", group.Key.EpochId,
                group.Key.Hour, group.Key.Hour.AddHours(1), group.Key.ExecutionType,
                group.Key.ReplicaGroupId, aggregate.ExecutionCount.ToString(CultureInfo.InvariantCulture),
                aggregate.AverageDurationMicroseconds, aggregate.AverageCpuMicroseconds,
                aggregate.AverageLogicalReads8KiBPages, aggregate.TotalDurationMicroseconds,
                aggregate.TotalCpuMicroseconds, aggregate.TotalLogicalReads8KiBPages, waits,
                group.OrderByDescending(bucket => bucket.IntervalEnd).First().Evidence));
        }
        return retained.OrderBy(bucket => bucket.IntervalStart)
            .ThenBy(bucket => bucket.PlanId, StringComparer.Ordinal).ToArray();
    }

    private static QueryFamilyDetailV1 WithRuntimeSummary(
        QueryFamilyDetailV1 detail,
        RuntimeBucketV1[] runtime,
        DateTimeOffset cutoff)
    {
        var count = runtime.Aggregate(
            BigInteger.Zero,
            (sum, bucket) => sum + BigInteger.Parse(bucket.ExecutionCount, CultureInfo.InvariantCulture));
        var plansWithRuntime = runtime.Select(bucket => bucket.PlanId).ToHashSet(StringComparer.Ordinal);
        return detail with
        {
            Family = detail.Family with
            {
                ExecutionCount = count.ToString(CultureInfo.InvariantCulture),
                TotalCpuMicroseconds = SumExact(runtime.Select(bucket => bucket.TotalCpuMicroseconds)),
                TotalDurationMicroseconds = SumExact(runtime.Select(bucket => bucket.TotalDurationMicroseconds)),
                TotalLogicalReads8KiBPages = SumExact(
                    runtime.Select(bucket => bucket.TotalLogicalReads8KiBPages)),
                TotalWaitMilliseconds = SumExact(
                    runtime.SelectMany(bucket => bucket.WaitMilliseconds.Values)),
                FirstObservedAt = runtime.Length > 0
                    ? runtime[0].IntervalStart : detail.Family.FirstObservedAt,
                LastObservedAt = runtime.Length > 0
                    ? runtime[^1].IntervalEnd : detail.Family.LastObservedAt,
            },
            Plans = detail.Plans.Where(plan =>
                plan.LastExecutionAt >= cutoff ||
                plansWithRuntime.Contains(plan.PlanId)).ToArray(),
            Runtime = runtime,
        };
    }

    private static List<QueryFamilyDetailV1> BuildCurrentFamilies(
        DatabaseFacts state,
        DateTimeOffset observedAt,
        out QueryStoreBuildInspection inspection)
    {
        var queryToParent = state.Variants.Values.ToDictionary(
            variant => variant.VariantQueryId, variant => variant.ParentQueryId, StringComparer.Ordinal);
        var identitiesById = state.Identities;
        var variantsByParent = state.Variants.Values.ToLookup(
            variant => variant.ParentQueryId, StringComparer.Ordinal);
        var plansByQuery = state.Plans.Values.ToLookup(plan => plan.QueryId, StringComparer.Ordinal);
        var retainedRuntime = RetainedRuntime(state, observedAt)
            .Where(bucket => bucket.Epoch == state.CurrentEpoch).ToArray();
        var runtimeByPlan = retainedRuntime.ToLookup(
            bucket => bucket.Bucket.Key.PlanId, StringComparer.Ordinal);
        var waitsByBucket = BuildWaitIndex(state.Waits.Values);
        var planLookups = 0;
        var runtimeLookups = 0;
        var waitLookups = 0;
        var results = new List<QueryFamilyDetailV1>();
        var groups = identitiesById.Values.GroupBy(identity =>
        {
            var effective = queryToParent.TryGetValue(identity.QueryId, out var parent) &&
                            identitiesById.TryGetValue(parent, out var parentIdentity)
                ? parentIdentity : identity;
            var descriptor = state.Text.TryGetValue(effective.QueryTextId, out var text)
                ? text : TextDescriptor(effective);
            return QueryFamilyIdentity.Create(state.DatabaseId, effective.QueryHash,
                descriptor.NormalizedText, effective.QueryId).FamilyId;
        });

        foreach (var group in groups)
        {
            var identities = group.ToArray();
            var queryIds = identities.Select(item => item.QueryId).ToHashSet(StringComparer.Ordinal);
            foreach (var parentId in queryIds.ToArray())
                foreach (var variant in variantsByParent[parentId])
                    queryIds.Add(variant.VariantQueryId);
            var physicalIdentities = queryIds
                .Select(queryId => identitiesById.GetValueOrDefault(queryId))
                .Where(identity => identity is not null)
                .Cast<QueryIdentityFact>()
                .DistinctBy(identity => identity.QueryId)
                .ToArray();
            var rawPlans = queryIds.SelectMany(queryId =>
                {
                    planLookups++;
                    return plansByQuery[queryId];
                })
                .OrderByDescending(plan => plan.LastExecutionAt)
                .ToArray();
            var planIds = rawPlans.Where(plan => plan.PlanType is not QueryPlanType.Dispatcher)
                .Select(plan => plan.PlanId).ToHashSet(StringComparer.Ordinal);
            var plans = rawPlans.Select(plan => PlanSummary(state.DatabaseId, plan, state.Variants)).ToArray();
            var runtime = planIds.SelectMany(planId =>
                {
                    runtimeLookups++;
                    return runtimeByPlan[planId];
                })
                .Select(bucket =>
                {
                    waitLookups += bucket.SourceIntervalIds?.Count ?? 1;
                    return RuntimeContract(state, bucket, observedAt, waitsByBucket);
                })
                .OrderBy(bucket => bucket.IntervalStart)
                .ThenBy(bucket => bucket.PlanId, StringComparer.Ordinal)
                .ToArray();
            var count = runtime.Aggregate(BigInteger.Zero,
                (sum, bucket) => sum + BigInteger.Parse(bucket.ExecutionCount, CultureInfo.InvariantCulture));
            var duration = SumExact(runtime.Select(bucket => bucket.TotalDurationMicroseconds));
            var cpu = SumExact(runtime.Select(bucket => bucket.TotalCpuMicroseconds));
            var reads = SumExact(runtime.Select(bucket => bucket.TotalLogicalReads8KiBPages));
            var waits = SumExact(runtime.SelectMany(bucket => bucket.WaitMilliseconds.Values));
            var primaryIdentity = physicalIdentities.FirstOrDefault(identity =>
                !queryToParent.ContainsKey(identity.QueryId)) ?? physicalIdentities[0];
            var descriptor = state.Text.TryGetValue(primaryIdentity.QueryTextId, out var storedText)
                ? storedText : TextDescriptor(primaryIdentity);
            var physical = physicalIdentities.Select(identity => new PhysicalQueryIdentityV1(
                state.DatabaseId, identity.QueryId, identity.QueryTextId, identity.QueryHash,
                new QueryContextSettingsV1(
                    identity.ContextSettingsId, identity.Language, identity.DateFormat,
                    identity.DateFirst, state.State?.CompatibilityLevel.ToString(CultureInfo.InvariantCulture),
                    identity.SetOptions),
                state.Text.TryGetValue(identity.QueryTextId, out var value) ? value : TextDescriptor(identity)))
                .ToArray();
            var evidence = Evidence(state, observedAt);
            var summary = new QueryFamilySummaryV1(
                group.Key, state.DatabaseId, primaryIdentity.QueryHash,
                descriptor.NormalizedTextFingerprint, descriptor, physical,
                count.ToString(CultureInfo.InvariantCulture), cpu, duration, reads, waits,
                runtime.FirstOrDefault()?.IntervalStart ?? observedAt,
                runtime.LastOrDefault()?.IntervalEnd ?? observedAt, evidence);
            results.Add(new QueryFamilyDetailV1("1.0", summary, plans, runtime));
        }
        inspection = new QueryStoreBuildInspection(
            retainedRuntime.Length, state.Plans.Count, state.Waits.Count,
            runtimeLookups, planLookups, waitLookups);
        return results;
    }

    private static QueryFamilyDetailV1 Archive(QueryFamilyDetailV1 detail, string epoch)
    {
        var token = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(epoch)))
            .ToLowerInvariant()[..12];
        var planIds = detail.Plans.ToDictionary(
            plan => plan.PlanId, plan => $"archived:{token}:{plan.PlanId}", StringComparer.Ordinal);
        var plans = detail.Plans.Select(plan => plan with
        {
            PlanId = planIds[plan.PlanId],
            QueryId = $"archived:{token}:{plan.QueryId}",
            DispatcherPlanId = plan.DispatcherPlanId is null
                ? null : planIds.GetValueOrDefault(plan.DispatcherPlanId),
        }).ToArray();
        var runtime = detail.Runtime.Select(bucket => bucket with
        {
            PlanId = planIds.GetValueOrDefault(bucket.PlanId, $"archived:{token}:{bucket.PlanId}"),
        }).ToArray();
        var family = detail.Family with
        {
            FamilyId = $"{detail.Family.FamilyId}:epoch:{token}",
            PhysicalQueries = detail.Family.PhysicalQueries.Select(identity => identity with
            {
                QueryId = $"archived:{token}:{identity.QueryId}",
            }).ToArray(),
            Evidence = detail.Family.Evidence with
            {
                Status = DataStatus.Stale,
                Reason = "Retained Query Store history from a completed reset epoch.",
            },
        };
        return detail with { Family = family, Plans = plans, Runtime = runtime };
    }

    private static QueryPlanSummaryV1 PlanSummary(
        string databaseId,
        QueryPlanFact plan,
        Dictionary<string, QueryVariantFact> variants)
    {
        var variant = variants.TryGetValue(plan.QueryId, out var value) ? value : null;
        var optimization = variant?.Optimization ??
            (plan.PlanType is QueryPlanType.Dispatcher ? QueryOptimizationKind.ParameterSensitivePlan
                : QueryOptimizationKind.None);
        return new QueryPlanSummaryV1(
            $"{databaseId}:{plan.PlanId}", plan.QueryId, plan.QueryPlanHash, plan.PlanType, optimization,
            variant is null ? null : $"{databaseId}:{variant.DispatcherPlanId}",
            plan.PlanType is not QueryPlanType.Dispatcher,
            plan.IsForced, plan.ForcingType,
            plan.ForceFailureCount.ToString(CultureInfo.InvariantCulture),
            plan.LastForceFailureReason, plan.EngineVersion, plan.CompatibilityLevel,
            plan.LastExecutionAt, new QueryStoreEvidenceV1(
                QueryStoreSource.QueryStore, DataStatus.Available, plan.LastExecutionAt, null,
                "Connected Query Store plan metadata.", "Plan metadata excludes Showplan XML."));
    }

    private static RuntimeBucketV1 RuntimeContract(
        DatabaseFacts state,
        EpochRuntimeBucket value,
        DateTimeOffset observedAt,
        IReadOnlyDictionary<WaitBucketIdentity, Dictionary<string, BigInteger>> waitsByBucket)
    {
        var bucket = value.Bucket;
        IEnumerable<string> intervalIds = value.SourceIntervalIds is null
            ? [bucket.Key.IntervalId]
            : value.SourceIntervalIds;
        var waitTotals = new Dictionary<string, BigInteger>(StringComparer.Ordinal);
        foreach (var intervalId in intervalIds)
        {
            var key = new WaitBucketIdentity(
                value.Epoch, bucket.Key.PlanId, intervalId,
                bucket.Key.ExecutionType, bucket.Key.ReplicaGroupId);
            if (!waitsByBucket.TryGetValue(key, out var categories)) continue;
            foreach (var pair in categories)
                waitTotals[pair.Key] = waitTotals.GetValueOrDefault(pair.Key) + pair.Value;
        }
        var waits = waitTotals.ToDictionary(
            pair => pair.Key,
            pair => pair.Value.ToString(CultureInfo.InvariantCulture),
            StringComparer.Ordinal);
        return new RuntimeBucketV1(
            $"{state.DatabaseId}:{bucket.Key.PlanId}", bucket.Key.IntervalId, value.Epoch,
            bucket.Key.IntervalStart, bucket.Key.IntervalEnd, bucket.Key.ExecutionType,
            bucket.Key.ReplicaGroupId, bucket.ExecutionCount.ToString(CultureInfo.InvariantCulture),
            bucket.AverageDurationMicroseconds, bucket.AverageCpuMicroseconds,
            bucket.AverageLogicalReads8KiBPages, bucket.TotalDurationMicroseconds,
            bucket.TotalCpuMicroseconds, bucket.TotalLogicalReads8KiBPages, waits,
            Evidence(state, observedAt));
    }

    private static Dictionary<WaitBucketIdentity, Dictionary<string, BigInteger>> BuildWaitIndex(
        IEnumerable<EpochWaitFact> waits)
    {
        var result = new Dictionary<WaitBucketIdentity, Dictionary<string, BigInteger>>();
        foreach (var wait in waits)
        {
            var key = WaitBucketKey(wait);
            if (!result.TryGetValue(key, out var categories))
            {
                categories = new Dictionary<string, BigInteger>(StringComparer.Ordinal);
                result.Add(key, categories);
            }
            categories[wait.Value.WaitCategory] =
                categories.GetValueOrDefault(wait.Value.WaitCategory) + wait.Value.TotalWaitMilliseconds;
        }
        return result;
    }

    private static IEnumerable<EpochRuntimeBucket> RetainedRuntime(
        DatabaseFacts state,
        DateTimeOffset observedAt)
    {
        var detailCutoff = observedAt.AddDays(-7);
        var retentionCutoff = observedAt.AddDays(-90);
        foreach (var value in state.Runtime.Values.Where(value =>
                     value.Bucket.Key.IntervalEnd >= detailCutoff))
            yield return value;

        var historical = state.Runtime.Values.Where(value =>
            value.Bucket.Key.IntervalEnd >= retentionCutoff &&
            value.Bucket.Key.IntervalEnd < detailCutoff);
        foreach (var group in historical.GroupBy(value =>
                 new RollupKey(
                     value.Epoch, value.Bucket.Key.PlanId,
                     Hour(value.Bucket.Key.IntervalStart),
                     value.Bucket.Key.ExecutionType, value.Bucket.Key.ReplicaGroupId)))
        {
            var rows = group.Select(value => new RuntimeStatInput(
                value.Bucket.Key.PlanId,
                $"hour:{group.Key.HourStart.UtcTicks}",
                group.Key.HourStart, group.Key.HourStart.AddHours(1),
                group.Key.ExecutionType, group.Key.ReplicaGroupId,
                value.Bucket.ExecutionCount,
                value.Bucket.AverageDurationMicroseconds,
                value.Bucket.AverageCpuMicroseconds,
                value.Bucket.AverageLogicalReads8KiBPages));
            yield return new EpochRuntimeBucket(
                group.Key.Epoch, QueryStoreRuntimeAggregator.Aggregate(rows).Single(), false,
                group.Select(value => value.Bucket.Key.IntervalId).ToHashSet(StringComparer.Ordinal));
        }
    }

    private static DateTimeOffset Hour(DateTimeOffset value)
    {
        var utc = value.UtcDateTime;
        return new DateTimeOffset(utc.Year, utc.Month, utc.Day, utc.Hour, 0, 0, TimeSpan.Zero);
    }

    private static QueryTextDescriptorV1 TextDescriptor(QueryIdentityFact identity) =>
        identity.IsEncrypted
            ? new(QueryTextAvailability.Encrypted, null, null, "Query text belongs to an encrypted module.")
            : identity.IsRestricted
                ? new(QueryTextAvailability.Restricted, null, null, "Query Store marks text as restricted.")
                : new(QueryTextAvailability.Missing, null, null,
                    "Raw text has not been requested and this physical query is not merged by hash alone.");

    private static QueryStoreEvidenceV1 Evidence(DatabaseFacts state, DateTimeOffset observedAt) =>
        new(QueryStoreSource.QueryStore,
            state.State?.State == QueryStoreCollectionState.ReadOnly ? DataStatus.Stale : DataStatus.Available,
            observedAt, observedAt.AddMinutes(3), state.State?.Reason ?? "Connected Query Store history.",
            "Aggregate query runtime only; no actual operator metrics.");

    private static string SumExact(IEnumerable<string> values)
    {
        var accumulator = new QueryStoreRuntimeAggregator.BigDecimalAccumulator();
        foreach (var value in values)
            accumulator.AddExact(value);
        return accumulator.ToExactString();
    }

    private static string RuntimeKey(string epoch, RuntimeBucketKey key) =>
        $"{epoch}|{key.PlanId}|{key.IntervalId}|{(int)key.ExecutionType}|{key.ReplicaGroupId}";
    private static string WaitKey(string epoch, QueryWaitFact wait) =>
        $"{epoch}|{wait.PlanId}|{wait.IntervalId}|{(int)wait.ExecutionType}|{wait.ReplicaGroupId}|{wait.WaitCategoryId}";
    private static WaitBucketIdentity WaitBucketKey(EpochRuntimeBucket runtime) =>
        new(runtime.Epoch, runtime.Bucket.Key.PlanId, runtime.Bucket.Key.IntervalId,
            runtime.Bucket.Key.ExecutionType, runtime.Bucket.Key.ReplicaGroupId);
    private static WaitBucketIdentity WaitBucketKey(EpochWaitFact wait) =>
        new(wait.Epoch, wait.Value.PlanId, wait.Value.IntervalId,
            wait.Value.ExecutionType, wait.Value.ReplicaGroupId);
    private static QueryStoreCollectionStateV1 ContractState(QueryStoreCollectionState state) => state switch
    {
        QueryStoreCollectionState.ReadWrite => QueryStoreCollectionStateV1.ReadWrite,
        QueryStoreCollectionState.ReadOnly => QueryStoreCollectionStateV1.ReadOnly,
        QueryStoreCollectionState.ReadCaptureSecondary => QueryStoreCollectionStateV1.ReadCaptureSecondary,
        QueryStoreCollectionState.Off => QueryStoreCollectionStateV1.Off,
        QueryStoreCollectionState.Error => QueryStoreCollectionStateV1.Error,
        QueryStoreCollectionState.PermissionDenied => QueryStoreCollectionStateV1.PermissionDenied,
        QueryStoreCollectionState.Unsupported => QueryStoreCollectionStateV1.Unsupported,
        _ => QueryStoreCollectionStateV1.Unknown,
    };

    private sealed class DatabaseFacts(string databaseId)
    {
        public string DatabaseId { get; } = databaseId;
        public QueryStoreDatabaseState? State { get; set; }
        public string CurrentEpoch { get; set; } = "";
        public Dictionary<string, QueryIdentityFact> Identities { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, QueryPlanFact> Plans { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, EpochRuntimeBucket> Runtime { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, EpochWaitFact> Waits { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, QueryVariantFact> Variants { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, QueryReplicaFact> Replicas { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, QueryTextDescriptorV1> Text { get; } = new(StringComparer.Ordinal);
        public List<QueryFamilyDetailV1> ArchivedFamilies { get; } = [];

        public DatabaseFacts Clone()
        {
            var clone = new DatabaseFacts(DatabaseId) { State = State, CurrentEpoch = CurrentEpoch };
            Copy(Identities, clone.Identities); Copy(Plans, clone.Plans); Copy(Runtime, clone.Runtime);
            Copy(Waits, clone.Waits); Copy(Variants, clone.Variants); Copy(Replicas, clone.Replicas);
            Copy(Text, clone.Text);
            clone.ArchivedFamilies.AddRange(ArchivedFamilies);
            return clone;
        }

        public static DatabaseFacts FromPublished(
            string databaseId,
            IEnumerable<QueryFamilyDetailV1> details)
        {
            var state = new DatabaseFacts(databaseId);
            foreach (var detail in details)
            {
                if (detail.Family.FamilyId.Contains(":epoch:", StringComparison.Ordinal))
                {
                    state.ArchivedFamilies.Add(detail);
                    continue;
                }
                foreach (var physical in detail.Family.PhysicalQueries)
                {
                    state.Identities[physical.QueryId] = new QueryIdentityFact(
                        physical.QueryId, physical.QueryTextId, physical.Context.ContextSettingsId,
                        physical.QueryHash, detail.Family.LastObservedAt,
                        physical.Text.Availability == QueryTextAvailability.Encrypted,
                        physical.Text.Availability == QueryTextAvailability.Restricted,
                        physical.Context.SetOptions, physical.Context.Language,
                        physical.Context.DateFormat, physical.Context.DateFirst);
                    state.Text[physical.QueryTextId] = physical.Text;
                }
                foreach (var plan in detail.Plans)
                    state.Plans[RawId(databaseId, plan.PlanId)] = new QueryPlanFact(
                        RawId(databaseId, plan.PlanId), plan.QueryId, plan.QueryPlanHash, plan.PlanType,
                        plan.DispatcherPlanId is null ? null : RawId(databaseId, plan.DispatcherPlanId),
                        plan.IsForced, plan.ForcingType,
                        BigInteger.Parse(plan.ForceFailureCount, CultureInfo.InvariantCulture),
                        plan.LastForceFailureReason, plan.EngineVersion, plan.CompatibilityLevel,
                        plan.LastExecutionAt);
                foreach (var runtime in detail.Runtime)
                {
                    // Pre-v1.0 snapshots combined epoch and interval into one opaque field.
                    // Keep that field intact: colon delimiters are ambiguous for real epoch IDs.
                    var epoch = string.IsNullOrWhiteSpace(runtime.EpochId)
                        ? LegacyEpoch(databaseId)
                        : runtime.EpochId;
                    var intervalId = runtime.IntervalId;
                    state.CurrentEpoch = epoch;
                    var key = new RuntimeBucketKey(
                        RawId(databaseId, runtime.PlanId), intervalId, runtime.IntervalStart, runtime.IntervalEnd,
                        runtime.ExecutionType, runtime.ReplicaGroupId);
                    var bucket = new AggregatedRuntimeBucket(
                        key, BigInteger.Parse(runtime.ExecutionCount, CultureInfo.InvariantCulture),
                        runtime.AverageDurationMicroseconds, runtime.AverageCpuMicroseconds,
                        runtime.AverageLogicalReads8KiBPages, runtime.TotalDurationMicroseconds,
                        runtime.TotalCpuMicroseconds, runtime.TotalLogicalReads8KiBPages);
                    state.Runtime[RuntimeKey(epoch, key)] = new EpochRuntimeBucket(epoch, bucket, false);
                    foreach (var wait in runtime.WaitMilliseconds)
                    {
                        var fact = new QueryWaitFact(
                            runtime.PlanId, intervalId, runtime.ExecutionType, runtime.ReplicaGroupId,
                            0, wait.Key, BigInteger.Parse(wait.Value, CultureInfo.InvariantCulture));
                        state.Waits[WaitKey(epoch, fact)] = new EpochWaitFact(epoch, fact);
                    }
                }
            }
            return state;
        }

        private static void Copy<TKey, TValue>(
            IReadOnlyDictionary<TKey, TValue> source,
            IDictionary<TKey, TValue> destination) where TKey : notnull
        {
            foreach (var pair in source) destination.Add(pair.Key, pair.Value);
        }

        private static string RawId(string databaseId, string id)
        {
            var prefix = databaseId + ":";
            return id.StartsWith(prefix, StringComparison.Ordinal) ? id[prefix.Length..] : id;
        }

        private static string LegacyEpoch(string databaseId)
        {
            var digest = SHA256.HashData(Encoding.UTF8.GetBytes(databaseId));
            return $"legacy-restored:{Convert.ToHexString(digest).ToLowerInvariant()[..16]}";
        }
    }

    private sealed record EpochRuntimeBucket(
        string Epoch,
        AggregatedRuntimeBucket Bucket,
        bool ActiveInterval,
        IReadOnlySet<string>? SourceIntervalIds = null);

    private sealed record EpochWaitFact(string Epoch, QueryWaitFact Value);

    private readonly record struct WaitBucketIdentity(
        string Epoch,
        string PlanId,
        string IntervalId,
        QueryStoreExecutionType ExecutionType,
        string ReplicaGroupId);

    private sealed record RollupKey(
        string Epoch,
        string PlanId,
        DateTimeOffset HourStart,
        QueryStoreExecutionType ExecutionType,
        string ReplicaGroupId);
}

public readonly record struct QueryStoreBuildInspection(
    int RuntimeRowsIndexed,
    int PlanRowsIndexed,
    int WaitRowsIndexed,
    int RuntimeIndexLookups,
    int PlanIndexLookups,
    int WaitIndexLookups)
{
    public static QueryStoreBuildInspection operator +(
        QueryStoreBuildInspection left,
        QueryStoreBuildInspection right) =>
        new(
            left.RuntimeRowsIndexed + right.RuntimeRowsIndexed,
            left.PlanRowsIndexed + right.PlanRowsIndexed,
            left.WaitRowsIndexed + right.WaitRowsIndexed,
            left.RuntimeIndexLookups + right.RuntimeIndexLookups,
            left.PlanIndexLookups + right.PlanIndexLookups,
            left.WaitIndexLookups + right.WaitIndexLookups);
}
