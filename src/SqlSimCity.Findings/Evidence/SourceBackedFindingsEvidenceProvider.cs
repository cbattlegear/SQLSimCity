using System.Xml;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;
using SqlSimCity.Findings.Engine;

namespace SqlSimCity.Findings.Evidence;

/// <summary>
/// The default <see cref="IFindingsEvidenceProvider"/>. It assembles a bundle from the registered
/// atlas, Query Store history, capability, and (optionally) live-incident sources, exactly as a human
/// would by opening each tab. It is bounded: it pages a small number of top families per ranking metric,
/// deduplicates them, loads detail only for that bounded set, and loads at most a capped number of
/// Showplans. It therefore stays bounded even against a 100k-family target, and it never opens its own
/// SQL connection -- it consumes whatever the already-wired sources return.
/// </summary>
/// <remarks>
/// <para>
/// Bounded is not the same as cheap. Measured against a seeded instance (79 families, 79 plans), one
/// assembly costs 351 ms, of which 337 ms is the per-candidate <c>GetFamilyAsync</c> and
/// <c>GetPlanAsync</c> point reads of the protected store; the rules that consume the result cost
/// 1.7 ms. Every findings route paid that on every request, including <c>/findings/status</c>, which
/// returns only a status document. So the Query Store half of the bundle is cached against the
/// generation it came from -- see <see cref="QueryStoreEvidence"/> -- which takes the same assembly
/// to 3.3 ms, essentially the one status read needed to establish the key.
/// </para>
/// <para>
/// Only that half. Atlas, capabilities, live incidents, and the clock are re-read on every call
/// because they are in-memory reads that cost nothing (measured: 0.4 ms to serve the whole atlas)
/// and because live evidence advances every 2-5 seconds. Caching the whole bundle on a key that
/// included the live sequence would invalidate constantly and cache nothing; caching it on a key that
/// did not would serve findings derived from live evidence that has since changed.
/// </para>
/// </remarks>
public sealed class SourceBackedFindingsEvidenceProvider : IFindingsEvidenceProvider
{
    private const int FamiliesPerMetricPage = 50;

    private readonly IAtlasSnapshotSource _atlas;
    private readonly IQueryStoreHistorySource _queryStore;
    private readonly ICapabilitiesSource _capabilities;
    private readonly Func<LiveIncidentSnapshotV1?> _liveSnapshot;
    private readonly TimeProvider _timeProvider;
    private readonly FindingsEvidenceOptions _options;
    private readonly Lock _assembly = new();

    private QueryStoreEvidence? _cached;
    private (QueryStoreGeneration Generation, Task<QueryStoreEvidence> Task)? _inFlight;

    public SourceBackedFindingsEvidenceProvider(
        IAtlasSnapshotSource atlas,
        IQueryStoreHistorySource queryStore,
        ICapabilitiesSource capabilities,
        Func<LiveIncidentSnapshotV1?> liveSnapshot,
        TimeProvider timeProvider,
        FindingsEvidenceOptions? options = null)
    {
        _atlas = atlas ?? throw new ArgumentNullException(nameof(atlas));
        _queryStore = queryStore ?? throw new ArgumentNullException(nameof(queryStore));
        _capabilities = capabilities ?? throw new ArgumentNullException(nameof(capabilities));
        _liveSnapshot = liveSnapshot ?? throw new ArgumentNullException(nameof(liveSnapshot));
        _timeProvider = timeProvider ?? throw new ArgumentNullException(nameof(timeProvider));
        _options = options ?? new FindingsEvidenceOptions();
        _options.Validate();
    }

    public async Task<FindingsEvidenceBundle> GetBundleAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var generatedAt = _timeProvider.GetUtcNow();
        var atlas = _atlas.GetCurrent();
        var capabilities = SafeCapabilities();
        var live = _liveSnapshot();
        var status = await _queryStore.GetStatusAsync(cancellationToken).ConfigureAwait(false);

        var queryStore = await GetQueryStoreEvidenceAsync(
            QueryStoreGeneration.Of(status), cancellationToken).ConfigureAwait(false);

