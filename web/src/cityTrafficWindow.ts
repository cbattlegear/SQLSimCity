import type {
  DatabaseCityQueryFamily,
  DatabaseCityRecentActivity,
  DatabaseCityWaitAttribution,
} from './databaseCityContracts'

export interface TrafficWindow {
  readonly windowMinutes: number
  readonly windowStart: string
  readonly windowEnd: string
}

/** Choose once for the whole city, before filtering by a road, building or facility. */
export interface TrafficBasis {
  readonly kind: 'recent' | 'retained'
  readonly window: TrafficWindow | null
}

export interface FamilyTrafficMeasurement {
  readonly executions: bigint | null
  readonly waitMilliseconds: bigint | null
  readonly durationMicroseconds: bigint | null
  /** Both runtime and wait measurements are usable, unlike the backend's runtime-only `covered`. */
  readonly covered: boolean
  readonly quiet: boolean
  readonly attribution: DatabaseCityWaitAttribution | null
  readonly categories: Readonly<Record<string, string>> | null
}

export function trafficInteger(value: string | null | undefined): bigint | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null
  return BigInt(value.trim())
}

function validWindow(window: TrafficWindow): boolean {
  return Number.isFinite(window.windowMinutes) && window.windowMinutes > 0
    && Number.isFinite(Date.parse(window.windowStart))
    && Date.parse(window.windowEnd) > Date.parse(window.windowStart)
}

export function sameTrafficWindow(left: TrafficWindow, right: TrafficWindow): boolean {
  return validWindow(left) && validWindow(right)
    && left.windowMinutes === right.windowMinutes
    && Date.parse(left.windowStart) === Date.parse(right.windowStart)
    && Date.parse(left.windowEnd) === Date.parse(right.windowEnd)
}

export function trafficBasis(families: readonly DatabaseCityQueryFamily[]): TrafficBasis {
  const published = families.flatMap(family => family.recentActivity ? [family.recentActivity] : [])
  if (published.length === 0) return { kind: 'retained', window: null }
  // A paged refresh can straddle two snapshots. Use the newest complete window, never their union.
  const windows = published.filter(validWindow).sort((a, b) =>
    Date.parse(b.windowEnd) - Date.parse(a.windowEnd)
    || Date.parse(b.windowStart) - Date.parse(a.windowStart)
    || a.windowMinutes - b.windowMinutes)
  const window = windows[0]
  return {
    kind: 'recent',
    window: window ? {
      windowMinutes: window.windowMinutes,
      windowStart: new Date(window.windowStart).toISOString(),
      windowEnd: new Date(window.windowEnd).toISOString(),
    } : null,
  }
}

export function validWaitAttribution(
  attribution: DatabaseCityWaitAttribution | null | undefined,
  total: bigint | null,
): DatabaseCityWaitAttribution | null {
  if (!attribution || total === null) return null
  const remainder = trafficInteger(attribution.unattributedWaitMilliseconds)
  if (remainder === null) return null
  let sum = remainder
  for (const entry of attribution.objects) {
    const value = trafficInteger(entry.waitMilliseconds)
    if (value === null || !Number.isFinite(entry.estimatedCostShare)
      || entry.estimatedCostShare < 0 || entry.estimatedCostShare > 1) return null
    sum += value
  }
  return sum === total ? attribution : null
}

function capturedCategories(
  categories: Readonly<Record<string, string>> | null | undefined,
  total: bigint | null,
): boolean {
  if (!categories || total === null) return false
  let sum = 0n
  for (const value of Object.values(categories)) {
    const milliseconds = trafficInteger(value)
    if (milliseconds === null) return false
    sum += milliseconds
  }
  return sum === total
}

export function familyTrafficMeasurement(
  family: DatabaseCityQueryFamily,
  basis: TrafficBasis = trafficBasis([family]),
): FamilyTrafficMeasurement {
  const recent = family.recentActivity
  const source: DatabaseCityQueryFamily | DatabaseCityRecentActivity | null = basis.kind === 'retained'
    ? family
    : recent && basis.window && sameTrafficWindow(recent, basis.window) && recent.covered ? recent : null
  const executions = trafficInteger(source?.executionCount)
  const reportedWait = trafficInteger(source?.totalWaitMilliseconds)
  const allocation = validWaitAttribution(source?.waitAttribution, reportedWait)
  // Recent `covered` describes runtime buckets only. Missing wait capture publishes null metadata
  // and can still report a zero total; that zero is not a measurement. Older optional payloads need
  // at least one reconciling wait record before a total is usable, never just runtime coverage.
  const waitsCaptured = basis.kind === 'retained'
    || (source !== null && source.waitAttribution !== null && source.waitMillisecondsByCategory !== null
      && (allocation !== null || capturedCategories(source.waitMillisecondsByCategory, reportedWait)))
  const waitMilliseconds = waitsCaptured ? reportedWait : null
  return {
    executions,
    waitMilliseconds,
    durationMicroseconds: trafficInteger(source?.totalDurationMicroseconds),
    covered: executions !== null && waitMilliseconds !== null,
    quiet: basis.kind === 'recent' && executions === 0n && waitMilliseconds === 0n,
    attribution: waitsCaptured ? allocation : null,
    categories: source?.waitMillisecondsByCategory ?? null,
  }
}

export function trafficDelay(executions: bigint | null, waits: bigint | null, quiet = false): number | null {
  if (executions === null || waits === null) return null
  if (executions === 0n) return quiet && waits === 0n ? 0 : null
  const delay = Number(waits) / Number(executions)
  return Number.isFinite(delay) ? delay : null
}

export function trafficBasisLabel(basis: TrafficBasis, relative = true): string {
  return basis.kind === 'retained'
    ? 'Retained history (no recent window published)'
    : basis.window
      ? relative ? `Recent window: last ${basis.window.windowMinutes} minutes` : `Captured ${basis.window.windowMinutes}-minute window`
      : 'Recent window (invalid bounds)'
}

export function trafficCoverageNote(
  families: readonly DatabaseCityQueryFamily[],
  basis: TrafficBasis,
  relative = true,
): string {
  const covered = families.filter(family => familyTrafficMeasurement(family, basis).covered).length
  return `${trafficBasisLabel(basis, relative)}. ${covered} of ${families.length} families have valid runtime and wait capture.`
    + (covered < families.length
      ? ' Partial or missing capture: unknown contributors are not zero and cannot make a road clear.'
      : '')
}
