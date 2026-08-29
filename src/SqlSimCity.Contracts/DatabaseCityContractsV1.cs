namespace SqlSimCity.Contracts.V1;

public enum DatabaseCityMetric { Cpu, Duration, Reads, Executions }
public enum DatabaseObjectKind { Table, IndexedView }
public enum DatabaseIndexKind { Heap, Clustered, Nonclustered, Columnstore, Other }
public enum QueryAttributionConfidence { Confirmed, Probable, Unknown }
public enum DatabaseCityRouteKind { ObjectReference, CrossDatabaseReference }

/// <summary>
/// Where an object sits in the collector's stable ordering, so a city can be laid out the same way
/// on every collection and every page.
/// </summary>
/// <param name="NeighborhoodOrdinal">
/// The object's schema's position among the database's schemas, ordered by schema id.
/// </param>
/// <param name="ObjectOrdinal">
/// The object's position among <b>every object in the database</b>, ordered by schema id then object
/// id — not its position within its own schema. Database-wide is the only meaning both collectors can
/// honour, because one pages the database without knowing where a schema begins; reading it as a
/// per-schema index made the five-hundredth object look like a schema holding five hundred and one
/// (#49). Nothing that sizes the city may be derived from it: an ordinal states an order, not a count.
/// </param>
/// <param name="X">Legacy lattice coordinate derived from the ordinals. The city is no longer a
/// lattice and does not read these; they change whenever the ordinals do.</param>
/// <param name="Z">See <paramref name="X"/>.</param>
public sealed record DatabaseCityLayoutV1(
    int NeighborhoodOrdinal,
    int ObjectOrdinal,
    long X,
    long Z);

public sealed record DatabaseCityDirectActivityV1(
    string? TotalOperations,
    string? ResetEpochToken,
    EvidenceV1 Evidence);

/// <summary>
/// Query Store totals from ranked families that named this object <b>alongside others</b>, carried
/// whole and never divided, because Query Store measures one total per query and never a per-object
/// share. The same figures are reported again on every other object those queries named, so these
/// values are <b>not additive across buildings</b>: summing them over a city counts one query once
/// per object it touched. They are the honest answer for a normalized schema, where almost every
/// ranked query joins several tables and so can never be credited to one of them.
/// </summary>
public sealed record DatabaseCitySharedExposureV1(
    string FamilyCount,
    string ExecutionCount,
    string TotalCpuMicroseconds,
    string TotalDurationMicroseconds,
    string TotalLogicalReads8KiBPages,
    string Rationale);

/// <summary>
/// What a bounded page can say about one object's Query Store exposure. The scalar totals are
/// populated only when ranked families named this object and nothing else at all; when they are
/// <see langword="null"/>, <see cref="Shared"/> may still carry the query-level totals of families
/// that named it together with other objects.
/// </summary>
public sealed record DatabaseCityAttributedExposureV1(
    string? ExecutionCount,
    string? TotalCpuMicroseconds,
    string? TotalDurationMicroseconds,
    string? TotalLogicalReads8KiBPages,
    QueryAttributionConfidence Confidence,
    string Rationale,
    EvidenceV1 Evidence)
{
    /// <summary>
    /// Non-additive query-level totals from families that named this object alongside others, or
    /// <see langword="null"/> when no ranked family did.
    /// </summary>
    public DatabaseCitySharedExposureV1? Shared { get; init; }
}

public sealed record DatabaseCityIndexV1(
    string IndexId,
    string Name,
    DatabaseIndexKind Kind,
    DatabaseCityDirectActivityV1 DirectActivity);

public sealed record DatabaseCitySchemaV1(
    string SchemaId,
    string Name,
    int NeighborhoodOrdinal,
    string ObjectCount,
    EvidenceV1 Evidence);

/// <summary>
/// How stale one object's statistics are.
/// <para>
/// <see cref="OldestLastUpdated"/> is the freshness of the object's <em>stalest</em> statistic, so an
/// object is only as fresh as its worst one. It is <see langword="null"/> when no statistic on the
/// object has ever been updated, which is why <see cref="NeverUpdatedCount"/> exists separately: a
/// statistic that has never been built is not an old measurement, and folding the two together would
/// report a never-analysed object as fresh.
/// </para>
/// <para>
/// <see cref="UnreadableCount"/> is the count of statistics whose properties could not be read at
/// all -- <c>sys.dm_db_stats_properties</c> returns no row rather than raising when the caller lacks
/// SELECT on the statistics object. That is missing evidence, not evidence of freshness, and callers
/// must not treat it as either fresh or stale.
/// </para>
/// </summary>
public sealed record DatabaseCityStatisticsAgeV1(
    DateTimeOffset? OldestLastUpdated,
    int StatisticsCount,
    int NeverUpdatedCount,
    int UnreadableCount,
    string? ModificationCounter,
    MeasurementStatus Status,
    string? Reason);

