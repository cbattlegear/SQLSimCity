import type { DatabaseCityObject } from './databaseCityContracts'
import type { IncidentProjection } from './cityIncidents'
import type { CityRoute } from './cityRoute'

export const DEFAULT_STATS_STALE_DAYS = 7
export const STATS_STALE_DAYS_PARAM = 'statsStaleDays'

/**
 * How much of the optimizer's own estimated saving a suggested index must promise before the
 * building it names is treated as on fire.
 *
 * This is the optimizer's `Impact` attribute, which is its estimate of how much cheaper *this query*
 * would be with the index — not a measurement, and not a statement about the table overall.
 */
export const LARGE_MISSING_INDEX_IMPACT_PERCENT = 80

/**
 * Warning kinds the parser can actually produce, which is narrower than the set of kinds SQL Server
 * documents.
 *
 * A kind is the raw Showplan element or attribute name. `SpillToTempDb` and `PlanAffectingConvert`
 * are elements; `NoJoinPredicate` is an attribute on `<Warnings>` and only became reachable once the
 * parser started reading those. Names that are neither — `HashSpill`, `SortSpill` — match nothing no
 * matter how plausible they look, so they are deliberately absent rather than kept as harmless
 * spares: a set entry that can never match is a rule that silently never fires.
 */
const DEGRADING_WARNING_KINDS = new Set([
  'spilltotempdb',
  'unmatchedindexes',
  'planaffectingconvert',
  'nojoinpredicate',
  'columnswithnostatistics',
])

export interface CityDisaster {
  readonly key: 'water-main-break' | 'building-fire' | 'car-crash' | 'stats-decay'
  readonly headline: string
  readonly detail: string
}

export interface CityDisasterProjection {
  readonly staleStatsDays: number
  readonly items: readonly CityDisaster[]
  /**
   * Objects whose statistics are stale enough to weather the building. Per object rather than a
   * whole-city wash, because staleness is measured per object and a city-wide flag would weather
   * buildings whose statistics were rebuilt an hour ago.
   */
  readonly staleStatsObjectIds: readonly string[]
  /** Objects the optimizer asked for an index on, weighted by its own estimated impact. */
  readonly fireObjectIds: readonly string[]
}

export function projectCityDisasters({
  incidents,
  route,
  objects,
  search,
  now = Date.now(),
}: {
  incidents: IncidentProjection
  route: CityRoute | null
  objects: readonly DatabaseCityObject[]
  search: string
  now?: number
}): CityDisasterProjection {
  const staleStatsDays = statsStaleDaysFromSearch(search)
  const items: CityDisaster[] = []
  const fireObjectIds: string[] = []

  if (incidents.deadlocks.retainedCount > 0) {
    items.push({
      key: 'car-crash',
      headline: `${incidents.deadlocks.retainedCount} car crash(es) recorded`,
      detail:
        'Recorded deadlock graphs are rendered as crash events because the engine already picked a victim and rolled a transaction back.',
    })
  }

  if (route) {
    const degradedCount = route.stops
      .flatMap(stop => stop.warnings)
      .concat(route.unplacedOperations.flatMap(operation => operation.warnings))
      .filter(warning => DEGRADING_WARNING_KINDS.has(warningKind(warning))).length
    if (degradedCount > 0) {
      items.push({
        key: 'water-main-break',
        headline: `${degradedCount} water-main break signal(s)`,
        detail:
          'The routed plan carries warning(s) the engine associates with degraded behavior — spills to tempdb, plan-affecting converts, a join with no predicate, or columns with no statistics.',
      })
    }

    const fires = route.missingIndexes.filter(
      missing =>
        missing.impactPercent !== null &&
        missing.impactPercent >= LARGE_MISSING_INDEX_IMPACT_PERCENT,
    )
    for (const fire of fires) if (fire.objectId !== null) fireObjectIds.push(fire.objectId)
    if (fires.length > 0) {
      const worst = fires.reduce((a, b) => ((b.impactPercent ?? 0) > (a.impactPercent ?? 0) ? b : a))
      items.push({
        key: 'building-fire',
        headline: `${fires.length} building fire(s)`,
        detail:
          `The optimizer asked for an index it estimates would make this query at least ` +
          `${LARGE_MISSING_INDEX_IMPACT_PERCENT}% cheaper — worst is ${worst.label} at ` +
          `${formatImpact(worst.impactPercent)}%. That is the optimizer's estimate for this plan, ` +
          `not a measurement, and not a claim about the table's other queries.`,
      })
    }
  }

  const stale = staleStatsObjects(objects, staleStatsDays, now)
  if (stale.ids.length > 0) {
    items.push({
      key: 'stats-decay',
      headline: `${stale.ids.length} building(s) look run-down`,
      detail: stale.neverUpdated
        ? `Statistics on ${stale.ids.length} object(s) are older than the ${staleStatsDays}-day threshold, or have never been built at all.`
        : `Statistics on ${stale.ids.length} object(s) were last updated more than ${staleStatsDays} day(s) ago.`,
    })
  }

  return { staleStatsDays, items, staleStatsObjectIds: stale.ids, fireObjectIds }
}

/**
 * Objects whose statistics are stale, and whether any of them are stale because they were never
 * built rather than because they are old.
 *
 * An object with no measurement is skipped entirely. Absent statistics mean the probe never ran — an
 * archive from an older build, or a denied permission — and weathering a building on that basis
 * would render missing evidence as a finding.
 */
function staleStatsObjects(
  objects: readonly DatabaseCityObject[],
  staleStatsDays: number,
  now: number,
): { ids: string[]; neverUpdated: boolean } {
  const ids: string[] = []
  let neverUpdated = false
  for (const object of objects) {
    const statistics = object.statistics
    if (!statistics || statistics.status !== 'Known') continue
    // No statistics at all is not staleness. A heap nothing has ever queried has nothing to update,
    // and weathering it would make "small and untouched" look like "neglected".
    if (statistics.statisticsCount === 0) continue

    if (statistics.neverUpdatedCount > 0) {
      neverUpdated = true
      ids.push(object.objectId)
      continue
    }

    const age = ageInDays(statistics.oldestLastUpdated, now)
    if (age !== null && age > staleStatsDays) ids.push(object.objectId)
  }
  return { ids, neverUpdated }
}

export function statsStaleDaysFromSearch(search: string): number {
  const raw = new URLSearchParams(search).get(STATS_STALE_DAYS_PARAM)
  if (raw === null) return DEFAULT_STATS_STALE_DAYS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return DEFAULT_STATS_STALE_DAYS
  const whole = Math.floor(parsed)
  return whole >= 1 ? whole : DEFAULT_STATS_STALE_DAYS
}

/**
 * A route warning is rendered as `Kind` or `Kind: detail`, and the kind is a raw Showplan name.
 * Compared case-insensitively because the .NET vocabulary that produces these compares that way, and
 * a set that disagreed with it about case would silently miss.
 */
function warningKind(warning: string): string {
  const cut = warning.indexOf(':')
  return (cut >= 0 ? warning.slice(0, cut) : warning).trim().toLowerCase()
}

function formatImpact(value: number | null): string {
  return value === null ? '?' : Math.round(value).toString()
}

function ageInDays(observedAt: string | null, now: number): number | null {
  if (observedAt === null) return null
  const then = Date.parse(observedAt)
  if (!Number.isFinite(then)) return null
  const days = (now - then) / (24 * 60 * 60 * 1000)
  if (!Number.isFinite(days) || days < 0) return null
  return Math.floor(days)
}
