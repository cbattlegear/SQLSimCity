using System.Collections.ObjectModel;
using System.Globalization;
using System.Numerics;
using System.Xml;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;
using SqlSimCity.Domain.DatabaseCity;

namespace SqlSimCity.Collection.DatabaseCity;

/// <summary>
/// One catalog object on the current bounded city page, in the shape the plan-attribution join
/// needs: the contract id exposure is attributed to, and the schema-qualified name a normalized
/// showplan object reference is matched against.
/// </summary>
public sealed record CityAttributionObject(
    string ObjectId,
    string SchemaName,
    string ObjectName,
    DatabaseObjectKind Kind);

/// <summary>
/// The joined result. <see cref="ExposureByObjectId"/> only contains objects that at least one
/// single-object plan named; an absent object has no attributed exposure evidence, which is not
/// the same as zero exposure.
/// </summary>
public sealed record CityAttributionResult(
    IReadOnlyList<DatabaseCityQueryEvidence> Families,
    DatabaseCityWorkloadAggregateV1 OtherWorkload,
    IReadOnlyList<DatabaseCityRouteV1> Routes,
    IReadOnlyDictionary<string, DatabaseCityAttributedExposureV1> ExposureByObjectId,
    EvidenceV1 Evidence)
{
    /// <summary>The exact namespace attested by all returned family summaries, never a catalog alias.</summary>
    public string? QueryStoreDatabaseId { get; init; }
}