public sealed record DatabaseCityObjectV1(
    string ObjectId,
    string SchemaId,
    string SchemaName,
    string Name,
    DatabaseObjectKind Kind,
    string? ReservedPages8KiB,
    string? UsedPages8KiB,
    string? ReservedBytes,
    string? UsedBytes,
    MeasurementStatus SizeStatus,
    string? SizeReason,
    DatabaseCityLayoutV1 Layout,
    IReadOnlyList<DatabaseCityIndexV1> Indexes,
    DatabaseCityDirectActivityV1 DirectActivity,
    DatabaseCityAttributedExposureV1 AttributedExposure,
    // Trailing and optional so that every existing construction site keeps compiling, and so an
    // archive written before this probe existed reads back as "nobody looked" rather than "fresh".
    DatabaseCityStatisticsAgeV1? Statistics = null);

/// <summary>
/// One captured query family. <paramref name="WaitMillisecondsByCategory"/> is keyed by the verbatim
/// Query Store <c>wait_category_desc</c> and is the evidence behind the city's wait lanes: it says
/// which physical resource the family queued for, which <paramref name="TotalWaitMilliseconds"/>
/// alone cannot. An <b>empty</b> dictionary means no wait-category evidence was captured -- most
/// often because <c>sys.query_store_wait_stats</c> does not exist before SQL Server 2017 (14.x) --
/// and never that the family waited for nothing. Categories are passed through unmapped and
/// untranslated so a category this build does not recognise is still reported rather than dropped.
/// </summary>
/// <summary>
/// One object's modelled share of a query family's measured wait time.
/// <para>
/// <see cref="WaitMilliseconds"/> is <em>not</em> a measurement of how long this object waited.
/// Query Store measures one wait total per query and never says which table caused it. The split is
/// <see cref="EstimatedCostShare"/>: the fraction of the compiled plan's <em>estimated</em> cost the
/// optimizer placed on operators reading this object. Presenting it requires saying so.
/// </para>
/// </summary>
public sealed record DatabaseCityObjectWaitShareV1(
    string ObjectId,
    decimal EstimatedCostShare,
    string WaitMilliseconds);

/// <summary>
/// A query family's measured wait time apportioned across the objects its compiled plans read.
/// <para>
/// The parts and <see cref="UnattributedWaitMilliseconds"/> sum to exactly the family's
/// <c>TotalWaitMilliseconds</c>, so the apportionment can always be checked against the measurement
/// it came from. The unattributed part covers cost the plan spent on no object at all, plus every
/// object the plan named that this page does not draw -- off-page, another database, or a reference
/// the collector could not resolve. Folding that into the objects on screen would hand this page
/// wait time that demonstrably belongs elsewhere.
/// </para>
/// <para>
/// An empty <see cref="Objects"/> list means no apportionment was possible, never that no object
/// waited.
/// </para>
/// </summary>
public sealed record DatabaseCityWaitAttributionV1(
    IReadOnlyList<DatabaseCityObjectWaitShareV1> Objects,
    string UnattributedWaitMilliseconds,
    int PlansRead,
    string Rationale)
{
    public static readonly DatabaseCityWaitAttributionV1 None = new(
        [], "0", 0,
        "No compiled plan cost estimate was available for this family, so its wait time is not apportioned.");
}

/// <summary>One object's share of the estimated bytes a query family's plans move per execution.</summary>
public sealed record DatabaseCityObjectDataVolumeV1(string ObjectId, string EstimatedBytesPerExecution);

/// <summary>
/// How many bytes one execution of this query family was expected to move, from the optimizer's own
/// per-operator row counts and row sizes in the compiled plans Query Store retained.
/// <para>
/// This is an estimate the optimizer made when it compiled the plan, against the statistics that
/// existed then -- not a measurement of any execution. A plan whose cardinality estimate is wrong
/// produces a volume that is wrong by the same factor, and nothing here detects that.
/// </para>
/// <para>
/// Values are decimal strings for the same reason every other total in this contract is: the
/// product of a row count and a row size routinely exceeds what a JSON number survives intact, and
/// a figure silently rounded on the way to the browser is worse than no figure.
/// </para>
/// <para>
/// The whole record is absent when no retained plan stated both a row count and a row size. Absent
/// means "the plans did not say", never "this family moves no data".
/// </para>
/// </summary>
public sealed record DatabaseCityPlanDataVolumeV1(
    string EstimatedBytesPerExecution,
    IReadOnlyList<DatabaseCityObjectDataVolumeV1> ByObject,
    int PlansRead,
    string Rationale);

