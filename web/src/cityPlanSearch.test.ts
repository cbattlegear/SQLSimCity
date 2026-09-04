import { describe, expect, it, vi } from 'vitest'
import type { NormalizedShowplan, QueryFamilyDetail, QueryFamilyPage } from './contracts'
import { CityPlanSearch, type PlanFetchers, scopedPlanId } from './cityPlanSearch'
import { CityPlanNavigation } from './cityPlanNavigation'
import { QueryStoreRequestError } from './api'
import type { DatabaseCityQueryFamily } from './databaseCityContracts'

function detail(id = 'family', databaseId = 'db', planId = `${databaseId}:123`): QueryFamilyDetail {
  return {
    schemaVersion: '1.0', runtime: [],
    family: {
      familyId: id, databaseId, queryHash: 'ABC', text: { availability: 'Available', normalizedText: 'SELECT * FROM Orders', reason: 'Captured' },
      normalizedTextFingerprint: null, physicalQueries: [], executionCount: '9007199254740993',
      totalCpuMicroseconds: '1', totalDurationMicroseconds: '100', totalLogicalReads8KiBPages: '1', totalWaitMilliseconds: '10',
      firstObservedAt: '2026-01-01T00:00:00Z', lastObservedAt: '2026-01-01T00:01:00Z',
      evidence: { source: 'QueryStore', status: 'Available', observedAt: '2026-01-01T00:01:00Z', freshUntil: null, reason: 'Captured', caveat: 'Query totals, not operator time' },
    },
    plans: [{ planId, planType: 'Compiled', optimization: 'None', dispatcherPlanId: null, runtimeCounted: true, isForced: false, forceFailureCount: '0', lastForceFailureReason: null, lastExecutionAt: '2026-01-01T00:01:00Z' }],
  }
}
function showplan(planId: string): NormalizedShowplan {
  return { planId, nodes: [], showplanVersion: '1', cardinalityEstimatorVersion: null, serialDesiredMemoryKiB: null, serialRequiredMemoryKiB: null, optimization: 'None', dispatcherExpression: null, structuralFingerprint: 'x', runtimeOverlayCaveat: 'Compiled, not actual operator time' }
}
function page(items: QueryFamilyDetail[], token: string | null = null): QueryFamilyPage {
  return { schemaVersion: '1.0', items: items.map(item => item.family), nextPageToken: token, pageSize: 100, totalCount: null, evidence: null }
}
function api(overrides: Partial<PlanFetchers> = {}): PlanFetchers {
  return { fetchFamilies: vi.fn(async () => page([detail()])), fetchFamily: vi.fn(async () => detail()), fetchPlan: vi.fn(async id => showplan(id)), ...overrides }
}

describe('bounded city plan search', () => {
  it('looks up plan ID independently of family text/hash/id and scopes equal raw IDs', async () => {
    for (const db of ['db', 'neighbor']) {
      const fetchers = api({ fetchFamilies: vi.fn(async () => page([])) })
      const finder = new CityPlanSearch(db, 'cpu', fetchers)
      await finder.search('123', 'plan')
      expect(fetchers.fetchPlan).toHaveBeenCalledWith(`${db}:123`, expect.any(AbortSignal))
      expect(finder.getSnapshot().choices[0]?.planId).toBe(`${db}:123`)
    }
    expect(scopedPlanId('db', 'neighbor:123')).toBe('neighbor:123')
  })
  it.each(['Fixture', 'ImportedArchive', 'QueryStore'] as const)('finds opaque %s plans only after verifying database membership without text prefilter', async source => {
    const d = detail('opaque-family', 'db', 'opaque-plan')
    d.family.evidence.source = source
    const finder = new CityPlanSearch('db', 'cpu', api({ fetchFamilies: async () => page([d]), fetchFamily: async () => d }))
    await finder.search('opaque-plan', 'plan')
    expect(finder.getSnapshot().choices[0]?.familyId).toBe('opaque-family')
    expect(finder.getSnapshot().choices[0]?.text).toContain('Orders')
  })
  it('does not expose an opaque foreign plan from a successful raw fetch', async () => {
    const finder = new CityPlanSearch('db', 'cpu', api({ fetchFamilies: async () => page([]) }))
    await finder.search('other-plan', 'plan')
    expect(finder.getSnapshot().choices).toEqual([])
  })
  it('does not qualify or expose captured numeric IDs without membership', async () => {
    const fetchers = api({ fetchFamilies: async () => page([]) })
    const finder = new CityPlanSearch('db', 'cpu', fetchers, { directPlanIds: false, reason: null })
    await finder.search('123', 'plan')
    expect(fetchers.fetchPlan).toHaveBeenCalledWith('123', expect.any(AbortSignal))
    expect(finder.getSnapshot().choices).toEqual([])
  })
  it('never requests an unproven database namespace', async () => {
    const fetchers = api()
    const finder = new CityPlanSearch(null, 'cpu', fetchers, { directPlanIds: false, reason: 'Ambiguous source' })
    await finder.search('123', 'plan')
    expect(fetchers.fetchPlan).not.toHaveBeenCalled()
    expect(fetchers.fetchFamilies).not.toHaveBeenCalled()
    expect(finder.getSnapshot()).toMatchObject({ status: 'error', error: 'Ambiguous source' })
  })
  it('continues beyond page one and eight matching families without claiming exhaustion', async () => {
    const all = Array.from({ length: 10 }, (_, index) => detail(`f${index}`, 'db', `db:${index}`))
    const fetchers = api({ fetchFamilies: vi.fn().mockResolvedValueOnce(page(all, 'page2')).mockResolvedValueOnce(page([detail('last', 'db', 'db:999')])), fetchFamily: async id => all.find(item => item.family.familyId === id) ?? detail('last', 'db', 'db:999') })
    const finder = new CityPlanSearch('db', 'cpu', fetchers)
    await finder.search('', 'family')
    expect(finder.getSnapshot()).toMatchObject({ status: 'partial', searched: 8, canContinue: true })
    await finder.more()
    expect(finder.getSnapshot().searched).toBe(10)
    await finder.more()
    expect(finder.getSnapshot()).toMatchObject({ status: 'exhausted', searched: 11, canContinue: false })
    expect(finder.getSnapshot().choices.at(-1)?.planId).toBe('db:999')
    expect(fetchers.fetchFamilies).toHaveBeenLastCalledWith('cpu', 'page2', expect.any(AbortSignal), 'db')
  })
  it('distinguishes exhausted empty, incomplete family failures, and failed requests', async () => {
    const empty = new CityPlanSearch('db', 'cpu', api({ fetchFamilies: async () => page([]) }))
    await empty.search('missing', 'family')
    expect(empty.getSnapshot().status).toBe('exhausted')
    const partial = new CityPlanSearch('db', 'cpu', api({ fetchFamily: async () => { throw new Error('retired') } }))
    await partial.search('', 'family')
    expect(partial.getSnapshot()).toMatchObject({ status: 'partial', canContinue: false, failures: ['family: retired'] })
    const unavailable = new CityPlanSearch('db', 'cpu', api({ fetchPlan: async () => { throw new QueryStoreRequestError(422, 'Plan is too large') } }))
    await unavailable.search('123', 'plan')
    expect(unavailable.getSnapshot()).toMatchObject({ status: 'error', error: 'Plan is too large' })
  })
  it('discards superseded searches even if the fetch ignores abort', async () => {
    let resolve!: (page: QueryFamilyPage) => void
    const fetchFamilies = vi.fn().mockReturnValueOnce(new Promise<QueryFamilyPage>(done => { resolve = done })).mockResolvedValueOnce(page([]))
    const finder = new CityPlanSearch('db', 'cpu', api({ fetchFamilies }))
    const old = finder.search('', 'family')
    await finder.search('new', 'family')
    resolve(page([detail()]))
    await old
    expect(finder.getSnapshot()).toMatchObject({ status: 'exhausted', choices: [], searched: 0 })
  })
})

