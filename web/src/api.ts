import type { ArchiveInfo, AtlasSnapshot, DeploymentNotice, EdgeSourceInfo, NormalizedShowplan, PlanComparison, QueryFamilyDetail, QueryFamilyPage, QueryStoreCollectorStatus } from './contracts'
import type { LiveIncidentResponse } from './liveContracts'
import type { DatabaseCityPage, DatabaseCitySummarySnapshot } from './databaseCityContracts'
import { assertAtlasSnapshot } from './atlas'
import { assertLiveIncidentResponse } from './liveIncidents'

export async function fetchAtlas(signal?: AbortSignal): Promise<AtlasSnapshot> {
  const response = await fetch('/api/v1/atlas', {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
    signal,
  })
  if (!response.ok) throw new Error(`Atlas request failed with status ${response.status}`)
  return assertAtlasSnapshot(await response.json())
}

export async function fetchArchiveInfo(signal?: AbortSignal): Promise<ArchiveInfo | null> {
  const response = await fetch('/api/v1/archive', {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
    signal,
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Archive info request failed with status ${response.status}`)
  return response.json() as Promise<ArchiveInfo>
}

export async function fetchEdgeSourceInfo(signal?: AbortSignal): Promise<EdgeSourceInfo | null> {
  const response = await fetch('/api/v1/edge/source', {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
    signal,
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Edge source request failed with status ${response.status}`)
  return response.json() as Promise<EdgeSourceInfo>
}

/**
 * Reads the deployment notice setting. This never rejects: if the endpoint is
 * unreachable or malformed we report "not acknowledged", so a transport problem
 * can only ever make the security notice appear, never make it disappear.
 */
export async function fetchDeploymentNotice(signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch('/api/v1/deployment', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      signal,
    })
    if (!response.ok) return false
    const body = await response.json() as Partial<DeploymentNotice>
    return body.securityNoticeAcknowledged === true
  } catch {
    return false
  }
}

export async function fetchLiveIncidents(signal?: AbortSignal): Promise<LiveIncidentResponse> {
  const response = await fetch('/api/v1/live', {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
    signal,
  })
  if (!response.ok) throw new Error(`Live incident request failed with status ${response.status}`)
  return assertLiveIncidentResponse(await response.json())
}

async function fetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { headers: { Accept: 'application/json' }, credentials: 'same-origin', signal })
  if (!response.ok) throw new Error(`Query Store request failed with status ${response.status}`)
  return response.json() as Promise<T>
}

export const fetchQueryFamilies = (metric: string, pageToken?: string | null, signal?: AbortSignal) =>
  fetchJson<QueryFamilyPage>(
    `/api/v1/query-store/queries?metric=${encodeURIComponent(metric)}&pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
    signal,
  )

export const fetchQueryFamily = (familyId: string, signal?: AbortSignal) =>
  fetchJson<QueryFamilyDetail>(`/api/v1/query-store/queries/${encodeURIComponent(familyId)}`, signal)

export const fetchPlan = (planId: string, signal?: AbortSignal) =>
  fetchJson<NormalizedShowplan>(`/api/v1/query-store/plans/${encodeURIComponent(planId)}`, signal)

export const fetchPlanComparison = (left: string, right: string, signal?: AbortSignal) =>
  fetchJson<PlanComparison>(
    `/api/v1/query-store/plans/compare?leftPlanId=${encodeURIComponent(left)}&rightPlanId=${encodeURIComponent(right)}`,
    signal,
  )

export const fetchQueryStoreStatus = (signal?: AbortSignal) =>
  fetchJson<QueryStoreCollectorStatus>('/api/v1/query-store/status', signal)

export const fetchDatabaseCitySummaries = (signal?: AbortSignal) =>
  fetchJson<DatabaseCitySummarySnapshot>('/api/v1/database-city', signal)

/**
 * Objects requested per city page.
 *
 * The API refuses anything above 50 — object inventory is a bounded probe, and the ceiling is the
 * server's promise about how much work one request can ask a live instance for. Sitting on that
 * ceiling is what keeps the number of round trips needed to load a whole city down.
 */
export const CITY_PAGE_SIZE = 50

export const fetchDatabaseCity = (
  databaseId: string,
  metric: string,
  pageToken?: string | null,
  signal?: AbortSignal,
) => fetchJson<DatabaseCityPage>(
  `/api/v1/database-city/${encodeURIComponent(databaseId)}?metric=${encodeURIComponent(metric)}&pageSize=${CITY_PAGE_SIZE}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
  signal,
)
