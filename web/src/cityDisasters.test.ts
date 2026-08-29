import { describe, expect, it } from 'vitest'
import type { DatabaseCityObject } from './databaseCityContracts'
import type { IncidentProjection } from './cityIncidents'
import type { CityRoute, RouteStop } from './cityRoute'
import {
  DEFAULT_STATS_STALE_DAYS,
  LARGE_MISSING_INDEX_IMPACT_PERCENT,
  projectCityDisasters,
  statsStaleDaysFromSearch,
} from './cityDisasters'

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
    missingIndexes: [],
    missingIndexesObserved: true,
    ...overrides,
  }
}

function stop(overrides: Partial<RouteStop> = {}): RouteStop {
  return {
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
    warnings: [],
    ...overrides,
  }
}

const EVIDENCE = {
  source: 'NotProbed',
  status: 'Unknown',
  observedAt: null,
  freshUntil: null,
  reason: 'n/a',
} as const

function cityObject(overrides: Partial<DatabaseCityObject> = {}): DatabaseCityObject {
  return {
    objectId: 'o1',
    schemaId: 's1',
    schemaName: 'dbo',
    name: 'Customer',
    kind: 'Table',
    reservedPages8KiB: '10',
    usedPages8KiB: '10',
    reservedBytes: '81920',
    usedBytes: '81920',
    sizeStatus: 'Known',
    sizeReason: null,
    layout: { neighborhoodOrdinal: 0, objectOrdinal: 0, x: 0, z: 0 },
    indexes: [],
    directActivity: { totalOperations: null, resetEpochToken: null, evidence: EVIDENCE },
    attributedExposure: {
      executionCount: null,
      totalCpuMicroseconds: null,
      totalDurationMicroseconds: null,
      totalLogicalReads8KiBPages: null,
      confidence: 'Unknown',
      rationale: 'n/a',
      evidence: EVIDENCE,
    },
    ...overrides,
  }
}

function statistics(
  overrides: Partial<NonNullable<DatabaseCityObject['statistics']>> = {},
): DatabaseCityObject['statistics'] {
  return {
    oldestLastUpdated: '2026-01-01T00:00:00Z',
    statisticsCount: 3,
    neverUpdatedCount: 0,
    unreadableCount: 0,
    modificationCounter: '0',
    status: 'Known',
    reason: null,
    ...overrides,
  }
}

