import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CityRouteEvidence } from './CityRouteEvidence'
import { exactCount, queryRouteEvidence, roadContributors } from './cityQueryEvidence'
import type { PlanChoice } from './cityPlanSearch'
import type { DatabaseCityQueryFamily } from './databaseCityContracts'

const city: DatabaseCityQueryFamily = {
  familyId: 'f', queryHash: 'h', executionCount: '9007199254740993', totalCpuMicroseconds: '1',
  totalDurationMicroseconds: '1', totalLogicalReads8KiBPages: '1', totalWaitMilliseconds: '9999',
  waitMillisecondsByCategory: {}, objectIds: ['a', 'b'], confidence: 'Probable', rationale: 'Joined objects',
  evidence: { source: 'QueryStoreAggregate', status: 'Available', observedAt: '2026-01-01T00:00:00Z', freshUntil: '2026-01-01T00:01:00Z', reason: 'Captured' },
  recentActivity: { windowMinutes: 15, windowStart: '2026-01-01T00:00:00Z', windowEnd: '2026-01-01T00:15:00Z', covered: true, executionCount: '0', totalDurationMicroseconds: '0', totalWaitMilliseconds: '0', waitMillisecondsByCategory: {}, rationale: 'Measured zero' },
}
const choice: PlanChoice = { planId: 'db:1', familyId: 'f', queryHash: 'h', text: 'SELECT * FROM a', textReason: 'Captured', executionCount: '9007199254740993', family: null, cityFamily: city }
describe('route evidence and contributors', () => {
  it('keeps zero, missing coverage, and absent family context distinct', () => {
    expect(queryRouteEvidence(choice, 0, 'live')).toMatchObject({ executions: '0', waits: '0' })
    const missing = { ...choice, cityFamily: { ...city, recentActivity: { ...city.recentActivity!, covered: false } } }
    expect(queryRouteEvidence(missing, 0, 'live')).toMatchObject({ executions: null, waits: null })
    expect(queryRouteEvidence({ ...choice, cityFamily: undefined }, 0, 'live').window).toBe('Family window not yet located')
  })
  it('dates evidence from observation and ages live but not static sources', () => {
    const now = Date.parse('2026-09-01T00:00:00Z')
    expect(queryRouteEvidence(choice, now, 'live').status).toBe('Stale')
    expect(queryRouteEvidence(choice, now, 'archive').status).toBe('Available')
    expect(queryRouteEvidence(choice, now, 'edge').source).toContain('Edge sample')
  })
  it('preserves exact totals beyond safe integer range', () => {
    expect(exactCount('9007199254740993').replace(/\D/g, '')).toBe('9007199254740993')
    expect(exactCount(null)).toBe('Unavailable')
  })
  it('does not turn runtime-only coverage into measured zero waits', () => {
    const missingWaits = { ...choice, cityFamily: { ...city, recentActivity: { ...city.recentActivity!, waitMillisecondsByCategory: null, waitAttribution: null } } }
    expect(queryRouteEvidence(missingWaits, 0, 'live')).toMatchObject({ executions: '0', waits: null })
  })
  it('bounds selectable contributors without losing retired entries or continuation', () => {
    const result = roadContributors(['f', 'retired', 'later'], [city], 2)
    expect(result.items).toEqual([{ id: 'f', family: city }, { id: 'retired', family: null }])
    expect(result.remaining).toBe(1)
  })
  it('never falls back to retained totals under a recent-window label', () => {
    const outside = { ...choice, cityFamily: undefined, trafficBasis: { kind: 'recent' as const, window: city.recentActivity! } }
    expect(queryRouteEvidence(outside, 0, 'live')).toMatchObject({ executions: null, waits: null })
  })
  it('renders SQL, observation and confidence beside an explicit estimates disclaimer', () => {
    const markup = renderToStaticMarkup(createElement(CityRouteEvidence, { choice, now: Date.parse('2026-09-01'), sourceMode: 'live' }))
    expect(markup).toContain('SELECT * FROM a')
    expect(markup).toContain('Stale')
    expect(markup).toContain('Observed')
    expect(markup).toContain('Probable')
    expect(markup).toContain('never actual operator time')
    expect(markup).toContain('No per-object wait allocation')
  })
  it('retains long SQL safely without opening an enormous disclosure by default', () => {
    const longSql = 'SELECT a FROM t WHERE a < 2; '.repeat(200)
    const markup = renderToStaticMarkup(createElement(CityRouteEvidence, { choice: { ...choice, text: longSql }, now: 0, sourceMode: 'archive' }))
    expect(markup).toContain(longSql.replaceAll('<', '&lt;'))
    expect(markup).toContain('<details class="route-sql">')
    expect(markup).toContain('static captured evidence')
  })
  it.each(['archive', 'edge'] as const)('renders missing SQL and measurements honestly in %s mode', sourceMode => {
    const markup = renderToStaticMarkup(createElement(CityRouteEvidence, {
      choice: { ...choice, cityFamily: undefined, text: null, textReason: 'Not retained by source' },
      now: 0, sourceMode,
    }))
    expect(markup).toContain('SQL text unavailable')
    expect(markup).toContain('Not retained by source')
    expect(markup).toContain('Unavailable')
    expect(markup).toContain('static captured evidence')
  })
})