        return new FindingsEvidenceBundle(
            atlas.Target.TargetId,
            atlas.Target.DisplayName,
            generatedAt,
            capabilities,
            atlas,
            live,
            status,
            queryStore.Families,
            queryStore.Plans,
            queryStore.Reason);
    }

    /// <summary>
    /// The Query Store half of one bundle, together with the published generation it was read from.
    /// It is a pure function of that generation, so it is safe to reuse for as long as the generation
    /// stands and must be discarded the moment it moves.
    /// </summary>
    private sealed record QueryStoreEvidence(
        QueryStoreGeneration Generation,
        IReadOnlyList<QueryFamilyDetailV1> Families,
        IReadOnlyList<NormalizedShowplanV1> Plans,
        string Reason);

    /// <summary>
    /// Identifies one published Query Store snapshot. <see cref="QueryStoreCollectorStatusV1.Sequence"/>
    /// is incremented once per atomic publish and <see cref="QueryStoreCollectorStatusV1.LastPublishedAt"/>
    /// is stamped by the same publish, so together they change exactly when the families and plans behind
    /// them change -- including across a restart that rebuilt the store from scratch and restarted the
    /// counter. Deliberately excluded: <see cref="QueryStoreCollectorStatusV1.State"/>, which moves to
    /// <c>Collecting</c> and back on every cycle while the published content stands still, and would
    /// throw the cache away for no reason.
    /// </summary>
    private readonly record struct QueryStoreGeneration(long Sequence, DateTimeOffset? LastPublishedAt)
    {
        public static QueryStoreGeneration Of(QueryStoreCollectorStatusV1 status) =>
            new(status.Sequence, status.LastPublishedAt);
    }

    private Task<QueryStoreEvidence> GetQueryStoreEvidenceAsync(
        QueryStoreGeneration generation, CancellationToken cancellationToken)
    {
        if (Volatile.Read(ref _cached) is { } hit && hit.Generation == generation)
            return Task.FromResult(hit);

        Task<QueryStoreEvidence> assembly;
        lock (_assembly)
        {
            if (Volatile.Read(ref _cached) is { } filled && filled.Generation == generation)
                return Task.FromResult(filled);

            // Single-flight. A cold cache under concurrent requests assembles once and every caller
            // waits on that one assembly, rather than each paying the full cost against the same
            // store. The assembly itself runs uncancellable so that one caller giving up cannot
            // cancel the work the others are waiting on; each caller abandons its own wait below,
            // which also means a client that connects and disconnects repeatedly still leaves a
            // populated cache behind instead of restarting the work every time. Only an assembly
            // still in flight is shared: once one finishes, either it retained its result and the
            // fast path above serves it, or it straddled a publish and must not be handed out again.
            assembly = _inFlight is { } running &&
                running.Generation == generation && !running.Task.IsCompleted
                ? running.Task
                : StartAssembly(generation);
        }

        return assembly.WaitAsync(cancellationToken);
    }

    private Task<QueryStoreEvidence> StartAssembly(QueryStoreGeneration generation)
    {
        // Off the lock deliberately. The connected source reads SQLite, whose async surface completes
        // synchronously, so an inline assembly would hold this lock for the whole 400 ms.
        var assembly = Task.Run(() => AssembleAsync(generation, CancellationToken.None));
        _inFlight = (generation, assembly);
        return assembly;
    }

    private async Task<QueryStoreEvidence> AssembleAsync(
        QueryStoreGeneration generation, CancellationToken cancellationToken)
    {
        var familyIds = await SelectTopFamilyIdsAsync(cancellationToken).ConfigureAwait(false);
        var families = new List<QueryFamilyDetailV1>(familyIds.Count);
        var unreadableFamilies = new List<string>();
        foreach (var familyId in familyIds)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var read = await _queryStore.ReadFamilyAsync(familyId, cancellationToken).ConfigureAwait(false);
            if (read.Value is { } detail)
                families.Add(detail);
            else if (read.Outcome == QueryStoreReadOutcome.Unavailable)
                unreadableFamilies.Add($"{familyId}: {read.Reason}");
        }

        var plans = await LoadPlansAsync(families, cancellationToken).ConfigureAwait(false);

        var reason = families.Count == 0
            ? "No Query Store families were available; findings rest on atlas, capability, and live evidence only."
            : $"Bounded evaluation over the top {families.Count} query families (cap {_options.MaxFamilies}) plus atlas, capability, and live evidence.";
        if (plans.Skipped.Count > 0)
        {
            // Disclosed rather than silently dropped: a plan that cannot be normalized is missing
            // evidence, and the Showplan rules must not be read as if it had been examined.
            reason += Disclose(
                plans.Skipped,
                "Showplan(s) could not be normalized and were excluded from Showplan rules");
        }
        if (plans.Unreadable.Count > 0)
        {
            // A different failure, and deliberately worded as one. A Showplan the source could not
            // read says nothing about the plan itself; the evaluation is simply short of evidence it
            // expected to have, and would otherwise present as though it had examined everything.
            reason += Disclose(
                plans.Unreadable,
                "Showplan(s) could not be read from the Query Store source, so the Showplan rules ran on incomplete evidence");
        }
        if (unreadableFamilies.Count > 0)
        {
            reason += Disclose(
                unreadableFamilies,
                "query family read(s) failed against the Query Store source, so this evaluation is missing families it selected");
        }

        var evidence = new QueryStoreEvidence(generation, families, plans.Plans, reason);

        // Families and plans are read one at a time, so a publish part-way through leaves an
        // assembly that straddles two snapshots. That result is returned -- it is exactly what this
        // provider has always returned, and the caller sees the status it was assembled against --
        // but it is never retained, because it does not describe any single generation and would
        // then be served as though it did.
        var after = QueryStoreGeneration.Of(
            await _queryStore.GetStatusAsync(cancellationToken).ConfigureAwait(false));
        if (after == generation)
            Volatile.Write(ref _cached, evidence);

        return evidence;
    }

    /// <summary>One disclosure sentence, naming the first few items and counting the rest.</summary>
    private static string Disclose(IReadOnlyList<string> items, string lead) =>
        $" {items.Count} {lead}: " +
        string.Join("; ", items.Take(3)) +
        (items.Count > 3 ? "; …" : string.Empty);

    private CapabilitiesSnapshotV1? SafeCapabilities()
    {
        try { return _capabilities.GetCurrent(); }
        catch (NotSupportedException) { return null; }
    }

    private async Task<IReadOnlyList<string>> SelectTopFamilyIdsAsync(CancellationToken cancellationToken)
    {
        // Page a bounded number of top families per ranking metric and union them. This is the bounded
        // projection: it never enumerates the whole store, only the highest-impact candidates.
        var ordered = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var metric in _options.Metrics)
        {
            cancellationToken.ThrowIfCancellationRequested();
            PageV1<QueryFamilySummaryV1> page;
            try
            {
                page = await _queryStore.GetQueriesAsync(null, metric, FamiliesPerMetricPage, null, cancellationToken).ConfigureAwait(false);
            }
            catch (QueryStorePageTokenException) { continue; }

            foreach (var summary in page.Items)
            {
                if (ordered.Count >= _options.MaxFamilies)
                    return ordered;
                if (seen.Add(summary.FamilyId))
                    ordered.Add(summary.FamilyId);
            }
        }
        return ordered;
    }

    /// <summary>
    /// The plans that loaded, a reason for every plan that could not be normalized, and a reason for
    /// every plan the source could not read at all. The last two are kept apart because they are
    /// different facts: <see cref="PlanLoad.Skipped"/> is about the Showplan, and
    /// <see cref="PlanLoad.Unreadable"/> is about the source that was asked for it.
    /// </summary>
    private sealed record PlanLoad(
        IReadOnlyList<NormalizedShowplanV1> Plans,
        IReadOnlyList<string> Skipped,
        IReadOnlyList<string> Unreadable);

    private async Task<PlanLoad> LoadPlansAsync(
        IReadOnlyList<QueryFamilyDetailV1> families, CancellationToken cancellationToken)
    {
        if (_options.MaxPlans == 0)
            return new PlanLoad([], [], []);
        var planIds = families
            .SelectMany(family => family.Plans.Select(plan => plan.PlanId))
            .Distinct(StringComparer.Ordinal)
            .Take(_options.MaxPlans)
            .ToArray();
        var plans = new List<NormalizedShowplanV1>(planIds.Length);
        var skipped = new List<string>();
        var unreadable = new List<string>();
        foreach (var planId in planIds)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                var read = await _queryStore.ReadPlanAsync(planId, cancellationToken).ConfigureAwait(false);
                if (read.Value is { } plan)
                    plans.Add(plan);
                else if (read.Outcome == QueryStoreReadOutcome.Unavailable)
                    unreadable.Add($"{planId}: {read.Reason}");
            }
            // One unusable Showplan -- oversized, malformed, or unreadable -- must never take down the
            // whole findings evaluation. Every other source in the bundle is still valid evidence.
            catch (XmlException ex)
            {
                skipped.Add($"{planId}: {ex.Message}");
            }
            catch (InvalidDataException ex)
            {
                skipped.Add($"{planId}: {ex.Message}");
            }
        }
        return new PlanLoad(plans, skipped, unreadable);
    }
}
