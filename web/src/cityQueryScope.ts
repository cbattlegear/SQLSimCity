import type { DatabaseCityPage } from './databaseCityContracts'
import type { CitySourceMode } from './cityEvidence'

export interface PlanScopePolicy {
  directPlanIds: boolean
  reason: string | null
}
export interface CityQueryScope extends PlanScopePolicy {
  databaseId: string | null
}
export function cityQueryScope(page: Pick<DatabaseCityPage, 'databaseId' | 'queryStoreDatabaseId' | 'evidence'> | null, mode: CitySourceMode): CityQueryScope {
  if (!page) return { databaseId: null, directPlanIds: false, reason: 'Read the city before locating query plans.' }
  const captured = mode !== 'live' || page.evidence.source === 'Fixture' || page.evidence.source === 'ImportedArchive'
  const mapping = page.queryStoreDatabaseId
  if (typeof mapping === 'string' && mapping.trim().length > 0) {
    return { databaseId: mapping, directPlanIds: !captured, reason: null }
  }
  if (mapping === undefined && captured) return { databaseId: page.databaseId, directPlanIds: false, reason: null }
  return {
    databaseId: null,
    directPlanIds: false,
    reason: mapping === undefined
      ? 'This backend did not publish a verified Query Store namespace for this city. Update the backend to search plans safely.'
      : 'The source cannot prove a unique Query Store namespace for this city. Plan lookup is unavailable; no database name is guessed.',
  }
}
