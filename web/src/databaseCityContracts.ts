import type { DataStatus, EdgeConfidence, Evidence, EvidenceSource, MeasurementStatus } from './contracts'

export type DatabaseCityMetric = 'Cpu' | 'Duration' | 'Reads' | 'Executions'
export type DatabaseObjectKind = 'Table' | 'IndexedView'
export type DatabaseIndexKind = 'Heap' | 'Clustered' | 'Nonclustered' | 'Columnstore' | 'Other'
export type QueryAttributionConfidence = 'Confirmed' | 'Probable' | 'Unknown'
export type DatabaseCityRouteKind = 'ObjectReference' | 'CrossDatabaseReference'

export interface DatabaseCityDirectActivity {
  totalOperations: string | null
  resetEpochToken: string | null
  evidence: Evidence
}

/**
 * Query Store totals from ranked families that named this object *alongside others*, carried whole
 * and never divided: Query Store measures one total per query, never a per-object share. The same
 * figures repeat on every other object those queries named, so these values are **not additive
 * across buildings** — summing them over a city counts one query once per table it touched.
 */
export interface DatabaseCitySharedExposure {
  familyCount: string
  executionCount: string
  totalCpuMicroseconds: string
  totalDurationMicroseconds: string
  totalLogicalReads8KiBPages: string
  rationale: string
}

export interface DatabaseCityAttributedExposure {
  executionCount: string | null
  totalCpuMicroseconds: string | null
  totalDurationMicroseconds: string | null
  totalLogicalReads8KiBPages: string | null
  confidence: QueryAttributionConfidence
  rationale: string
  evidence: Evidence
  /**
   * Non-additive query-level totals from families that named this object alongside others, or null
   * when no ranked family did. Present even when the scalars above are null, which is the normal
   * case for a normalized schema where every ranked query joins several tables.
   */
  shared?: DatabaseCitySharedExposure | null
}

export interface DatabaseCityIndex {
  indexId: string
  name: string
  kind: DatabaseIndexKind
  directActivity: DatabaseCityDirectActivity
}

/**
 * How stale one object's statistics are.
 *
 * `oldestLastUpdated` is the freshness of the object's **stalest** statistic, so an object is only
 * as fresh as its worst one. It is null when no statistic on the object has ever been updated —
 * which is why `neverUpdatedCount` is separate. A never-built statistic is not an old measurement,
 * and collapsing the two reports a never-analysed object as fresh.
 *
 * `unreadableCount` counts statistics whose properties could not be read at all, because
 * `sys.dm_db_stats_properties` returns no row rather than raising when the caller lacks permission.
 * That is missing evidence, not staleness, and must not be rendered as either.
 *
 * `pastAutoUpdateThresholdCount` is how many of the object's statistics have taken more
 * modifications than the engine's own `AUTO_UPDATE_STATISTICS` recompilation threshold for their
 * cardinality, and is the only field here that says a statistic *should* be updated.
 * `oldestLastUpdated` does not — an untouched table's year-old statistic is still exactly right. It
 * is null when the archive predates the measurement, which is missing evidence, not a measured zero.
 */
export interface DatabaseCityStatisticsAge {
  oldestLastUpdated: string | null
  statisticsCount: number
  neverUpdatedCount: number
  unreadableCount: number
  modificationCounter: string | null
  status: MeasurementStatus
  reason: string | null
  pastAutoUpdateThresholdCount?: number | null
}

export interface DatabaseCityObject {
  objectId: string
  schemaId: string
  schemaName: string
  name: string
  kind: DatabaseObjectKind
  reservedPages8KiB: string | null
  usedPages8KiB: string | null
  reservedBytes: string | null
  usedBytes: string | null
  sizeStatus: MeasurementStatus
  sizeReason: string | null
  /**
   * Where the collector put this object in its stable ordering.
   *
   * `neighborhoodOrdinal` is the schema's position among the database's schemas. `objectOrdinal` is
   * the object's position among **every object in the database**, not within its own schema — the one
   * meaning both collectors can honour (#49). Both state an order and nothing else: nothing that
   * sizes the city may be derived from an ordinal, because an ordinal is not a count. `x`/`z` are
   * legacy lattice coordinates the city no longer reads.
   */
  layout: { neighborhoodOrdinal: number; objectOrdinal: number; x: number; z: number }
  indexes: DatabaseCityIndex[]
  directActivity: DatabaseCityDirectActivity
  attributedExposure: DatabaseCityAttributedExposure

  /**
   * Statistics freshness for this object. Optional because an archive written before the probe
   * existed has none: `undefined` means nobody measured it, which is not the same as fresh.
   */
  statistics?: DatabaseCityStatisticsAge | null
}

export interface DatabaseCitySchema {
  schemaId: string
  name: string
  neighborhoodOrdinal: number
  objectCount: string
  evidence: Evidence
}

/**
 * One object's modelled share of a query family's measured wait time.
 *
 * `waitMilliseconds` is **not** a measurement of how long this object waited. Query Store measures
 * one wait total per query and never says which table caused it. The split is `estimatedCostShare`:
 * the fraction of the compiled plan's *estimated* cost the optimizer placed on operators reading
 * this object. Anything drawn from it has to say so.
 */
export interface DatabaseCityObjectWaitShare {
  objectId: string
  estimatedCostShare: number
  waitMilliseconds: string
}

