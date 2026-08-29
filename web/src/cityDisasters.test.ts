import { describe, expect, it } from 'vitest'
import type { IncidentProjection } from './cityIncidents'
import type { CityRoute } from './cityRoute'
import { DEFAULT_STATS_STALE_DAYS, projectCityDisasters, statsStaleDaysFromSearch } from './cityDisasters'

function incidents(overrides: Partial<IncidentProjection> = {}): IncidentProjection {
  return {
    markers: [],
    offPageCount: 0,
    unresolved: [],
    probeReported: true,
    deadlocks: {
      observed: true,
      graphCount: 0,
      retainedCount: 0,
      pinnedCount: 0,
      reason: 'ok',
    },
    reason: 'ok',
    ...overrides,
  }
}

function route(overrides: Partial<CityRoute> = {}): CityRoute {
  return {
    planId: 'plan:1',
    stops: [],
    polyline: [],
    offMapStops: [],
    unplacedOperations: [],
    estimatedCostUnattributed: 0,
    runtimeOverlayCaveat: 'compiled only',
    ...overrides,
  }
}

describe('statsStaleDaysFromSearch', () => {
  it('defaults to one week', () => {
    expect(statsStaleDaysFromSearch('')).toBe(DEFAULT_STATS_STALE_DAYS)
  })

  it('accepts a positive override', () => {
    expect(statsStaleDaysFromSearch('?statsStaleDays=14')).toBe(14)
  })

  it('rejects zero and non-numeric values', () => {
    expect(statsStaleDaysFromSearch('?statsStaleDays=0')).toBe(DEFAULT_STATS_STALE_DAYS)
    expect(statsStaleDaysFromSearch('?statsStaleDays=abc')).toBe(DEFAULT_STATS_STALE_DAYS)
  })
})

describe('projectCityDisasters', () => {
  it('maps retained deadlocks to car crashes', () => {
    const projection = projectCityDisasters({
      incidents: incidents({ deadlocks: { observed: true, graphCount: 2, retainedCount: 2, pinnedCount: 1, reason: 'ok' } }),
      route: null,
      queryStoreObservedAt: null,
      search: '',
      now: Date.parse('2026-01-10T00:00:00Z'),
    })

    expect(projection.items.find(item => item.key === 'car-crash')?.headline).toContain('2 car crash')
  })

  it('maps degraded route warnings to a water-main break signal', () => {
    const projection = projectCityDisasters({
      incidents: incidents(),
      route: route({
        stops: [
          {
            ordinal: 1,
            kind: 'building',
            label: 'dbo.Customer',
            objectId: 'o1',
            indexNames: [],
            x: 1,
            z: 1,
            operations: [],
            estimatedCostShare: 0.5,
            instruction: 'x',
            unresolvedReason: null,
            warnings: ['SpillToTempDb: level 2'],
          },
        ],
      }),
      queryStoreObservedAt: null,
      search: '',
      now: Date.parse('2026-01-10T00:00:00Z'),
    })

    expect(projection.items.some(item => item.key === 'water-main-break')).toBe(true)
  })

  it('maps high-share missing-index warnings to building fires', () => {
    const projection = projectCityDisasters({
      incidents: incidents(),
      route: route({
        stops: [
          {
            ordinal: 1,
            kind: 'building',
            label: 'dbo.Customer',
            objectId: 'o1',
            indexNames: [],
            x: 1,
            z: 1,
            operations: [],
            estimatedCostShare: 0.31,
            instruction: 'x',
            unresolvedReason: null,
            warnings: ['MissingIndexGroup'],
          },
        ],
      }),
      queryStoreObservedAt: null,
      search: '',
      now: Date.parse('2026-01-10T00:00:00Z'),
    })

    expect(projection.items.some(item => item.key === 'building-fire')).toBe(true)
  })

  it('marks stale query-store evidence as run-down using the configured threshold', () => {
    const projection = projectCityDisasters({
      incidents: incidents(),
      route: null,
      queryStoreObservedAt: '2026-01-01T00:00:00Z',
      search: '?statsStaleDays=7',
      now: Date.parse('2026-01-10T00:00:00Z'),
    })

    expect(projection.items.some(item => item.key === 'stats-decay')).toBe(true)
  })
})
