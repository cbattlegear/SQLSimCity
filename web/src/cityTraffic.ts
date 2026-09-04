import type { EdgeConfidence } from './contracts'
import type { DatabaseCityQueryFamily, DatabaseCityRoute } from './databaseCityContracts'
import {
  familyTrafficMeasurement, trafficBasis, trafficCoverageNote, trafficDelay, trafficInteger,
  type TrafficBasis,
} from './cityTrafficWindow'

/**
 * Turns co-reference edges into roads carrying a GPS-style congestion colour.
 *
 * Colour is the only channel this map spends on how busy a road is, and it is spent on one measured
 * ratio: the mean wait milliseconds a single captured execution carried over that road. Width used
 * to carry executions on a log2 scale and no longer does — every road is drawn at
 * {@link ROAD_WIDTH}. That is a deliberate trade: a GPS map codes congestion by colour alone, and
 * two channels competing for the same ribbon meant neither got read.
 *
 * **The measurement did not go anywhere.** `executions` stays on {@link RoadTraffic}, in the hover
 * rationale and in the evidence tables; it stopped being a *visual* channel, which is not the same
 * as being dropped. So did `waitShare`, which answers a different question about the same waiting
 * and is still written out per road.
 *
 * A road with no co-referencing family evidence is **not** claimed to be quiet: it is graded
 * `unknown` and drawn as a grey dashed wireframe, because "Query Store captured nothing about this
 * pair" and "this pair is idle" are different statements and only the first is supported. Folding
 * grey into green is the easiest way to make this map lie, so the grey is desaturated and nowhere
 * near the green.
 *
 * Confidence is carried by the line *pattern*, as it has been since colour was spoken for.
 */

/**
 * The GPS ladder: free-flowing, then three grades of delay, plus "not measured".
 *
 * Four bands rather than three because on a three-band ladder every road that waits at all lands in
 * amber, and most of a real workload waits a little. `unknown` is not a fifth band on that scale —
 * it is off the scale entirely.
 */
export type CongestionGrade = 'free' | 'moderate' | 'heavy' | 'severe' | 'unknown'

/** GPS palette. `unknown` is deliberately a desaturated grey so it never reads as "clear". */
export const CONGESTION_COLORS: Readonly<Record<CongestionGrade, number>> = {
  free: 0x39c46b,
  moderate: 0xe8b13a,
  heavy: 0xe87a2b,
  severe: 0xe4483c,
  unknown: 0x5a6270,
}

export const CONGESTION_LABELS: Readonly<Record<CongestionGrade, string>> = {
  free: 'Free-flowing',
  moderate: 'Moderate delay',
  heavy: 'Heavy delay',
  severe: 'Severe delay',
  unknown: 'No captured wait evidence',
}

/** The bands in ladder order, for legends and for tests that must cover all of them. */
export const CONGESTION_GRADES: readonly CongestionGrade[] = [
  'free',
  'moderate',
  'heavy',
  'severe',
  'unknown',
]

/**
 * Grade thresholds, in milliseconds of captured waiting per captured execution.
 *
 * **Invented cut points on a measured ratio.** The milliseconds and the execution counts are both
 * Query Store's; where the line between amber and orange falls is a choice made here, and it is
 * stated rather than implied.
 *
 * The upper two are the cut points this codebase has graded street load by since it was first
 * drawn — 5 ms and 50 ms per execution — kept unchanged so nothing that was red turns green. The
 * fourth band splits what used to be a single `low`: under half a millisecond of waiting per
 * execution a road is free-flowing, and between that and 5 ms it is moving but not freely.
 */
export const MODERATE_DELAY_MS_PER_EXECUTION = 0.5
export const HEAVY_DELAY_MS_PER_EXECUTION = 5
export const SEVERE_DELAY_MS_PER_EXECUTION = 50

/** Live blocking overrides the Query Store grade: a session blocked right now is the worst band. */
export const LIVE_BLOCKING_GRADE: CongestionGrade = 'severe'

/**
 * One width for every road, in world units.
 *
 * Roads used to be sized by captured executions and are not any more, so the network reads as one
 * road network at a glance instead of as a chart. The value sits inside the old 2.2–11 range: no
 * road got thinner than the thinnest that used to be drawn, and none got thicker than the thickest.
 */
export const ROAD_WIDTH = 5.2

/** Line pattern carries edge confidence now that colour carries congestion. */
export type RoadPattern = 'solid' | 'dashed' | 'sparse'