/// <summary>
/// What a query family did in the last few minutes, as opposed to across the whole retained
/// horizon. This is what the map grades traffic colour from: an aggregate over a day of history
/// describes a database's past, and a city street should show what is happening on it now.
/// <para>
/// The window is matched by <em>overlap</em>, not by interval end. Query Store's current interval
/// is still open -- its <c>IntervalEnd</c> is in the future -- so selecting intervals that ended
/// inside the window would exclude live traffic and report a busy database as idle.
/// </para>
/// <para>
/// Because intervals are typically an hour wide, an overlapping interval's totals cover more than
/// the window asked for, and they are published as measured rather than pro-rated: dividing a
/// measured total by the fraction of an interval that happens to fall inside the window would
/// invent numbers Query Store never reported. The ratio the colour is graded from -- wait per
/// execution -- is unaffected by that, and is genuinely current.
/// </para>
/// </summary>
/// <param name="Covered">
/// Whether any retained interval overlapped the window at all. False means Query Store captured
/// nothing here, which is not the same as a street being quiet, and the map must grade it unknown
/// rather than free. Every count below is zero when this is false.
/// </param>
public sealed record DatabaseCityRecentActivityV1(
    int WindowMinutes,
    DateTimeOffset WindowStart,
    DateTimeOffset WindowEnd,
    bool Covered,
    string ExecutionCount,
    string TotalDurationMicroseconds,
    string TotalWaitMilliseconds,
    string Rationale);

public sealed record DatabaseCityQueryFamilyV1(
    string FamilyId,
    string QueryHash,
    string ExecutionCount,
    string TotalCpuMicroseconds,
    string TotalDurationMicroseconds,
    string TotalLogicalReads8KiBPages,
    string TotalWaitMilliseconds,
    IReadOnlyDictionary<string, string> WaitMillisecondsByCategory,
    IReadOnlyList<string> ObjectIds,
    QueryAttributionConfidence Confidence,
    string Rationale,
    EvidenceV1 Evidence)
{
    /// <summary>
    /// The family's measured wait time spread across the objects its plans read, in proportion to
    /// estimated plan cost. Modelled, not measured; see <see cref="DatabaseCityWaitAttributionV1"/>.
    /// </summary>
    public DatabaseCityWaitAttributionV1 WaitAttribution { get; init; } = DatabaseCityWaitAttributionV1.None;

    /// <summary>
    /// Estimated bytes one execution of this family moves, per object. Null when no retained plan
    /// stated both a row count and a row size -- which is "the plans did not say", not "no data".
    /// Modelled, not measured; see <see cref="DatabaseCityPlanDataVolumeV1"/>.
    /// </summary>
    public DatabaseCityPlanDataVolumeV1? PlanDataVolume { get; init; }

    /// <summary>
    /// What this family did inside the recent traffic window. Null when the page was built without
    /// one; see <see cref="DatabaseCityRecentActivityV1"/> for why absence is not idleness.
    /// </summary>
    public DatabaseCityRecentActivityV1? RecentActivity { get; init; }
}

public sealed record DatabaseCityWorkloadAggregateV1(
    string? FamilyCount,
    string? ExecutionCount,
    string? TotalCpuMicroseconds,
    string? TotalDurationMicroseconds,
    string? TotalLogicalReads8KiBPages,
    string? TotalWaitMilliseconds,
    EvidenceV1 Evidence);

public sealed record DatabaseCityRouteV1(
    string RouteId,
    string FromObjectId,
    string ToId,
    DatabaseCityRouteKind Kind,
    EdgeConfidence Confidence,
    string Rationale,
    EvidenceV1 Evidence);

public sealed record DatabaseCitySummaryV1(
    string DatabaseId,
    string Name,
    string? SchemaCount,
    string? ObjectCount,
    string? ReservedBytes,
    MeasurementStatus SizeStatus,
    EvidenceV1 Evidence);

public sealed record DatabaseCitySummarySnapshotV1(
    string SchemaVersion,
    DateTimeOffset GeneratedAt,
    IReadOnlyList<DatabaseCitySummaryV1> Databases);

public sealed record DatabaseCityPageV1(
    string SchemaVersion,
    string DatabaseId,
    string DatabaseName,
    DatabaseCityMetric Metric,
    int PageSize,
    string? NextPageToken,
    string? TotalObjects,
    IReadOnlyList<DatabaseCitySchemaV1> Schemas,
    IReadOnlyList<DatabaseCityObjectV1> Objects,
    IReadOnlyList<DatabaseCityQueryFamilyV1> TopQueryFamilies,
    DatabaseCityWorkloadAggregateV1 OtherWorkload,
    IReadOnlyList<DatabaseCityRouteV1> Routes,
    EvidenceV1 Evidence);