describe('city plan navigation ownership', () => {
  const family: DatabaseCityQueryFamily = {
    familyId: 'family', queryHash: 'ABC', executionCount: '20', totalCpuMicroseconds: '1',
    totalDurationMicroseconds: '2', totalLogicalReads8KiBPages: '3', totalWaitMilliseconds: '4',
    waitMillisecondsByCategory: {}, objectIds: ['a', 'b'], confidence: 'Probable', rationale: 'Two objects',
    evidence: { source: 'QueryStoreAggregate', status: 'Available', observedAt: null, freshUntil: null, reason: 'Captured' },
  }
  it('selects the shared query address immediately and retains SQL/context alongside the compiled route', async () => {
    const owner = new CityPlanNavigation('db', api())
    owner.selectAddress('facility:cpu')
    const open = owner.openFamily(family)
    expect(owner.getSnapshot()).toMatchObject({ selectedAddressId: 'query:family', mappingFamilyId: 'family', loading: true })
    await open
    expect(owner.getSnapshot().activePlan?.choice).toMatchObject({ text: 'SELECT * FROM Orders', cityFamily: family, executionCount: '9007199254740993' })
  })
  it('keeps retired families selected and visibly explains a missing plan', async () => {
    const owner = new CityPlanNavigation('db', api({ fetchFamily: async () => ({ ...detail(), plans: [] }) }))
    await owner.openFamily(family)
    expect(owner.getSnapshot()).toMatchObject({ selectedAddressId: 'query:family', activePlan: null, loading: false })
    expect(owner.getSnapshot().error).toContain('no compiled plan')
  })
  it('rejects a family from a neighboring database', async () => {
    const owner = new CityPlanNavigation('db', api({ fetchFamily: async () => detail('family', 'neighbor') }))
    await owner.openFamily(family)
    expect(owner.getSnapshot().activePlan).toBeNull()
    expect(owner.getSnapshot().error).toContain('another database')
  })
  it('rejects an unproven namespace before reading family evidence', async () => {
    const fetchers = api()
    const owner = new CityPlanNavigation(null, fetchers, { directPlanIds: false, reason: 'Ambiguous source' })
    await owner.openFamily(family)
    expect(fetchers.fetchFamily).not.toHaveBeenCalled()
    expect(owner.getSnapshot().error).toBe('Ambiguous source')
  })
  it('does not trust a captured numeric-looking prefix as database membership', async () => {
    const owner = new CityPlanNavigation('db', api(), { directPlanIds: false, reason: null })
    await owner.openPlan({ planId: 'db:123', familyId: null, queryHash: null, text: null, textReason: 'unknown', executionCount: null, family: null })
    expect(owner.getSnapshot().activePlan).toBeNull()
    expect(owner.getSnapshot().error).toContain('not been located')
  })
  it('does not reopen a cleared route when a pending read completes', async () => {
    let resolve!: (value: NormalizedShowplan) => void
    const fetchPlan = vi.fn(() => new Promise<NormalizedShowplan>(done => { resolve = done }))
    const owner = new CityPlanNavigation('db', api({ fetchPlan }))
    const focus = vi.fn()
    const open = owner.openPlan({ planId: 'db:123', familyId: null, queryHash: null, text: null, textReason: 'unknown', executionCount: null, family: null }, focus)
    await Promise.resolve()
    owner.clear()
    resolve(showplan('db:123'))
    await open
    expect(owner.getSnapshot()).toMatchObject({ activePlan: null, loading: false })
    expect(focus).toHaveBeenCalledOnce()
  })
})