export interface RoadTraffic {
  readonly routeId: string
  readonly fromObjectId: string
  readonly toId: string
  readonly kind: DatabaseCityRoute['kind']
  readonly confidence: EdgeConfidence
  readonly pattern: RoadPattern
  /** Always {@link ROAD_WIDTH}. Kept on the record so the scene reads width from one place. */
  readonly width: number
  readonly grade: CongestionGrade
  readonly color: number
  /** Retained executions of families naming both endpoints; geography, not the recent denominator. */
  readonly executions: number | null
  /** Wait / duration in the grading window, or null when any contributor is unmeasured. */
  readonly waitShare: number | null
  /** Mean captured wait milliseconds per captured execution — what the colour is graded from. */
  readonly delayPerExecution: number | null
  /**
   * Executions inside the recent traffic window, or null for incomplete coverage. A covered zero
   * stays zero. Distinct from {@link executions}, the retained total across the whole horizon.
   */
  readonly recentExecutions: number | null
  /** Width of the recent traffic window in minutes, or null when the page published none. */
  readonly recentWindowMinutes: number | null
  /** Ids of the query families that produced this road's numbers, for drill-down. */
  readonly familyIds: readonly string[]
  /** Plain-language justification shown in the HUD, never omitted. */
  readonly rationale: string
}

export interface LiveBlockingEdge {
  /** Object id or `schema.object` of the object a blocked session is waiting on. */
  readonly objectKey: string
  readonly blockedSessionCount: number
}

/**
 * Sum of executions across every family naming both endpoints. Returns null when no family names the
 * pair, which is an absence of evidence rather than a measurement of zero.
 */
export function roadVolume(
  route: Pick<DatabaseCityRoute, 'fromObjectId' | 'toId'>,
  families: readonly DatabaseCityQueryFamily[],
): { executions: number | null; familyIds: string[] } {
  const familyIds: string[] = []
  let executions = 0
  for (const family of families) {
    if (!family.objectIds.includes(route.fromObjectId)) continue
    if (!family.objectIds.includes(route.toId)) continue
    familyIds.push(family.familyId)
    const count = trafficInteger(family.executionCount)
    if (count === null) executions = Number.NaN
    else executions += Number(count)
  }
  return { executions: familyIds.length === 0 || !Number.isFinite(executions) ? null : executions, familyIds }
}

/**
 * Fraction of captured wall-clock time spent waiting, or null when either side is unmeasured.
 * `totalWaitMilliseconds` and `totalDurationMicroseconds` are lossless base-10 strings, so they are
 * parsed defensively.
 *
 * No longer what the colour is graded from — see {@link roadDelay} — but still reported per road,
 * because "half of this road's time went on waiting" answers something the ratio does not.
 */
export function waitShare(
  families: readonly DatabaseCityQueryFamily[],
  basis: TrafficBasis = trafficBasis(families),
): number | null {
  let waitMs = 0n
  let durationUs = 0n
  for (const family of families) {
    const sample = familyTrafficMeasurement(family, basis)
    if (sample.waitMilliseconds === null || sample.durationMicroseconds === null) return null
    waitMs += sample.waitMilliseconds
    durationUs += sample.durationMicroseconds
  }
  if (durationUs <= 0n) return null
  const share = Number(waitMs) / (Number(durationUs) / 1000)
  return Number.isFinite(share) ? share : null
}

/**
 * Mean captured wait milliseconds per captured execution across the families naming both endpoints.
 *
 * This is the same ratio the aggregate street load is graded by, so a road ribbon and the street it
 * runs along are coloured by one rule rather than by two that happen to share a palette. Null when
 * any family is unmeasured or none reported executions. This standalone helper describes history;
 * gradeRoads selects the city-wide recent basis before considering the families on one road.
 */
export function roadDelay(families: readonly DatabaseCityQueryFamily[]): number | null {
  let waitMs = 0n
  let executions = 0n
  for (const family of families) {
    const wait = trafficInteger(family.totalWaitMilliseconds)
    const count = trafficInteger(family.executionCount)
    if (wait === null || count === null) return null
    waitMs += wait
    executions += count
  }
  return trafficDelay(executions, waitMs)
}

/**
 * Mean wait milliseconds per execution inside the recent traffic window.
 *
 * A covered subset never stands for the whole road. Callers grading a subset must supply the basis
 * selected from the whole city so a missing family cannot fall back to retained history.
 */