const NOW = Date.parse('2026-01-10T00:00:00Z')

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
      incidents: incidents({
        deadlocks: { observed: true, graphCount: 2, retainedCount: 2, pinnedCount: 1, reason: 'ok' },
      }),
      route: null,
      objects: [],
      search: '',
      now: NOW,
    })

    expect(projection.items.find(item => item.key === 'car-crash')?.headline).toContain('2 car crash')
  })

  it('maps degraded route warnings to a water-main break signal', () => {
    const projection = projectCityDisasters({
      incidents: incidents(),
      route: route({ stops: [stop({ warnings: ['SpillToTempDb: level 2'] })] }),
      objects: [],
      search: '',
      now: NOW,
    })

    expect(projection.items.some(item => item.key === 'water-main-break')).toBe(true)
  })

  /**
   * `NoJoinPredicate` is an attribute on `<Warnings>`, not a child element, so it only reaches the
   * route once the parser reads attributes. It is asserted here because a vocabulary naming a kind
   * nothing produces is a rule that silently never fires.
   */
  it('recognises the warning kinds that arrive as attributes rather than elements', () => {
    const projection = projectCityDisasters({
      incidents: incidents(),
      route: route({ stops: [stop({ warnings: ['NoJoinPredicate'] })] }),
      objects: [],
      search: '',
      now: NOW,
    })

    expect(projection.items.some(item => item.key === 'water-main-break')).toBe(true)
  })

  it('matches warning kinds case-insensitively, as the .NET vocabulary does', () => {
    const projection = projectCityDisasters({
      incidents: incidents(),
      route: route({ stops: [stop({ warnings: ['spilltotempdb: level 2'] })] }),
      objects: [],
      search: '',
      now: NOW,
    })

    expect(projection.items.some(item => item.key === 'water-main-break')).toBe(true)
  })

  /**
   * Guards the defect this replaced: the projection used to look for a `MissingIndexGroup` *warning*
   * on a route stop. `<MissingIndexes>` is plan-level and written before the first `<RelOp>`, so no
   * stop can ever carry that warning and the rule could never fire against real data.
   */
  it('does not take a missing index from a stop warning, which can never carry one', () => {
    const projection = projectCityDisasters({
      incidents: incidents(),
      route: route({
        stops: [stop({ estimatedCostShare: 0.9, warnings: ['MissingIndexGroup'] })],
        missingIndexes: [],
      }),
      objects: [],
      search: '',
      now: NOW,
    })

    expect(projection.items.some(item => item.key === 'building-fire')).toBe(false)
  })

  it('maps a high-impact missing index to a building fire and names the object', () => {
    const projection = projectCityDisasters({
      incidents: incidents(),
      route: route({
        missingIndexes: [
          {
            objectId: 'o1',
            label: 'dbo.Customer',
            impactPercent: 98.5,
            equalityColumns: ['CustomerId'],
            inequalityColumns: [],
            includedColumns: [],
          },
        ],
      }),
      objects: [],
      search: '',
      now: NOW,
    })

    const fire = projection.items.find(item => item.key === 'building-fire')
    expect(fire?.detail).toContain('dbo.Customer')
    expect(projection.fireObjectIds).toEqual(['o1'])
  })

  it('leaves a low-impact missing index alone', () => {
    const projection = projectCityDisasters({
      incidents: incidents(),
      route: route({
        missingIndexes: [
          {
            objectId: 'o1',
            label: 'dbo.Customer',
            impactPercent: LARGE_MISSING_INDEX_IMPACT_PERCENT - 1,
            equalityColumns: [],
            inequalityColumns: [],
            includedColumns: [],
          },
        ],
      }),
      objects: [],
      search: '',
      now: NOW,
    })

    expect(projection.items.some(item => item.key === 'building-fire')).toBe(false)
    expect(projection.fireObjectIds).toEqual([])
  })

  it('weathers only the objects whose own statistics are stale', () => {
    const projection = projectCityDisasters({
      incidents: incidents(),
      route: null,
      objects: [
        cityObject({ objectId: 'stale', statistics: statistics({ oldestLastUpdated: '2026-01-01T00:00:00Z' }) }),
        cityObject({ objectId: 'fresh', statistics: statistics({ oldestLastUpdated: '2026-01-09T00:00:00Z' }) }),
      ],
      search: '?statsStaleDays=7',
      now: NOW,
    })

    expect(projection.items.some(item => item.key === 'stats-decay')).toBe(true)
    expect(projection.staleStatsObjectIds).toEqual(['stale'])
  })

  /**
   * The threshold is a boundary, not a range: exactly at it is not yet stale.
   */
  it('treats an object exactly at the threshold as fresh', () => {
    const projection = projectCityDisasters({
      incidents: incidents(),
      route: null,
      objects: [
        cityObject({ objectId: 'edge', statistics: statistics({ oldestLastUpdated: '2026-01-03T00:00:00Z' }) }),
      ],
      search: '?statsStaleDays=7',
      now: NOW,
    })

    expect(projection.staleStatsObjectIds).toEqual([])
  })

  /**
   * A statistic that has never been updated reports a null timestamp, which `MIN` skips. Treating
   * that null as freshness would report a never-analysed object as up to date.
   */
  it('treats a never-updated statistic as stale rather than as fresh', () => {
    const projection = projectCityDisasters({
      incidents: incidents(),
      route: null,
      objects: [
        cityObject({
          objectId: 'never',
          statistics: statistics({ oldestLastUpdated: null, neverUpdatedCount: 1 }),
        }),
      ],
      search: '?statsStaleDays=7',
      now: NOW,
    })

    expect(projection.staleStatsObjectIds).toEqual(['never'])
    expect(projection.items.find(item => item.key === 'stats-decay')?.detail).toContain('never been built')
  })

  it('does not weather an object that carries no statistics at all', () => {
    const projection = projectCityDisasters({
      incidents: incidents(),
      route: null,
      objects: [
        cityObject({
          objectId: 'none',
          statistics: statistics({ statisticsCount: 0, oldestLastUpdated: null }),
        }),
      ],
      search: '?statsStaleDays=7',
      now: NOW,
    })

    expect(projection.staleStatsObjectIds).toEqual([])
  })

  /**
   * The whole point of the rewrite: page evidence is a catalog-snapshot timestamp taken seconds ago,
   * so reading staleness from it made the rule dead against a live instance and made it mean "this
   * archive is old" against an imported one. An object with no statistics measurement produces
   * nothing rather than falling back to any other clock.
   */
  it('reports nothing when no statistics were measured, whatever the page evidence says', () => {
    const projection = projectCityDisasters({
      incidents: incidents(),
      route: null,
      objects: [cityObject({ objectId: 'unmeasured', statistics: undefined })],
      search: '?statsStaleDays=7',
      now: NOW,
    })

    expect(projection.items.some(item => item.key === 'stats-decay')).toBe(false)
    expect(projection.staleStatsObjectIds).toEqual([])
  })

  it('does not weather an object whose statistics could not be read', () => {
    const projection = projectCityDisasters({
      incidents: incidents(),
      route: null,
      objects: [
        cityObject({
          objectId: 'denied',
          statistics: statistics({
            status: 'Unknown',
            oldestLastUpdated: null,
            statisticsCount: 0,
            reason: 'permission denied',
          }),
        }),
      ],
      search: '?statsStaleDays=7',
      now: NOW,
    })

    expect(projection.staleStatsObjectIds).toEqual([])
  })
})
