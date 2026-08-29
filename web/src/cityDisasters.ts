import type { IncidentProjection } from './cityIncidents'
import type { CityRoute } from './cityRoute'

export const DEFAULT_STATS_STALE_DAYS = 7
export const STATS_STALE_DAYS_PARAM = 'statsStaleDays'
export const LARGE_MISSING_INDEX_SHARE = 0.25

const DEGRADING_WARNING_KINDS = new Set([
  'SpillToTempDb',
  'HashSpill',
  'SortSpill',
  'NoJoinPredicate',
  'UnmatchedIndexes',
  'PlanAffectingConvert',
])

const MISSING_INDEX_WARNING_KINDS = new Set([
  'MissingIndex',
  'MissingIndexGroup',
])

export interface CityDisaster {
  readonly key: 'water-main-break' | 'building-fire' | 'car-crash' | 'stats-decay'
  readonly headline: string
  readonly detail: string
}

export interface CityDisasterProjection {
  readonly staleStatsDays: number
  readonly items: readonly CityDisaster[]
}

export function projectCityDisasters({
  incidents,
  route,
  queryStoreObservedAt,
  search,
  now = Date.now(),
}: {
  incidents: IncidentProjection
  route: CityRoute | null
  queryStoreObservedAt: string | null
  search: string
  now?: number
}): CityDisasterProjection {
  const staleStatsDays = statsStaleDaysFromSearch(search)
  const items: CityDisaster[] = []

  if (incidents.deadlocks.retainedCount > 0) {
    items.push({
      key: 'car-crash',
      headline: `${incidents.deadlocks.retainedCount} car crash(es) recorded`,
      detail: 'Recorded deadlock graphs are rendered as crash events because the engine already picked a victim and rolled a transaction back.',
    })
  }

  if (route) {
    const warningKinds = route.stops
      .flatMap(stop => stop.warnings)
      .concat(route.unplacedOperations.flatMap(operation => operation.warnings))
      .map(warningKind)

    const degradedCount = warningKinds.filter(kind => DEGRADING_WARNING_KINDS.has(kind)).length
    if (degradedCount > 0) {
      items.push({
        key: 'water-main-break',
        headline: `${degradedCount} water-main break signal(s)`,
        detail: 'The routed plan has material warning(s) associated with degraded behavior (spills, plan-affecting converts, or similarly disruptive operators).',
      })
    }

    const fires = route.stops.filter(stop =>
      stop.estimatedCostShare >= LARGE_MISSING_INDEX_SHARE &&
      stop.warnings.some(warning => MISSING_INDEX_WARNING_KINDS.has(warningKind(warning))))
    if (fires.length > 0) {
      items.push({
        key: 'building-fire',
        headline: `${fires.length} building fire(s)`,
        detail: `A high-share route stop (≥${Math.round(LARGE_MISSING_INDEX_SHARE * 100)}% estimated cost) reported a missing-index warning.`,
      })
    }
  }

  const ageDays = ageInDays(queryStoreObservedAt, now)
  if (ageDays !== null && ageDays > staleStatsDays) {
    items.push({
      key: 'stats-decay',
      headline: 'Buildings look run-down',
      detail: `Query Store evidence is about ${ageDays} day(s) old, beyond the configured ${staleStatsDays}-day decay threshold.`,
    })
  }

  return { staleStatsDays, items }
}

export function statsStaleDaysFromSearch(search: string): number {
  const raw = new URLSearchParams(search).get(STATS_STALE_DAYS_PARAM)
  if (raw === null) return DEFAULT_STATS_STALE_DAYS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return DEFAULT_STATS_STALE_DAYS
  const whole = Math.floor(parsed)
  return whole >= 1 ? whole : DEFAULT_STATS_STALE_DAYS
}

function warningKind(warning: string): string {
  const cut = warning.indexOf(':')
  return (cut >= 0 ? warning.slice(0, cut) : warning).trim()
}

function ageInDays(observedAt: string | null, now: number): number | null {
  if (observedAt === null) return null
  const then = Date.parse(observedAt)
  if (!Number.isFinite(then)) return null
  const days = (now - then) / (24 * 60 * 60 * 1000)
  if (!Number.isFinite(days) || days < 0) return null
  return Math.floor(days)
}