export function recentRoadDelay(
  families: readonly DatabaseCityQueryFamily[],
  basis: TrafficBasis = trafficBasis(families),
): {
  delay: number | null
  published: boolean
  covered: boolean
  complete: boolean
  coveredFamilyCount: number
  familyCount: number
  executions: number | null
  windowMinutes: number | null
} {
  let coveredFamilyCount = 0
  let waitMs = 0n
  let executions = 0n
  for (const family of families) {
    const sample = familyTrafficMeasurement(family, basis)
    if (!sample.covered) continue
    coveredFamilyCount += 1
    waitMs += sample.waitMilliseconds!
    executions += sample.executions!
  }
  const published = basis.kind === 'recent'
  const complete = published && families.length > 0 && coveredFamilyCount === families.length
  return {
    delay: complete ? trafficDelay(executions, waitMs, true) : null,
    published,
    covered: published && coveredFamilyCount > 0,
    complete,
    coveredFamilyCount: published ? coveredFamilyCount : 0,
    familyCount: families.length,
    executions: complete && Number.isFinite(Number(executions)) ? Number(executions) : null,
    windowMinutes: basis.window?.windowMinutes ?? null,
  }
}

/** The ladder itself. Shared by the co-reference roads and by the aggregate street load. */
export function congestionFromDelay(delay: number | null): CongestionGrade {
  if (delay === null || !Number.isFinite(delay) || delay < 0) return 'unknown'
  if (delay >= SEVERE_DELAY_MS_PER_EXECUTION) return 'severe'
  if (delay >= HEAVY_DELAY_MS_PER_EXECUTION) return 'heavy'
  if (delay >= MODERATE_DELAY_MS_PER_EXECUTION) return 'moderate'
  return 'free'
}

export function confidencePattern(confidence: EdgeConfidence): RoadPattern {
  switch (confidence) {
    case 'Confirmed':
      return 'solid'
    case 'Probable':
      return 'dashed'
    default:
      return 'sparse'
  }
}

/**
 * Grades every route. `liveBlocking` is optional: when the backend can resolve a live lock wait to an
 * object, any road touching that object is upgraded to the worst band and says so in its rationale.
 */
export function gradeRoads(
  routes: readonly DatabaseCityRoute[],
  families: readonly DatabaseCityQueryFamily[],
  liveBlocking: readonly LiveBlockingEdge[] = [],
): RoadTraffic[] {
  const blockedKeys = new Set(liveBlocking.filter(edge => edge.blockedSessionCount > 0).map(edge => edge.objectKey))
  const basis = trafficBasis(families)
  return routes.map(route => {
    const { executions, familyIds } = roadVolume(route, families)
    const matched = families.filter(family => familyIds.includes(family.familyId))
    const share = waitShare(matched, basis)
    const retainedDelay = roadDelay(matched)
    const recent = recentRoadDelay(matched, basis)
    // The window wins wherever it exists, including when it is empty: a street that carried nothing
    // in the last quarter of an hour is not congested now, whatever the day's totals say. Only a
    // page that never published a window falls back to those totals.
    const delay = recent.published ? recent.delay : retainedDelay
    const capturedGrade = congestionFromDelay(delay)
    const blocked = blockedKeys.has(route.fromObjectId) || blockedKeys.has(route.toId)
    const grade = blocked ? LIVE_BLOCKING_GRADE : capturedGrade
    return {
      routeId: route.routeId,
      fromObjectId: route.fromObjectId,
      toId: route.toId,
      kind: route.kind,
      confidence: route.confidence,
      pattern: confidencePattern(route.confidence),
      width: ROAD_WIDTH,
      grade,
      color: CONGESTION_COLORS[grade],
      executions,
      waitShare: share,
      delayPerExecution: delay,
      recentExecutions: recent.executions,
      recentWindowMinutes: recent.windowMinutes,
      familyIds,
      rationale: describe(executions, familyIds.length, share, delay, grade, blocked, recent),
    }
  })
}

