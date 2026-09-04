import type { DatabaseCityObject } from './databaseCityContracts'
import type { IncidentProjection } from './cityIncidents'
import type { CityRoute } from './cityRoute'
import {
  DEGRADING_WARNING_KINDS,
  EMPTY_DISASTER_SURVEY,
  type DisasterSurvey,
  type SurveyedMissingIndex,
  type SurveyedWarning,
} from './cityDisasterSurvey'

/**
 * How much of the optimizer's own estimated saving a suggested index must promise before the
 * building it names is treated as on fire.
 *
 * This is the optimizer's `Impact` attribute, which is its estimate of how much cheaper *this query*
 * would be with the index — not a measurement, and not a statement about the table overall.
 */
export const LARGE_MISSING_INDEX_IMPACT_PERCENT = 80

/**
 * Re-exported so the projection and the survey can never disagree about which warning kinds are
 * degrading. The set lives with the parser-facing code that produces the kinds.
 */
export { DEGRADING_WARNING_KINDS }

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
  /**
   * Objects whose work carries a warning the engine associates with degraded behaviour.
   *
   * Separate from {@link fireObjectIds} because they are different evidence with different remedies,
   * and because a building can honestly be both: a table with no useful index that also spills is
   * on fire *and* has a burst main under it.
   */
  readonly waterMainObjectIds: readonly string[]
  /**
   * True when at least one plan was read that carried missing-index evidence at all.
   *
   * Distinguishes "the optimizer asked for nothing" from "nothing was read", which is the difference
   * between a city with no fires and a city nobody surveyed.
   */
  readonly missingIndexesObserved: boolean
}

/**
 * A disaster whose only evidence is one routed plan is a disaster that exists for as long as the
 * operator keeps that plan on screen. Merging the routed plan into the surveyed workload is what
 * lets the same rules light the whole city permanently, and the dedupe by plan id in
 * {@link projectCityDisasters} is what stops the routed plan being counted twice once the survey
 * has read it too.
 */
function routeMissingIndexes(route: CityRoute): SurveyedMissingIndex[] {
  return route.missingIndexes.map(missing => ({
    objectId: missing.objectId,
    label: missing.label,
    impactPercent: missing.impactPercent,
    familyId: `plan:${route.planId}`,
    planId: route.planId,
  }))
}

function routeWarnings(route: CityRoute): SurveyedWarning[] {
  const warnings: SurveyedWarning[] = []
  for (const stop of route.stops) {
    for (const warning of stop.warnings) {
      const kind = warningKind(warning)
      if (!DEGRADING_WARNING_KINDS.has(kind)) continue
      warnings.push({
        kind,
        objectId: stop.objectId,
        label: stop.label,
        familyId: `plan:${route.planId}`,
        planId: route.planId,
      })
    }
  }
  /*
   * An unplaced operation's warning is real and is counted, but it belongs to no table by
   * definition -- that is what "unplaced" means -- so it carries a null object and is never drawn
   * on a building that did not produce it.
   */
  for (const operation of route.unplacedOperations) {
    for (const warning of operation.warnings) {
      const kind = warningKind(warning)
      if (!DEGRADING_WARNING_KINDS.has(kind)) continue
      warnings.push({
        kind,
        objectId: null,
        label: operation.physicalOperation,
        familyId: `plan:${route.planId}`,
        planId: route.planId,
      })
    }
  }
  return warnings
}

export function projectCityDisasters({
  incidents,
  route,
  objects,
  survey = EMPTY_DISASTER_SURVEY,
}: {
  incidents: IncidentProjection
  route: CityRoute | null
  objects: readonly DatabaseCityObject[]
  /**
   * The workload's surveyed plans. Defaults to the empty survey so a caller that has not run one --
   * or has not finished running one -- gets exactly the routed plan's evidence and no claim about
   * the rest of the workload.
   */
  survey?: DisasterSurvey
}): CityDisasterProjection {
  const items: CityDisaster[] = []

  /*
   * The routed plan is merged in only when the survey did not already read it. Both sources resolve
   * the same `<MissingIndexes>` block from the same plan id, so without this a plan that is both
   * surveyed and routed reports every one of its fires twice.
   */
  const surveyedPlanIds = new Set(survey.missingIndexes.map(missing => missing.planId))
  for (const warning of survey.warnings) surveyedPlanIds.add(warning.planId)
  const routed = route !== null && !surveyedPlanIds.has(route.planId) ? route : null

  const allMissingIndexes = routed
    ? [...survey.missingIndexes, ...routeMissingIndexes(routed)]
    : survey.missingIndexes
  const allWarnings = routed
    ? [...survey.warnings, ...routeWarnings(routed)]
    : survey.warnings
  const missingIndexesObserved =
    survey.missingIndexesObserved || (routed?.missingIndexesObserved ?? false)

  if (incidents.deadlocks.retainedCount > 0) {
    items.push({
      key: 'car-crash',
      headline: `${incidents.deadlocks.retainedCount} car crash(es) recorded`,
      detail:
        'Recorded deadlock graphs are rendered as crash events because the engine already picked a victim and rolled a transaction back.',
    })
  }

  const waterMainObjectIds = [...new Set(
    allWarnings.map(warning => warning.objectId).filter((id): id is string => id !== null),
  )]
  if (allWarnings.length > 0) {
    const kinds = [...new Set(allWarnings.map(warning => warning.kind))].sort()
    items.push({
      key: 'water-main-break',
      headline: `${allWarnings.length} water-main break signal(s)`,
      detail:
        `Compiled plan(s) carry warning(s) the engine associates with degraded behavior — ` +
        `${kinds.join(', ')}. A burst main is drawn at each of the ${waterMainObjectIds.length} ` +
        `table(s) whose own work carries one; a warning belonging to no table is counted here and ` +
        `drawn nowhere.`,
    })
  }

  const fires = allMissingIndexes.filter(
    missing =>
      missing.impactPercent !== null &&
      missing.impactPercent >= LARGE_MISSING_INDEX_IMPACT_PERCENT,
  )
  const fireObjectIds = [...new Set(
    fires.map(fire => fire.objectId).filter((id): id is string => id !== null),
  )]
  if (fires.length > 0) {
    const worst = fires.reduce((a, b) => ((b.impactPercent ?? 0) > (a.impactPercent ?? 0) ? b : a))
    items.push({
      key: 'building-fire',
      headline: `${fires.length} building fire(s)`,
      detail:
        `The optimizer asked for an index it estimates would make that query at least ` +
        `${LARGE_MISSING_INDEX_IMPACT_PERCENT}% cheaper — worst is ${worst.label} at ` +
        `${formatImpact(worst.impactPercent)}%. That is the optimizer's estimate for one plan, ` +
        `not a measurement, and not a claim about the table's other queries.`,
    })
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

  return {
    items,
    staleStatsObjectIds: stale,
    fireObjectIds,
    waterMainObjectIds,
    missingIndexesObserved,
  }
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