/// <summary>
/// Joins Query Store query families to the catalog objects of a bounded database-city page by
/// reading each family's normalized compiled plans and resolving their showplan object references.
/// <para>
/// The join never guesses. A plan that names several objects keeps its totals at query level and
/// is never divided between them, and never handed whole to whichever object happens to be on this
/// page. A reference that names a real object outside the current page is reported as off-page
/// rather than dropped, and a reference that names another database becomes a cross-database route
/// instead of local exposure.
/// </para>
/// </summary>
public sealed class QueryStoreCityAttribution(
    IQueryStoreHistorySource queryStore,
    TimeSpan? trafficWindow = null,
    TimeProvider? timeProvider = null)
{
    /// <summary>
    /// How far back a street's colour is graded from.
    /// <para>
    /// Fifteen minutes, not the retained horizon. A city map is read the way a traffic map is read
    /// -- "what is congested now" -- and an average taken over a day of history answers a different
    /// question, one where a morning batch job goes on colouring a street red all afternoon. The
    /// retained horizon still decides which streets exist; this decides what colour they are.
    /// </para>
    /// </summary>
    public static readonly TimeSpan DefaultTrafficWindow = TimeSpan.FromMinutes(15);

    /// <summary>The narrowest and widest traffic window an operator may configure.</summary>
    public static readonly TimeSpan MinimumTrafficWindow = TimeSpan.FromMinutes(1);

    public static readonly TimeSpan MaximumTrafficWindow = TimeSpan.FromDays(1);

    private readonly TimeSpan _trafficWindow = Validated(trafficWindow ?? DefaultTrafficWindow);
    private readonly TimeProvider _clock = timeProvider ?? TimeProvider.System;

    private static TimeSpan Validated(TimeSpan window) =>
        window < MinimumTrafficWindow || window > MaximumTrafficWindow
            ? throw new ArgumentOutOfRangeException(
                nameof(window),
                window,
                $"The city traffic window must be between {MinimumTrafficWindow.TotalMinutes:0} and " +
                $"{MaximumTrafficWindow.TotalMinutes:0} minutes.")
            : window;

    /// <summary>
    /// Families requested per page.
    /// <para>
    /// Twelve was the fixture city's top-N, and carrying it into connected mode made the live map
    /// far thinner than the instance it was watching. The families are the only thing a live
    /// execution can be matched to -- the join is <c>query_hash</c> against this list -- so a
    /// twelve-row list left almost every sampled request unmatched: measured against a seeded
    /// database holding 237 captured families, all eight live executions in a sample matched none
    /// of the published twelve, so the feed listed eight rows that could not be clicked and the map
    /// drew no traffic at all.
    /// </para>
    /// <para>
    /// The cost of raising it is plan hydration, which is bounded separately by
    /// <see cref="MaxPlansPerPage"/> and is what actually makes a page slow. That bound is what
    /// makes this number safe to raise: a family whose plans do not fit is still published, with its
    /// plans disclosed as skipped, rather than making the page arbitrarily expensive.
    /// </para>
    /// </summary>
    public const int DefaultTopFamilyCount = 48;

    /// <summary>Compiled plans hydrated for one family before the rest are disclosed as skipped.</summary>
    public const int MaxPlansPerFamily = 8;

    /// <summary>
    /// Compiled plans hydrated for one page across every family.
    /// <para>
    /// Deliberately not <see cref="DefaultTopFamilyCount"/> times <see cref="MaxPlansPerFamily"/>.
    /// A query family overwhelmingly has one plan -- a seeded database with 245 families reported
    /// exactly one plan for every one of them -- so this budget is not the common cost, it is the
    /// ceiling on a pathological workload that has recompiled the same query dozens of times. It is
    /// raised alongside the family count so that the ordinary one-plan-per-family case fits with
    /// room to spare, and it goes on bounding the bad case at a fixed number of hydrations however
    /// many families are asked for.
    /// </para>
    /// </summary>
    public const int MaxPlansPerPage = 192;

    /// <summary>
    /// The largest family count a caller may ask for.
    /// <para>
    /// A ceiling exists because attribution runs on every city page request and its cost is linear
    /// in this number: measured against a seeded database, one page took 153ms at twelve families
    /// and 382ms at forty-eight, or roughly 8ms per family per request. "Every family Query Store
    /// retained" is therefore not an option -- that database held 237, and a busy production
    /// instance retains tens of thousands, which would put a single page into the minutes.
    /// </para>
    /// <para>
    /// It is nonetheless far above <see cref="DefaultTopFamilyCount"/>, because the number that
    /// suits an instance is a property of that instance. An operator watching a small database can
    /// raise it and pay a second per page knowingly; the ceiling only stops a configuration
    /// mistake from making the page effectively unavailable.
    /// </para>
    /// </summary>
    public const int MaxTopFamilyCount = 250;

    private static readonly EvidenceV1 UnavailableEvidence = new(
        EvidenceSource.NotProbed, DataStatus.Unknown, null, null,
        "No Query Store history source is available for this page, so no plan attribution was attempted.");

    /// <param name="databaseName">
    /// The SQL database name. It is both the key connected Query Store history is collected and
    /// indexed under, and the name a three-part showplan reference is matched against to decide
    /// whether it stays local. It is deliberately not the atlas contract id the city page is
    /// addressed by: that id matches no published Query Store index set, which would silently
    /// unattribute every object on the page.
    /// </param>
    /// <param name="trafficWindowEnd">The catalog walk's pinned end, shared by every continuation page.</param>
    public async Task<CityAttributionResult> AttributeAsync(
        string databaseName,
        DatabaseCityMetric metric,
        IReadOnlyList<CityAttributionObject> pageObjects,
        IReadOnlyDictionary<string, string> databaseIdsByName,
        int topFamilyCount,
        CancellationToken cancellationToken,
        DateTimeOffset? trafficWindowEnd = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databaseName);
        ArgumentNullException.ThrowIfNull(pageObjects);
        ArgumentNullException.ThrowIfNull(databaseIdsByName);
        if (topFamilyCount is < 1 or > MaxTopFamilyCount)
            throw new ArgumentOutOfRangeException(nameof(topFamilyCount));

        PageV1<QueryFamilySummaryV1> page;
        try
        {
            page = await queryStore.GetQueriesAsync(
                databaseName, MetricToken(metric), topFamilyCount, null, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception) when (exception is ProbeExecutionException or InvalidDataException)
        {
            return Unavailable(new EvidenceV1(
                EvidenceSource.QueryStoreAggregate, DataStatus.Unknown, null, null,
                $"Query Store history could not be read for this page: {exception.Message}"));
        }

        var pageEvidence = ToEvidence(page.Evidence);
        if (page.Items.Count == 0)
            return Unavailable(pageEvidence);

        var index = new PageObjectIndex(pageObjects, databaseName, databaseIdsByName);
        var families = new List<DatabaseCityQueryEvidence>(page.Items.Count);
        var exposureEligible = new List<DatabaseCityQueryEvidence>(page.Items.Count);
        var routes = new RouteAccumulator(pageEvidence);
        var planBudget = MaxPlansPerPage;
        var windowEnd = trafficWindowEnd ?? _clock.GetUtcNow();

        foreach (var summary in page.Items)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var resolved = await AttributeFamilyAsync(
                summary, index, routes, planBudget, windowEnd, cancellationToken).ConfigureAwait(false);
            planBudget -= resolved.PlansHydrated;
            families.Add(resolved.Family);
            if (resolved.ExposureEligible)
                exposureEligible.Add(resolved.Family);
        }

        var queryStoreDatabaseId = page.Items[0].DatabaseId;
        return new CityAttributionResult(
            families,
            OtherWorkload(page, families.Count, pageEvidence),
            routes.Build(),
            BuildExposure(families, exposureEligible, index, pageEvidence),
            pageEvidence)
        {
            QueryStoreDatabaseId = !string.IsNullOrWhiteSpace(queryStoreDatabaseId) &&
                StringComparer.OrdinalIgnoreCase.Equals(queryStoreDatabaseId, databaseName) &&
                page.Items.All(summary => StringComparer.Ordinal.Equals(summary.DatabaseId, queryStoreDatabaseId))
                    ? queryStoreDatabaseId
                    : null,
        };
    }

    private async Task<ResolvedFamily> AttributeFamilyAsync(
        QueryFamilySummaryV1 summary,
        PageObjectIndex index,
        RouteAccumulator routes,
        int planBudget,
        DateTimeOffset trafficWindowEnd,
        CancellationToken cancellationToken)
    {
        QueryFamilyDetailV1? detail = null;
        try
        {
            detail = await queryStore.GetFamilyAsync(summary.FamilyId, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception) when (exception is ProbeExecutionException or InvalidDataException)
        {
            return new ResolvedFamily(Unattributed(summary, ReadOnlyDictionary<string, string>.Empty,
                $"Query Store detail for this family could not be read: {exception.Message}"), 0);
        }

        if (detail is null)
        {
            return new ResolvedFamily(Unattributed(summary, ReadOnlyDictionary<string, string>.Empty,
                "Query Store no longer holds detail for this family, so no plan named any object."), 0);
        }

        var counters = detail.Family;
        var waits = WaitCategories(detail, counters.TotalWaitMilliseconds);
        var local = new SortedSet<string>(StringComparer.Ordinal);
        var offPage = new SortedSet<string>(StringComparer.Ordinal);
        var crossDatabase = new SortedSet<string>(StringComparer.Ordinal);
        var unresolved = new SortedSet<string>(StringComparer.Ordinal);
        var costs = new PlanCostAccumulator();
        var volumes = new PlanDataVolumeAccumulator();
        var hydrated = 0;
        var skipped = 0;
        var unreadable = 0;
        var normalizationFailures = 0;

        foreach (var plan in detail.Plans.OrderBy(item => item.PlanId, StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (hydrated >= MaxPlansPerFamily || hydrated >= planBudget) { skipped++; continue; }
            NormalizedShowplanV1? showplan;
            hydrated++;
            try
            {
                showplan = await queryStore.GetPlanAsync(plan.PlanId, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception exception) when (exception is ProbeExecutionException or InvalidDataException)
            {
                unreadable++;
                continue;
            }
            catch (XmlException)
            {
                unreadable++;
                normalizationFailures++;
                continue;
            }

            if (showplan is null) { unreadable++; continue; }

            var planLocal = new SortedSet<string>(StringComparer.Ordinal);
            var planRemote = new SortedSet<string>(StringComparer.Ordinal);
            foreach (var node in showplan.Nodes)
            {
                if (node.ObjectReference is not { } reference) continue;
                switch (index.Resolve(reference))
                {
                    case { Kind: ReferenceKind.OnPage, Value: { } onPage }:
                        planLocal.Add(onPage);
                        break;
                    case { Kind: ReferenceKind.OffPage, Value: { } name }:
                        offPage.Add(name);
                        break;
                    case { Kind: ReferenceKind.CrossDatabase, Value: { } remote }:
                        planRemote.Add(remote);
                        break;
                    case { Kind: ReferenceKind.Unresolvable, Value: { } unnamed }:
                        unresolved.Add(unnamed);
                        break;
                    default:
                        break;
                }
            }

            local.UnionWith(planLocal);
            crossDatabase.UnionWith(planRemote);
            routes.AddPlan(planLocal, planRemote);
            costs.AddPlan(plan.PlanId, PlanCostAttribution.Split(showplan), index, plan.RuntimeCounted);
            volumes.AddPlan(PlanDataVolume.Split(showplan), index);
        }

        var objectIds = local.Concat(crossDatabase).ToArray();
        var namedElsewhere = offPage.Count + crossDatabase.Count + unresolved.Count;
        var incomplete = unreadable > 0 || skipped > 0;
        var confidence = Confidence(local, namedElsewhere, index);
        if (incomplete && confidence == QueryAttributionConfidence.Confirmed)
            confidence = QueryAttributionConfidence.Probable;
        var rationale = Rationale(
            local, offPage, crossDatabase, unresolved, namedElsewhere, index,
            hydrated - unreadable, skipped, unreadable);
        if (normalizationFailures > 0)
            rationale += $" {normalizationFailures} compiled plan(s) failed bounded XML normalization.";
        return new ResolvedFamily(
            new DatabaseCityQueryEvidence(
                counters.FamilyId,
                counters.QueryHash,
                counters.ExecutionCount,
                counters.TotalCpuMicroseconds,
                counters.TotalDurationMicroseconds,
                counters.TotalLogicalReads8KiBPages,
                counters.TotalWaitMilliseconds,
                objectIds,
                confidence,
                rationale)
            {
                WaitMillisecondsByCategory = waits,
                WaitAttribution = incomplete
                    ? new DatabaseCityWaitAttributionV1([], counters.TotalWaitMilliseconds, hydrated - unreadable,
                        "Plan coverage is incomplete; measured waits remain unassigned rather than being transferred to readable plans.")
                    : costs.Build(counters.TotalWaitMilliseconds),
                PlanDataVolume = volumes.Build(),
                RecentActivity = RecentActivity(detail, costs, trafficWindowEnd),
            },
            hydrated,
            // Totals belong to one building only when the plans named that building and nothing
            // else at all: not another page, not another database, not something unresolvable.
            ExposureEligible: local.Count == 1 && namedElsewhere == 0 && !incomplete);
    }

    /// <summary>
    /// What the family did inside the recent traffic window, summed from the retained runtime
    /// buckets that <em>overlap</em> it.
    /// <para>
    /// Overlap rather than containment, because Query Store's current interval is still open: its
    /// <c>IntervalEnd</c> is in the future, so a containment test would drop the one bucket that
    /// holds live traffic and report the busiest family on the instance as idle. The cost of that
    /// choice is that an overlapping hour-wide interval contributes more than fifteen minutes of
    /// work, and the totals are published as measured rather than scaled down to the window --
    /// pro-rating a measured total across an interval assumes work was spread evenly through it,
    /// which Query Store never said.
    /// </para>
    /// <para>
    /// A family with no overlapping bucket reports <c>Covered: false</c> with zero counts, which
    /// the map must render as unknown rather than free. "Query Store captured nothing here" and
    /// "this street is quiet" are different statements and colouring them the same is how a map
    /// starts to lie.
    /// </para>
    /// </summary>
    private DatabaseCityRecentActivityV1 RecentActivity(
        QueryFamilyDetailV1 detail, PlanCostAccumulator costs, DateTimeOffset end)
    {
        var start = end - _trafficWindow;
        var minutes = (int)Math.Round(_trafficWindow.TotalMinutes, MidpointRounding.AwayFromZero);

        var executions = BigInteger.Zero;
        var duration = BigInteger.Zero;
        var waits = BigInteger.Zero;
        var recent = detail.Runtime.Where(bucket => bucket.IntervalEnd > start && bucket.IntervalStart < end).ToArray();
        var covered = recent.Length;
        var waitsKnown = covered > 0 && recent.All(bucket => bucket.WaitMilliseconds.Count > 0 &&
            bucket.WaitMilliseconds.Values.All(value =>
                BigInteger.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out _)));
        foreach (var bucket in recent)
        {
            executions += Parse(bucket.ExecutionCount);
            duration += Parse(bucket.TotalDurationMicroseconds);
            foreach (var milliseconds in bucket.WaitMilliseconds.Values)
                waits += Parse(milliseconds);
        }

        var rationale = covered == 0
            ? $"No retained Query Store interval overlaps the last {minutes} minutes, so recent " +
              "activity is not known for this family. That is missing capture, not an idle query."
            : $"Summed from {covered} retained Query Store interval(s) overlapping the last " +
              $"{minutes} minutes. Intervals are not divided at the window edge, so a wider " +
              "interval contributes everything it measured rather than a pro-rated share.";
        if (covered > 0 && !waitsKnown)
            rationale += " Wait capture is incomplete in these intervals; the recorded subtotal is not complete recent wait evidence.";

        var waitTotal = waits.ToString(CultureInfo.InvariantCulture);
        return new DatabaseCityRecentActivityV1(
            minutes,
            start,
            end,
            covered > 0,
            executions.ToString(CultureInfo.InvariantCulture),
            duration.ToString(CultureInfo.InvariantCulture),
            waitTotal,
            rationale)
        {
            WaitAttribution = waitsKnown ? costs.BuildRecent(recent, waitTotal) : null,
            WaitMillisecondsByCategory = waitsKnown ? WaitCategories(recent, waitTotal) : null,
        };
    }

    /// <summary>
    /// Unparseable counters contribute zero rather than failing the page. A single malformed bucket
    /// should cost that bucket's contribution, not the whole city's traffic colour.
    /// <para>
    /// Totals are <c>average × execution count</c>, and Query Store's averages are decimals, so a
    /// real total arrives as <c>"8039297979.000000331"</c> — an integer with a float tail. Parsing
    /// those as integers-only returned <see cref="BigInteger.Zero"/>, which published a number the
    /// instance never reported: measured against a live AdventureWorks, every family's duration came
    /// back as <c>0</c> while the same family's retained total read 8.0e9. The integer part is taken
    /// and the tail dropped, which loses less than one microsecond per bucket.
    /// </para>
    /// </summary>
    private static BigInteger Parse(string value)
    {
        if (BigInteger.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var whole))
            return whole;
        var point = value.IndexOf('.', StringComparison.Ordinal);
        return point > 0
            && BigInteger.TryParse(
                value.AsSpan(0, point), NumberStyles.None, CultureInfo.InvariantCulture, out var truncated)
            ? truncated
            : BigInteger.Zero;
    }

    /// <summary>
    /// Sums the family's retained runtime buckets per verbatim <c>wait_category_desc</c>. The
    /// breakdown is published only when it reconciles exactly with the family's total wait
    /// milliseconds; otherwise it is withheld as "not captured" rather than shown as a partial
    /// account of where the waiting happened.
    /// </summary>
    private static ReadOnlyDictionary<string, string> WaitCategories(
        QueryFamilyDetailV1 detail,
        string totalWaitMilliseconds) => WaitCategories(detail.Runtime, totalWaitMilliseconds);

    private static ReadOnlyDictionary<string, string> WaitCategories(
        IReadOnlyList<RuntimeBucketV1> runtime, string totalWaitMilliseconds)
    {
        var totals = new SortedDictionary<string, BigInteger>(StringComparer.Ordinal);
        foreach (var bucket in runtime)
        {
            foreach (var (category, milliseconds) in bucket.WaitMilliseconds)
            {
                if (!BigInteger.TryParse(
                        milliseconds, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed))
                    return ReadOnlyDictionary<string, string>.Empty;
                totals[category] = totals.GetValueOrDefault(category) + parsed;
            }
        }

        if (totals.Count == 0) return ReadOnlyDictionary<string, string>.Empty;
        if (!BigInteger.TryParse(
                totalWaitMilliseconds, NumberStyles.None, CultureInfo.InvariantCulture, out var expected) ||
            totals.Values.Aggregate(BigInteger.Zero, (sum, value) => sum + value) != expected)
            return ReadOnlyDictionary<string, string>.Empty;

        return new ReadOnlyDictionary<string, string>(totals.ToDictionary(
            entry => entry.Key,
            entry => entry.Value.ToString(CultureInfo.InvariantCulture),
            StringComparer.Ordinal));
    }

    private static QueryAttributionConfidence Confidence(
        SortedSet<string> local,
        int namedElsewhere,
        PageObjectIndex index)
    {
        if (local.Count == 0) return QueryAttributionConfidence.Unknown;
        if (local.Count > 1 || namedElsewhere > 0) return QueryAttributionConfidence.Probable;
        // A single reference to an indexed view is not confirmation that the work happened there:
        // the optimizer can expand the view over its base tables, or match it into an unrelated query.
        return index.KindOf(local.Min!) == DatabaseObjectKind.IndexedView
            ? QueryAttributionConfidence.Probable
            : QueryAttributionConfidence.Confirmed;
    }

    /// <summary>
    /// Explains, in the family's own words, exactly what its plans named. The leading clause is
    /// bound to the same test <c>ExposureEligible</c> uses, so a family can never claim to name one
    /// object while being refused as an attribution for naming something else as well.
    /// </summary>
    private static string Rationale(
        SortedSet<string> local,
        SortedSet<string> offPage,
        SortedSet<string> crossDatabase,
        SortedSet<string> unresolved,
        int namedElsewhere,
        PageObjectIndex index,
        int hydrated,
        int skipped,
        int unreadable)
    {
        var parts = new List<string>(6);
        if (local.Count == 0 && crossDatabase.Count == 0)
        {
            parts.Add(hydrated == 0
                ? "No compiled plan could be read for this family, so no object reference was available."
                : $"{Plans(hydrated)} named no object on this page; workload remains unattributed.");
        }
        else if (local.Count == 1 && namedElsewhere == 0)
        {
            parts.Add(index.KindOf(local.Min!) == DatabaseObjectKind.IndexedView
                ? $"A normalized compiled plan names exactly one local object, the indexed view {index.NameOf(local.Min!)}; optimizer expansion remains a caveat, so the reference is probable rather than confirmed."
                : $"A normalized compiled plan names exactly one local object, {index.NameOf(local.Min!)}.");
        }
        else if (local.Count == 1)
        {
            parts.Add(
                $"Normalized plans name one object on this page, {index.NameOf(local.Min!)}, alongside {namedElsewhere.ToString(CultureInfo.InvariantCulture)} further reference(s) below; totals therefore remain query-level and are not assigned to it.");
        }
        else
        {
            parts.Add(
                $"Normalized plans name {(local.Count + crossDatabase.Count).ToString(CultureInfo.InvariantCulture)} objects; totals remain query-level and are not divided between them or assigned to any one of them.");
        }

        if (offPage.Count > 0)
        {
            parts.Add(
                $"{offPage.Count.ToString(CultureInfo.InvariantCulture)} referenced object(s) exist in this database but are outside the current page and are not shown as buildings: {string.Join(", ", offPage)}.");
        }

        if (crossDatabase.Count > 0)
            parts.Add($"{crossDatabase.Count.ToString(CultureInfo.InvariantCulture)} reference(s) name another database.");
        if (unresolved.Count > 0)
        {
            parts.Add(
                $"{unresolved.Count.ToString(CultureInfo.InvariantCulture)} reference(s) name a database this target's atlas does not hold and were not resolved to any city: {string.Join(", ", unresolved)}.");
        }

        if (skipped > 0)
            parts.Add($"{skipped.ToString(CultureInfo.InvariantCulture)} further compiled plan(s) were not read under this page's hydration budget, so the reference set may be incomplete.");
        if (unreadable > 0)
            parts.Add($"{unreadable.ToString(CultureInfo.InvariantCulture)} compiled plan(s) could not be read.");
        return string.Join(" ", parts);
    }

    private static string Plans(int count) => count == 1
        ? "The one compiled plan read for this family"
        : $"The {count.ToString(CultureInfo.InvariantCulture)} compiled plans read for this family";

    /// <summary>
    /// Attributes a family's totals to an object only when its plans named that object and nothing
    /// else at all. Families that also named an off-page object, another database, or an
    /// unresolvable reference are excluded rather than split by an invented ratio.
    /// <para>
    /// Excluded is not the same as hidden, and it is not the same as absent. Every on-page object a
    /// ranked family named gets an entry here: either sole attribution, or a
    /// <see cref="DatabaseCitySharedExposureV1"/> carrying those families' figures whole and marked
    /// non-additive. Only an object no ranked family named at all is left out, so the caller's
    /// "no family named this object" fallback is true whenever it fires.
    /// </para>
    /// <para>
    /// This matters because <c>local.Count == 1</c> is close to unreachable for a normalized schema
    /// driven by joins: widen the page and joined tables come on-page, shrink it and they fall off
    /// it. Without the shared bucket a real workload attributes nothing anywhere, and the map reads
    /// as though collection failed.
    /// </para>
    /// </summary>
    private static ReadOnlyDictionary<string, DatabaseCityAttributedExposureV1> BuildExposure(
        IReadOnlyList<DatabaseCityQueryEvidence> allFamilies,
        IReadOnlyList<DatabaseCityQueryEvidence> families,
        PageObjectIndex index,
        EvidenceV1 evidence)
    {
        var eligibleIds = new HashSet<string>(
            families.Select(family => family.FamilyId), StringComparer.Ordinal);
        var sole = new Dictionary<string, ExposureTotals>(StringComparer.Ordinal);
        var shared = new Dictionary<string, ExposureTotals>(StringComparer.Ordinal);

        foreach (var family in allFamilies)
        {
            // An eligible family names exactly one object by construction, so anything else it
            // reached is shared exposure for whichever objects it did name.
            var soleTarget = eligibleIds.Contains(family.FamilyId) && family.ObjectIds.Count == 1
                ? family.ObjectIds[0]
                : null;
            foreach (var objectId in family.ObjectIds)
            {
                if (!index.IsOnPage(objectId)) continue;
                var bucket = string.Equals(objectId, soleTarget, StringComparison.Ordinal) ? sole : shared;
                if (!bucket.TryGetValue(objectId, out var accumulated))
                {
                    accumulated = new ExposureTotals();
                    bucket.Add(objectId, accumulated);
                }
                accumulated.Add(family);
            }
        }

        var exposure = new Dictionary<string, DatabaseCityAttributedExposureV1>(StringComparer.Ordinal);
        foreach (var objectId in sole.Keys.Concat(shared.Keys).Distinct(StringComparer.Ordinal))
        {
            var name = index.NameOf(objectId);
            var sharedTotals = shared.TryGetValue(objectId, out var sharedBucket)
                ? sharedBucket.ToShared(name)
                : null;
            exposure[objectId] = sole.TryGetValue(objectId, out var soleBucket)
                ? soleBucket.ToContract(name, sharedTotals, evidence)
                : new DatabaseCityAttributedExposureV1(
                    null, null, null, null, QueryAttributionConfidence.Unknown,
                    $"No ranked Query Store family names {name} on its own, so no total belongs to it alone; this is absent evidence, not measured zero. Shared exposure below reports what the families that did name it measured.",
                    evidence)
                {
                    Shared = sharedTotals,
                };
        }

        return new ReadOnlyDictionary<string, DatabaseCityAttributedExposureV1>(exposure);
    }

    /// <summary>
    /// Reports how many families fall outside the ranked top-N. The count is exact because the
    /// Query Store index publishes it, but the remainder's counters were never aggregated for this
    /// page, so they stay unavailable instead of being reported as zero.
    /// </summary>
    private static DatabaseCityWorkloadAggregateV1 OtherWorkload(
        PageV1<QueryFamilySummaryV1> page,
        int topCount,
        EvidenceV1 pageEvidence)
    {
        string? familyCount = null;
        var reason =
            "Families outside the ranked top-N were not counted, because this Query Store index did not publish a total.";
        if (page.TotalCount is { } total &&
            BigInteger.TryParse(total, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) &&
            parsed >= topCount)
        {
            familyCount = (parsed - topCount).ToString(CultureInfo.InvariantCulture);
            reason =
                "Exact count of query families outside the ranked top-N; their execution, CPU, duration, read, and wait totals were not aggregated for this page and are unavailable, never zero.";
        }

        return new DatabaseCityWorkloadAggregateV1(
            familyCount, null, null, null, null, null, pageEvidence with { Reason = reason });
    }

    private static CityAttributionResult Unavailable(EvidenceV1 evidence) => new(
        [],
        new DatabaseCityWorkloadAggregateV1(null, null, null, null, null, null, evidence),
        [],
        ReadOnlyDictionary<string, DatabaseCityAttributedExposureV1>.Empty,
        evidence);

    private static DatabaseCityQueryEvidence Unattributed(
        QueryFamilySummaryV1 summary,
        ReadOnlyDictionary<string, string> waits,
        string rationale) =>
        new(summary.FamilyId, summary.QueryHash, summary.ExecutionCount, summary.TotalCpuMicroseconds,
            summary.TotalDurationMicroseconds, summary.TotalLogicalReads8KiBPages,
            summary.TotalWaitMilliseconds, [], QueryAttributionConfidence.Unknown, rationale)
        {
            WaitMillisecondsByCategory = waits,
        };

    internal static EvidenceV1 ToEvidence(QueryStoreEvidenceV1? evidence) => evidence is null
        ? UnavailableEvidence
        : new EvidenceV1(
            EvidenceSource.QueryStoreAggregate, evidence.Status, evidence.ObservedAt, evidence.FreshUntil,
            $"{evidence.Reason} {evidence.Caveat}".Trim());

    private static string MetricToken(DatabaseCityMetric metric) => metric switch
    {
        DatabaseCityMetric.Cpu => "cpu",
        DatabaseCityMetric.Duration => "duration",
        DatabaseCityMetric.Reads => "reads",
        DatabaseCityMetric.Executions => "execution",
        _ => throw new ArgumentOutOfRangeException(nameof(metric)),
    };

    private sealed record ResolvedFamily(
        DatabaseCityQueryEvidence Family,
        int PlansHydrated,
        bool ExposureEligible = false);

    private enum ReferenceKind { Unresolvable, OnPage, OffPage, CrossDatabase }

    private readonly record struct ResolvedReference(ReferenceKind Kind, string? Value);

    /// <summary>
    /// Collects estimated plan cost shares across a family's hydrated plans, so the family's single
    /// measured wait total can be divided between the buildings its plans actually read.
    /// <para>
    /// Only shares that resolved to an object <em>on this page</em> are published. Cost the plan
    /// placed on an off-page object, another database, a reference that would not resolve, or on no
    /// object at all is counted into the remainder instead. That is the same refusal the strict
    /// attribution rule makes: a page must never absorb time that demonstrably belongs somewhere it
    /// is not drawing.
    /// </para>
    /// </summary>
    private sealed class PlanCostAccumulator
    {
        private readonly List<PlanShares> _plans = [];

        public void AddPlan(string planId, PlanCostSplit split, PageObjectIndex index, bool runtimeCounted)
        {
            if (!split.HasCost) return;

            var shares = new SortedDictionary<string, decimal>(StringComparer.Ordinal);
            var elsewhere = 0m;
            foreach (var entry in split.Objects)
            {
                var share = entry.Cost / split.TotalCost;
                if (index.Resolve(entry.Reference) is { Kind: ReferenceKind.OnPage, Value: { } objectId })
                    shares[objectId] = shares.GetValueOrDefault(objectId) + share;
                else
                    elsewhere += share;
            }

            _plans.Add(new PlanShares(
                planId, runtimeCounted, shares, elsewhere, split.UnattributedCost / split.TotalCost));
        }

        public DatabaseCityWaitAttributionV1 BuildRecent(
            IReadOnlyList<RuntimeBucketV1> runtime, string totalWaitMilliseconds)
        {
            var plans = _plans.Where(plan => plan.RuntimeCounted).ToDictionary(plan => plan.PlanId, StringComparer.Ordinal);
            var totalWait = BigInteger.Parse(totalWaitMilliseconds, CultureInfo.InvariantCulture);
            var weightTotal = totalWait > 0 ? totalWait : runtime.Aggregate(BigInteger.Zero,
                (sum, bucket) => sum + Parse(bucket.ExecutionCount));
            var amounts = new SortedDictionary<string, BigInteger>(StringComparer.Ordinal);
            var weightedShares = new Dictionary<string, BigInteger>(StringComparer.Ordinal);
            var unassigned = BigInteger.Zero;
            var plansRead = 0;
            foreach (var group in runtime.GroupBy(bucket => bucket.PlanId, StringComparer.Ordinal))
            {
                var wait = group.SelectMany(bucket => bucket.WaitMilliseconds.Values)
                    .Aggregate(BigInteger.Zero, (sum, value) => sum + BigInteger.Parse(value, CultureInfo.InvariantCulture));
                if (!plans.TryGetValue(group.Key, out var plan))
                {
                    unassigned += wait;
                    continue;
                }
                plansRead++;
                var split = WaitApportionment.Apportion(
                    plan.Shares.Select(pair => new ObjectCostShare(pair.Key, pair.Value)).ToArray(),
                    wait.ToString(CultureInfo.InvariantCulture), 1, "Recent per-plan wait allocation.");
                unassigned += BigInteger.Parse(split.UnattributedWaitMilliseconds, CultureInfo.InvariantCulture);
                var weight = totalWait > 0 ? wait : group.Aggregate(BigInteger.Zero,
                    (sum, bucket) => sum + Parse(bucket.ExecutionCount));
                foreach (var item in split.Objects)
                {
                    amounts[item.ObjectId] = amounts.GetValueOrDefault(item.ObjectId) +
                        BigInteger.Parse(item.WaitMilliseconds, CultureInfo.InvariantCulture);
                    var units = (BigInteger)decimal.Round(plan.Shares[item.ObjectId] * WaitApportionment.ShareScale);
                    weightedShares[item.ObjectId] = weightedShares.GetValueOrDefault(item.ObjectId) + units * weight;
                }
            }
            var objects = amounts.Select(pair => new DatabaseCityObjectWaitShareV1(
                pair.Key,
                weightTotal > 0 ? decimal.Round(
                    (decimal)(weightedShares[pair.Key] / weightTotal) / WaitApportionment.ShareScale,
                    WaitApportionment.ShareDigits) : 0m,
                pair.Value.ToString(CultureInfo.InvariantCulture))).ToArray();
            return new(objects, unassigned.ToString(CultureInfo.InvariantCulture), plansRead,
                "Each plan's measured waits in the recent window are apportioned only by that plan's compiled cost estimates. " +
                "Unreadable, uncosted, uncounted, and off-page plans or objects leave their waits unassigned; " +
                "readable plans never absorb another plan's waits. This is modelled placement, not measured object wait time.");
        }

        public DatabaseCityWaitAttributionV1 Build(string totalWaitMilliseconds)
        {
            if (_plans.Count == 0) return DatabaseCityWaitAttributionV1.None;

            // A plan whose runtime Query Store never counted contributed none of the time being
            // divided, so it does not get to shape the division while a counted plan is available.
            var counted = _plans.Where(plan => plan.RuntimeCounted).ToArray();
            var used = counted.Length > 0 ? counted : _plans.ToArray();

            var totals = new SortedDictionary<string, decimal>(StringComparer.Ordinal);
            var elsewhere = 0m;
            var nowhere = 0m;
            foreach (var plan in used)
            {
                foreach (var (objectId, share) in plan.Shares)
                    totals[objectId] = totals.GetValueOrDefault(objectId) + share;
                elsewhere += plan.Elsewhere;
                nowhere += plan.Nowhere;
            }

            // Plans are averaged rather than summed: each describes the whole query, so summing them
            // would claim the query cost once per compiled plan Query Store happens to retain.
            var divisor = used.Length;
            var shares = totals
                .Select(entry => new ObjectCostShare(entry.Key, entry.Value / divisor))
                .ToArray();

            return WaitApportionment.Apportion(
                shares,
                totalWaitMilliseconds,
                divisor,
                Describe(shares, elsewhere / divisor, nowhere / divisor, divisor, counted.Length > 0));
        }

        private static string Describe(
            ObjectCostShare[] shares,
            decimal elsewhere,
            decimal nowhere,
            int plans,
            bool runtimeCounted)
        {
            var onPage = shares.Aggregate(0m, (sum, share) => sum + share.Share);
            var source = runtimeCounted
                ? $"{Plans(plans)} whose runtime Query Store counted"
                : $"{Plans(plans)}, none of whose runtime Query Store counted";
            var parts = new List<string>(4)
            {
                shares.Length == 0
                    ? $"Estimated cost from {source} placed nothing on any object this page draws, so none of this family's measured wait time is apportioned to a building."
                    : $"Estimated cost from {source} places {Percent(onPage)} of this query's cost on {shares.Length.ToString(CultureInfo.InvariantCulture)} building(s) here, and its measured wait milliseconds are divided in that proportion.",
            };

            if (elsewhere > 0m)
                parts.Add($"{Percent(elsewhere)} of the estimated cost falls on objects this page does not draw and is left unapportioned.");
            if (nowhere > 0m)
                parts.Add($"{Percent(nowhere)} is operator work over no object at all and is left unapportioned.");

            parts.Add("The optimizer's cost estimate is a model of the work, not a measurement of where the waiting happened.");
            return string.Join(" ", parts);
        }

        private static string Percent(decimal share) =>
            (share * 100m).ToString("0.#", CultureInfo.InvariantCulture) + "%";

        private static string Plans(int count) =>
            count == 1 ? "1 compiled plan" : $"{count.ToString(CultureInfo.InvariantCulture)} compiled plans";

        private sealed record PlanShares(
            string PlanId,
            bool RuntimeCounted,
            SortedDictionary<string, decimal> Shares,
            decimal Elsewhere,
            decimal Nowhere);
    }

    /// <summary>
    /// Collects the estimated per-execution data volume across a family's compiled plans.
    /// <para>
    /// Plans are averaged rather than summed, for the same reason the cost split averages them: each
    /// retained plan describes the whole query, so summing would multiply the query's data volume by
    /// however many plans Query Store happens to be holding. The average is the estimate for "one
    /// execution", which is what a vehicle on the map represents.
    /// </para>
    /// <para>
    /// Bytes falling on objects this page does not draw are kept out of the per-object list but
    /// stay in the total and are disclosed in the rationale. The total answers "how much data does
    /// this query move", which is true regardless of what this page happens to draw; dropping those
    /// bytes would make a query that reads mostly off-page look small.
    /// </para>
    /// </summary>
    private sealed class PlanDataVolumeAccumulator
    {
        private readonly List<PlanVolume> _plans = [];
        private int _plansWithoutRowSize;

        public void AddPlan(PlanDataVolumeSplit split, PageObjectIndex index)
        {
            if (!split.HasVolume)
            {
                _plansWithoutRowSize++;
                return;
            }

            var onPage = new SortedDictionary<string, decimal>(StringComparer.Ordinal);
            var elsewhere = 0m;
            foreach (var entry in split.Objects)
            {
                if (index.Resolve(entry.Reference) is { Kind: ReferenceKind.OnPage, Value: { } objectId })
                    onPage[objectId] = onPage.GetValueOrDefault(objectId) + entry.EstimatedBytes;
                else
                    elsewhere += entry.EstimatedBytes;
            }

            _plans.Add(new PlanVolume(onPage, elsewhere, split.TotalBytes, split.OperatorsMissingRowSize));
        }

        public DatabaseCityPlanDataVolumeV1? Build()
        {
            // Null, not zero. No plan stating a row size is "the plans did not say"; publishing 0
            // bytes would put the smallest vehicle on the map for a query that may move gigabytes.
            if (_plans.Count == 0) return null;

            var totals = new SortedDictionary<string, decimal>(StringComparer.Ordinal);
            var total = 0m;
            var elsewhere = 0m;
            var partialPlans = 0;
            foreach (var plan in _plans)
            {
                foreach (var (objectId, bytes) in plan.OnPage)
                    totals[objectId] = totals.GetValueOrDefault(objectId) + bytes;
                total += plan.TotalBytes;
                elsewhere += plan.Elsewhere;
                if (plan.OperatorsMissingRowSize > 0) partialPlans++;
            }

            var divisor = _plans.Count;
            var byObject = totals
                .Select(entry => new DatabaseCityObjectDataVolumeV1(entry.Key, Bytes(entry.Value / divisor)))
                .ToArray();

            return new DatabaseCityPlanDataVolumeV1(
                Bytes(total / divisor),
                byObject,
                divisor,
                Describe(byObject.Length, total / divisor, elsewhere / divisor, divisor, partialPlans, _plansWithoutRowSize));
        }

        /// <summary>
        /// Renders to a whole number of bytes. A fractional byte is an artifact of averaging across
        /// plans, not something the optimizer claimed, and rounding it away here keeps the published
        /// figure in the unit it is named in.
        /// </summary>
        private static string Bytes(decimal value) =>
            decimal.Round(value, 0, MidpointRounding.AwayFromZero).ToString("0", CultureInfo.InvariantCulture);

        private static string Describe(
            int onPageObjects,
            decimal total,
            decimal elsewhere,
            int plans,
            int partialPlans,
            int plansWithoutRowSize)
        {
            var parts = new List<string>(5)
            {
                $"Estimated from row counts and row sizes in {Plans(plans)} retained for this family, averaged across them because each describes the whole query.",
            };

            parts.Add(onPageObjects == 0
                ? "None of those bytes are read from an object this page draws."
                : $"{Bytes(total - elsewhere)} of {Bytes(total)} byte(s) per execution are read from {onPageObjects.ToString(CultureInfo.InvariantCulture)} object(s) this page draws.");

            if (elsewhere > 0m)
                parts.Add($"{Bytes(elsewhere)} byte(s) are read from objects this page does not draw; they are counted in the total but not placed on a building.");
            if (partialPlans > 0)
                parts.Add($"{Plans(partialPlans)} named an object through an operator that stated no row size, so the figure understates those reads.");
            if (plansWithoutRowSize > 0)
                parts.Add($"A further {Plans(plansWithoutRowSize)} stated no row size at all and contributed nothing.");

            parts.Add("These are the optimizer's compile-time estimates against the statistics that existed then, not a measurement of any execution.");
            return string.Join(" ", parts);
        }

        private static string Plans(int count) =>
            count == 1 ? "1 compiled plan" : $"{count.ToString(CultureInfo.InvariantCulture)} compiled plans";

        private sealed record PlanVolume(
            SortedDictionary<string, decimal> OnPage,
            decimal Elsewhere,
            decimal TotalBytes,
            int OperatorsMissingRowSize);
    }

    private sealed class ExposureTotals
    {
        private BigInteger _executions;
        private BigInteger _cpu;
        private BigInteger _duration;
        private BigInteger _reads;
        private QueryAttributionConfidence _confidence = QueryAttributionConfidence.Confirmed;
        private int _families;

        public void Add(DatabaseCityQueryEvidence family)
        {
            _families++;
            _executions += Parse(family.ExecutionCount);
            _cpu += Parse(family.TotalCpuMicroseconds);
            _duration += Parse(family.TotalDurationMicroseconds);
            _reads += Parse(family.TotalLogicalReads8KiBPages);
            // The object inherits the weakest confidence of any family folded into its totals.
            if (family.Confidence > _confidence) _confidence = family.Confidence;
        }

        public DatabaseCityAttributedExposureV1 ToContract(
            string name,
            DatabaseCitySharedExposureV1? shared,
            EvidenceV1 evidence) => new(
            _executions.ToString(CultureInfo.InvariantCulture),
            _cpu.ToString(CultureInfo.InvariantCulture),
            _duration.ToString(CultureInfo.InvariantCulture),
            _reads.ToString(CultureInfo.InvariantCulture),
            _confidence,
            $"Counts the {_families.ToString(CultureInfo.InvariantCulture)} ranked Query Store family or families whose normalized plans name {name} and no other object, because only those measured this object on its own." +
            (shared is null
                ? string.Empty
                : $" A further {shared.FamilyCount} ranked family or families name {name} alongside other objects; their figures are reported separately as shared exposure and are not added here."),
            evidence)
        {
            Shared = shared,
        };

        /// <summary>
        /// Projects the same accumulation as query-level totals that belong to several objects at
        /// once. Nothing is divided: the caller is told plainly that these figures repeat on every
        /// object the same queries named and must not be summed across the city.
        /// </summary>
        public DatabaseCitySharedExposureV1 ToShared(string name) => new(
            _families.ToString(CultureInfo.InvariantCulture),
            _executions.ToString(CultureInfo.InvariantCulture),
            _cpu.ToString(CultureInfo.InvariantCulture),
            _duration.ToString(CultureInfo.InvariantCulture),
            _reads.ToString(CultureInfo.InvariantCulture),
            $"{_families.ToString(CultureInfo.InvariantCulture)} ranked Query Store family or families name {name} alongside other objects, so Query Store measured one total per query and never a per-object share. These totals are those queries' own figures, reported whole and undivided, and the same figures also appear on every other object those queries named: they must not be summed across buildings.");

        private static BigInteger Parse(string value) => QueryStoreCityAttribution.Parse(value);
    }

    /// <summary>
    /// Resolves showplan object references against the objects on this page, mirroring the map's own
    /// matching rules: bracket quoting is stripped, comparison is case-insensitive, and a reference
    /// without a schema only matches when exactly one object on the page carries that name.
    /// </summary>
    private sealed class PageObjectIndex
    {
        private readonly Dictionary<string, CityAttributionObject> _byQualifiedName;
        private readonly ILookup<string, CityAttributionObject> _byName;
        private readonly Dictionary<string, CityAttributionObject> _byObjectId;
        private readonly IReadOnlyDictionary<string, string> _databaseIdsByName;
        private readonly string _databaseName;

        public PageObjectIndex(
            IReadOnlyList<CityAttributionObject> objects,
            string databaseName,
            IReadOnlyDictionary<string, string> databaseIdsByName)
        {
            _databaseName = databaseName;
            _databaseIdsByName = databaseIdsByName;
            _byObjectId = objects.ToDictionary(item => item.ObjectId, StringComparer.Ordinal);
            _byQualifiedName = objects
                .GroupBy(item => Qualified(item.SchemaName, item.ObjectName), StringComparer.OrdinalIgnoreCase)
                .ToDictionary(group => group.Key, group => group.First(), StringComparer.OrdinalIgnoreCase);
            _byName = objects.ToLookup(item => item.ObjectName, StringComparer.OrdinalIgnoreCase);
        }

        public bool IsOnPage(string objectId) => _byObjectId.ContainsKey(objectId);

        public DatabaseObjectKind? KindOf(string objectId) =>
            _byObjectId.TryGetValue(objectId, out var value) ? value.Kind : null;

        public string NameOf(string objectId) =>
            _byObjectId.TryGetValue(objectId, out var value)
                ? Qualified(value.SchemaName, value.ObjectName)
                : objectId;

        public ResolvedReference Resolve(ShowplanObjectV1 reference)
        {
            var table = Unquote(reference.Table);
            if (table is null) return new ResolvedReference(ReferenceKind.Unresolvable, null);
            var database = Unquote(reference.Database);
            if (database is not null &&
                !database.Equals(_databaseName, StringComparison.OrdinalIgnoreCase))
            {
                if (_databaseIdsByName.TryGetValue(database, out var remoteId))
                    return new ResolvedReference(ReferenceKind.CrossDatabase, remoteId);

                // The plan names a database this target's atlas does not hold. Guessing which
                // database it is would invent a route, so it is reported by name instead.
                var schemaPrefix = Unquote(reference.Schema) is { } named ? $"{named}." : string.Empty;
                return new ResolvedReference(ReferenceKind.Unresolvable, $"{database}.{schemaPrefix}{table}");
            }

            var schema = Unquote(reference.Schema);
            if (schema is not null)
            {
                return _byQualifiedName.TryGetValue(Qualified(schema, table), out var match)
                    ? new ResolvedReference(ReferenceKind.OnPage, match.ObjectId)
                    : new ResolvedReference(ReferenceKind.OffPage, Qualified(schema, table));
            }

            var candidates = _byName[table].ToArray();
            return candidates.Length == 1
                ? new ResolvedReference(ReferenceKind.OnPage, candidates[0].ObjectId)
                : new ResolvedReference(ReferenceKind.OffPage, table);
        }

        private static string Qualified(string schema, string name) => $"{schema}.{name}";

        /// <summary>Strips showplan bracket quoting: <c>[dbo]</c> becomes <c>dbo</c>.</summary>
        private static string? Unquote(string? value)
        {
            if (value is null) return null;
            var trimmed = value.Trim();
            if (trimmed.Length == 0) return null;
            return trimmed.Length >= 2 && trimmed[0] == '[' && trimmed[^1] == ']'
                ? trimmed[1..^1]
                : trimmed;
        }
    }

    /// <summary>
    /// Collects co-reference routes. A route records that one normalized plan named both endpoints;
    /// it is never a claim about direction or row flow.
    /// </summary>
    private sealed class RouteAccumulator(EvidenceV1 pageEvidence)
    {
        private readonly SortedDictionary<string, DatabaseCityRouteV1> _routes = new(StringComparer.Ordinal);

        public void AddPlan(SortedSet<string> local, SortedSet<string> remote)
        {
            var ordered = local.ToArray();
            for (var left = 0; left < ordered.Length; left++)
            {
                for (var right = left + 1; right < ordered.Length; right++)
                    Add(ordered[left], ordered[right], DatabaseCityRouteKind.ObjectReference, EdgeConfidence.Confirmed,
                        "One normalized compiled plan references both local objects; this route identifies co-reference, not row flow.");
                foreach (var target in remote)
                    Add(ordered[left], target, DatabaseCityRouteKind.CrossDatabaseReference, EdgeConfidence.Probable,
                        "A normalized plan reference names another database alongside this object; direction and row flow are not established.");
            }
        }

        public DatabaseCityRouteV1[] Build() => [.. _routes.Values];

        private void Add(
            string from,
            string to,
            DatabaseCityRouteKind kind,
            EdgeConfidence confidence,
            string rationale)
        {
            var routeId = $"route:{from}~{to}";
            if (_routes.ContainsKey(routeId)) return;
            _routes.Add(routeId, new DatabaseCityRouteV1(
                routeId, from, to, kind, confidence, rationale,
                pageEvidence with
                {
                    Source = EvidenceSource.InferredTopology,
                    Reason = "Co-reference inferred from normalized compiled plan object references.",
                }));
        }
    }
}