function describe(
  executions: number | null,
  familyCount: number,
  share: number | null,
  delay: number | null,
  grade: CongestionGrade,
  blocked: boolean,
  recent: ReturnType<typeof recentRoadDelay>,
): string {
  const volume =
    executions === null
      ? familyCount === 0
        ? 'No captured query family names both endpoints, so no traffic volume is claimed.'
        : `Retained execution volume is unavailable for ${familyCount} contributing query families.`
      : `${executions.toLocaleString()} captured execution(s) across ${familyCount} query family/families (retained history).`
  const coverage = recent.published && !recent.complete
    ? ` Partial or missing capture in the recent window: ${recent.coveredFamilyCount} of ${recent.familyCount} families have usable runtime and wait capture; missing capture is unknown, not a clear road.`
    : ''
  if (blocked) {
    return `${volume}${coverage} Graded ${CONGESTION_LABELS[grade].toLowerCase()} because a live lock wait resolves to an endpoint of this road.`
  }
  if (recent.published && !recent.complete) {
    return `${volume}${coverage} No current congestion grade is claimed.`
  }
  if (delay === null) {
    return `${volume} Captured waiting per execution is unavailable, so no congestion grade is claimed.`
  }
  const shareText = share === null ? '' : `, ${(share * 100).toFixed(1)}% of captured duration`
  if (recent.published) {
    return `${(recent.executions ?? 0).toLocaleString()} execution(s) in the last ${recent.windowMinutes} minutes, ${delay.toFixed(2)} ms of waiting each — ${CONGESTION_LABELS[grade].toLowerCase()}. ${volume} Recent figures are whole-family totals, not a per-building allocation.`
  }
  return `${volume} ${delay.toFixed(2)} ms of captured waiting per execution${shareText} — ${CONGESTION_LABELS[grade].toLowerCase()}.`
}

export interface TrafficWindowDisclosure {
  headline: string
  detail: string
  windowMinutes: number | null
  covered: boolean
}

/**
 * What the road colours on this page were actually graded from, in words.
 *
 * The colours changed meaning: they used to be the whole retained history and are now the last few
 * minutes of it. A map that quietly swapped one for the other would be reporting a different claim
 * under an unchanged legend, so the legend has to say which one it is -- including the awkward case
 * where the window is published but capture is missing. That is grey, unlike a covered zero.
 *
 * `observedAt` is the workload evidence timestamp, never the time an HTTP request completed.
 * Archive and edge sources show captured windows, not a promise to refresh or a reading of now.
 */
export function describeTrafficWindow(
  families: readonly DatabaseCityQueryFamily[],
  observedAt: string | null,
  refreshIntervalMs: number,
  sourceMode: 'live' | 'archive' | 'edge' = 'live',
): TrafficWindowDisclosure {
  const staticSource = sourceMode !== 'live'
  const basis = trafficBasis(families)
  const { published, covered, windowMinutes } = recentRoadDelay(families, basis)
  const coverage = trafficCoverageNote(families, basis, !staticSource)

  const seconds = Math.max(1, Math.round(refreshIntervalMs / 1000))
  const observation = observedAt !== null && Number.isFinite(Date.parse(observedAt))
    ? `Workload observed at ${new Date(observedAt).toLocaleString()}.`
    : 'Workload observation time unknown.'
  const cadence = staticSource
    ? `This ${sourceMode} snapshot does not refresh automatically. ${observation}`
    : `The city checks for updates every ${seconds} seconds; polling is not a measurement timestamp. ${observation}`
  const period = staticSource
    ? windowMinutes === null ? 'the captured window' : `the captured ${windowMinutes}-minute window`
    : windowMinutes === null ? 'the recent window' : `the last ${windowMinutes} minutes`
  const windowEnd = staticSource && basis.window
    ? ` The captured window ends at ${new Date(basis.window.windowEnd).toLocaleString()}, not at the current time.`
    : ''

  if (!published) {
    return {
      headline: 'Road colour is the whole retained history.',
      detail: 'This page published no recent-activity window, so the colours are cumulative totals '
        + `over everything Query Store still retains rather than a reading of current traffic. ${cadence}`,
      windowMinutes: null,
      covered: false,
    }
  }

  if (!covered) {
    return {
      headline: `Query Store captured nothing usable in ${period}.`,
      detail: `Traffic in this window is unmeasured, not clear.${staticSource ? '' : ' Live blocking can still override it.'} ${coverage} ${cadence}${windowEnd}`,
      windowMinutes,
      covered: false,
    }
  }

  return {
    headline: `Road colour is wait per execution over ${period}.`,
    detail: 'Query Store buckets its runtime statistics into intervals, so a bucket overlapping the '
      + 'window is counted whole rather than pro-rated -- it never said how the work was spread '
      + 'inside it. Missing or partial coverage stays unknown, not green. Street placement requires '
      + `a recent plan/runtime-weighted wait split; absent splits stay unplaced, never rescaled from history. ${coverage} ${cadence}${windowEnd}`,
    windowMinutes,
    covered: true,
  }
}
