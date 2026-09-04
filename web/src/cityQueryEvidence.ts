import type { PlanChoice } from './cityPlanSearch'
import { evidenceStatus, type CitySourceMode } from './cityEvidence'
import type { DatabaseCityQueryFamily } from './databaseCityContracts'
import { familyTrafficMeasurement, trafficBasis } from './cityTrafficWindow'

export const CONTRIBUTOR_PAGE_SIZE = 8
export function roadContributors(ids: readonly string[], families: readonly DatabaseCityQueryFamily[], count: number) {
  const byId = new Map(families.map(family => [family.familyId, family]))
  return {
    items: ids.slice(0, count).map(id => ({ id, family: byId.get(id) ?? null })),
    remaining: Math.max(0, ids.length - count),
  }
}

export function exactCount(value: string | null | undefined): string {
  return value != null && /^\d+$/.test(value) ? BigInt(value).toLocaleString() : 'Unavailable'
}
export function observationTime(value: string | null | undefined): string {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Unknown'
}

export function queryRouteEvidence(choice: PlanChoice, now: number, mode: CitySourceMode) {
  const family = choice.family
  const city = choice.cityFamily
  const recent = city?.recentActivity
  const basis = choice.trafficBasis ?? trafficBasis(city ? [city] : [])
  const sample = city ? familyTrafficMeasurement(city, basis) : null
  const evidence = city?.evidence ?? family?.evidence
  const staticSource = mode !== 'live' || evidence?.source === 'Fixture' || evidence?.source === 'ImportedArchive'
  return {
    executions: sample ? sample.executions?.toString() ?? null : basis.kind === 'retained' ? family?.executionCount ?? null : null,
    waits: sample ? sample.waitMilliseconds?.toString() ?? null : basis.kind === 'retained' ? family?.totalWaitMilliseconds ?? null : null,
    window: basis.kind === 'recent'
      ? `${observationTime(basis.window?.windowStart)} - ${observationTime(basis.window?.windowEnd)} (${basis.window?.windowMinutes ?? 'unknown'} minute window; overlapping intervals counted whole)`
      : family ? `Retained history: ${observationTime(family.firstObservedAt)} - ${observationTime(family.lastObservedAt)}` : 'Family window not yet located',
    observed: observationTime(evidence?.observedAt),
    source: mode === 'edge' ? `Edge sample / ${evidence?.source ?? 'unknown'}` : evidence?.source ?? 'Not located',
    status: evidence ? evidenceStatus(evidence, now, staticSource) : 'Unknown',
    coverage: basis.kind === 'recent'
      ? sample?.covered ? recent?.rationale ?? 'Captured window' : 'Runtime or wait capture is missing for this window. Unavailable is not zero.'
      : family?.evidence.caveat ?? 'Continue the bounded plan search to locate the family and its measurements.',
    confidence: city?.confidence ?? 'Unknown',
    rationale: city?.rationale ?? 'No object-attribution confidence accompanied this lookup.',
    attribution: sample?.attribution,
    staticSource,
  }
}