/**
 * A family's measured wait time apportioned across the objects its compiled plans read.
 *
 * The parts and `unattributedWaitMilliseconds` sum to exactly `totalWaitMilliseconds`, so the split
 * can always be added back up and checked against the measurement it came from. The unattributed
 * part covers cost the plan spent on no object at all, plus every object the plan named that this
 * page does not draw. An empty `objects` list means no apportionment was possible, never that
 * nothing waited.
 */
export interface DatabaseCityWaitAttribution {
  objects: DatabaseCityObjectWaitShare[]
  unattributedWaitMilliseconds: string
  plansRead: number
  rationale: string
}

/** One object's share of the estimated bytes a family's plans move per execution. */
export interface DatabaseCityObjectDataVolume {
  objectId: string
  estimatedBytesPerExecution: string
}

/**
 * How many bytes one execution of this query family was expected to move, from the optimizer's own
 * per-operator row counts and row sizes.
 *
 * This is an estimate made when the plan was compiled, against the statistics that existed then --
 * not a measurement of any execution. A plan whose cardinality estimate is wrong produces a volume
 * wrong by the same factor, and nothing here detects that. `rationale` says so, and anything drawn
 * from these numbers has to repeat it.
 *
 * Byte counts are decimal strings because the product of a row count and a row size routinely
 * exceeds what a JSON number survives intact.
 */
export interface DatabaseCityPlanDataVolume {
  estimatedBytesPerExecution: string
  byObject: DatabaseCityObjectDataVolume[]
  plansRead: number
  rationale: string
}

export interface DatabaseCityQueryFamily {
  familyId: string
  queryHash: string
  executionCount: string
  totalCpuMicroseconds: string
  totalDurationMicroseconds: string
  totalLogicalReads8KiBPages: string
  totalWaitMilliseconds: string
  /**
   * Captured wait milliseconds keyed by verbatim Query Store `wait_category_desc`. An empty object
   * means the breakdown was not captured — `sys.query_store_wait_stats` does not exist before
   * SQL Server 2017 (14.x) — and never that the family waited for nothing.
   */
  waitMillisecondsByCategory: Record<string, string>
  objectIds: string[]
  confidence: QueryAttributionConfidence
  rationale: string
  evidence: Evidence
  /**
   * The same wait total spread over the objects the family's plans read, in proportion to estimated
   * plan cost. Optional because a page collected before the split existed carries no attribution;
   * absent means "not apportioned", never "nothing waited".
   */
  waitAttribution?: DatabaseCityWaitAttribution | null

  /**
   * Estimated bytes one execution of this family moves, per object, from the optimizer's own row
   * counts and row sizes in the compiled plans Query Store retained.
   *
   * Absent means no retained plan stated both a row count and a row size -- "the plans did not
   * say", never "this family moves no data". A consumer sizing anything by this must render the
   * absent case as unknown rather than as the smallest bucket.
   */
  planDataVolume?: DatabaseCityPlanDataVolume | null

  /**
   * What this family did inside the recent traffic window, which is what street colour is graded
   * from. Absent on a page built before the window existed — an archive, or a fixture — and there
   * the retained totals are all there is, so grading falls back to them rather than to grey.
   */
  recentActivity?: DatabaseCityRecentActivity | null
}

/**
 * A query family's activity inside the recent traffic window.
 *
 * `covered` is the field that matters. It is false when no retained Query Store interval overlapped
 * the window at all, and every count below is then zero — which is "nothing was captured here", not
 * "this street is quiet". Rendering the two the same is the easiest way to make the map claim a road
 * is clear when it was never measured.
 *
 * Counts are summed from intervals that *overlap* the window, not ones contained by it, because
 * Query Store's current interval is still open and holds the live traffic. They are therefore not
 * pro-rated to the window, and a wider interval contributes everything it measured. The ratio the
 * colour is graded from — wait per execution — is unaffected by that.
 */
export interface DatabaseCityRecentActivity {
  windowMinutes: number
  windowStart: string
  windowEnd: string
  covered: boolean
  executionCount: string
  totalDurationMicroseconds: string
  totalWaitMilliseconds: string
  rationale: string
}

export interface DatabaseCityWorkloadAggregate {
  familyCount: string | null
  executionCount: string | null
  totalCpuMicroseconds: string | null
  totalDurationMicroseconds: string | null
  totalLogicalReads8KiBPages: string | null
  totalWaitMilliseconds: string | null
  evidence: Evidence
}

export interface DatabaseCityRoute {
  routeId: string
  fromObjectId: string
  toId: string
  kind: DatabaseCityRouteKind
  confidence: EdgeConfidence
  rationale: string
  evidence: Evidence
}

export interface DatabaseCitySummary {
  databaseId: string
  name: string
  schemaCount: string | null
  objectCount: string | null
  reservedBytes: string | null
  sizeStatus: MeasurementStatus
  evidence: Evidence
}

export interface DatabaseCitySummarySnapshot {
  schemaVersion: string
  generatedAt: string
  databases: DatabaseCitySummary[]
}

export interface DatabaseCityPage {
  schemaVersion: string
  databaseId: string
  databaseName: string
  metric: DatabaseCityMetric
  pageSize: number
  nextPageToken: string | null
  totalObjects: string | null
  schemas: DatabaseCitySchema[]
  objects: DatabaseCityObject[]
  topQueryFamilies: DatabaseCityQueryFamily[]
  otherWorkload: DatabaseCityWorkloadAggregate
  routes: DatabaseCityRoute[]
  evidence: Evidence
}

export type { DataStatus, EvidenceSource }
