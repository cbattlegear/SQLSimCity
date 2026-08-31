import type { DatabaseCityObject } from './databaseCityContracts'
import type { IncidentProjection } from './cityIncidents'
import type { CityRoute } from './cityRoute'

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
  readonly items: readonly CityDisaster[]
  /**
   * Objects carrying at least one statistic the engine's own AUTO_UPDATE_STATISTICS threshold says
   * should be updated. Per object rather than a whole-city wash, because the threshold is evaluated
   * per statistic and a city-wide flag would weather buildings whose statistics are exactly right.
   */
  readonly staleStatsObjectIds: readonly string[]
  /** Objects the optimizer asked for an index on, weighted by its own estimated impact. */
  readonly fireObjectIds: readonly string[]
}

export function projectCityDisasters({
  incidents,
  route,
  objects,
}: {
  incidents: IncidentProjection
  route: CityRoute | null
  objects: readonly DatabaseCityObject[]
}): CityDisasterProjection {
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

  const stale = staleStatsObjectIds(objects)
  if (stale.length > 0) {
    items.push({
      key: 'stats-decay',
      headline: `${stale.length} building(s) look run-down`,
      detail:
        `${stale.length} object(s) carry at least one statistic that has taken more modifications ` +
        `than SQL Server's own AUTO_UPDATE_STATISTICS recompilation threshold for its cardinality ` +
        `— 500 modifications up to 500 rows, then MIN(500 + 0.20n, SQRT(1000n)). That is the ` +
        `engine's own definition of a statistic worth rebuilding, not a claim about age.`,
    })
  }

  return { items, staleStatsObjectIds: stale, fireObjectIds }
}

/**
 * Objects carrying at least one statistic the engine would consider out of date.
 *
 * Measured by modification counter against the AUTO_UPDATE_STATISTICS recompilation threshold rather
 * than by age, because the two disagree in both directions: a statistic built a year ago against a
 * table nothing has modified since is still exactly right, and one built this morning against a
 * table bulk-loaded since is not. Age was the old rule and weathered the first case for free.
 *
 * An object with no measurement is skipped entirely. Absent statistics mean the probe never ran — an
 * archive from an older build, or a denied permission — and weathering a building on that basis
 * would render missing evidence as a finding. `pastAutoUpdateThresholdCount` being null or absent is
 * the same thing one field down: an archive written before the threshold was measured, which is not
 * a measured zero.
 *
 * A never-updated statistic is deliberately not weathering on its own. It is not evidence that an
 * update is owed — a statistic on a table nothing has modified has nothing to rebuild from — and it
 * becomes visible here through the threshold as soon as modifications actually accumulate.
 */
function staleStatsObjectIds(objects: readonly DatabaseCityObject[]): string[] {
  const ids: string[] = []
  for (const object of objects) {
    const statistics = object.statistics
    if (!statistics || statistics.status !== 'Known') continue
    // No statistics at all is not staleness. A heap nothing has ever queried has nothing to update,
    // and weathering it would make "small and untouched" look like "neglected".
    if (statistics.statisticsCount === 0) continue

    // Absent or null is an archive written before the threshold was measured. It reads as "not
    // past the threshold" rather than falling back to age or to the raw modification counter,
    // because neither can be compared to a threshold that was never computed.
    const past = statistics.pastAutoUpdateThresholdCount ?? 0
    if (past > 0) ids.push(object.objectId)
  }
  return ids
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
