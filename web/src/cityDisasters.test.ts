import { describe, expect, it } from 'vitest'
import type { DatabaseCityObject } from './databaseCityContracts'
import type { IncidentProjection } from './cityIncidents'
import type { CityRoute, RouteStop } from './cityRoute'
import {
  LARGE_MISSING_INDEX_IMPACT_PERCENT,
  projectCityDisasters,
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
    pastAutoUpdateThresholdCount: 0,
    ...overrides,
  }
}

describe('projectCityDisasters', () => {
  it('maps retained deadlocks to car crashes', () => {
    const projection = projectCityDisasters({
      incidents: incidents({
        deadlocks: { observed: true, graphCount: 2, retainedCount: 2, pinnedCount: 1, reason: 'ok' },
      }),
      route: null,
      objects: [],
    })

    expect(projection.items.find(item => item.key === 'car-crash')?.headline).toContain('2 car crash')
  })

  it('maps degraded route warnings to a water-main break signal', () => {
    const projection = projectCityDisasters({
      incidents: incidents(),
      route: route({ stops: [stop({ warnings: ['SpillToTempDb: level 2'] })] }),
      objects: [],
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
    })

    expect(projection.items.some(item => item.key === 'water-main-break')).toBe(true)
  })

  it('matches warning kinds case-insensitively, as the .NET vocabulary does', () => {
    const projection = projectCityDisasters({
      incidents: incidents(),
      route: route({ stops: [stop({ warnings: ['spilltotempdb: level 2'] })] }),
      objects: [],
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
    })

    expect(projection.items.some(item => item.key === 'building-fire')).toBe(false)
    expect(projection.fireObjectIds).toEqual([])
  })

  it('weathers only the objects whose own statistics are past the auto-update threshold', () => {
    const projection = projectCityDisasters({
      incidents: incidents(),
      route: null,
      objects: [
        cityObject({
          objectId: 'due',
          statistics: statistics({ pastAutoUpdateThresholdCount: 1, modificationCounter: '4501' }),
        }),
        cityObject({
          objectId: 'current',
          statistics: statistics({ pastAutoUpdateThresholdCount: 0, modificationCounter: '12' }),
        }),
      ],
    })

    expect(projection.items.some(item => item.key === 'stats-decay')).toBe(true)
    expect(projection.staleStatsObjectIds).toEqual(['due'])
  })

  /**
   * The rule this replaced was an age threshold, which disagrees with the engine in both directions.
   * A statistic built long ago against a table nothing has modified since is exactly right, and the
   * engine will not rebuild it however old it gets.
   */
  it('does not weather an old statistic the engine has no reason to rebuild', () => {
    const projection = projectCityDisasters({
      incidents: incidents(),
      route: null,
      objects: [
        cityObject({
          objectId: 'old-but-correct',
          statistics: statistics({
            oldestLastUpdated: '2019-01-01T00:00:00Z',
            pastAutoUpdateThresholdCount: 0,
          }),
        }),
      ],
    })

    expect(projection.items.some(item => item.key === 'stats-decay')).toBe(false)
    expect(projection.staleStatsObjectIds).toEqual([])
  })

  /**
   * The other direction: freshly built and already owed an update, which the age rule called fresh.
   */
  it('weathers a recently built statistic whose table has been modified past the threshold', () => {
    const projection = projectCityDisasters({
      incidents: incidents(),
      route: null,
      objects: [
        cityObject({
          objectId: 'new-but-churned',
          statistics: statistics({
            oldestLastUpdated: '2026-01-09T23:00:00Z',
            pastAutoUpdateThresholdCount: 2,
          }),
        }),
      ],
    })

    expect(projection.staleStatsObjectIds).toEqual(['new-but-churned'])
  })

  /**
   * A never-updated statistic is not by itself evidence that an update is owed: nothing has modified
   * the table, so there is nothing to rebuild from. It reaches the threshold count on its own once
   * modifications accumulate, which is where the decision belongs.
   */
  it('does not weather a never-updated statistic that is not past its threshold', () => {
    const projection = projectCityDisasters({
      incidents: incidents(),
      route: null,
      objects: [
        cityObject({
          objectId: 'never',
          statistics: statistics({
            oldestLastUpdated: null,
            neverUpdatedCount: 1,
            pastAutoUpdateThresholdCount: 0,
          }),
        }),
      ],
    })

    expect(projection.staleStatsObjectIds).toEqual([])
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
    })

    expect(projection.staleStatsObjectIds).toEqual([])
  })

  /**
   * An archive written before the threshold was measured carries no count at all. That is missing
   * evidence, and reading it as a measured zero would report every object in an old archive as
   * current — the same conflation the null statistics block already guards against.
   */
  it('reports nothing for an archive that never measured the threshold', () => {
    const projection = projectCityDisasters({
      incidents: incidents(),
      route: null,
      objects: [
        cityObject({
          objectId: 'older-archive',
          statistics: statistics({ pastAutoUpdateThresholdCount: undefined, modificationCounter: '9999999' }),
        }),
        cityObject({
          objectId: 'older-archive-null',
          statistics: statistics({ pastAutoUpdateThresholdCount: null }),
        }),
      ],
    })

    expect(projection.items.some(item => item.key === 'stats-decay')).toBe(false)
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
    })

    expect(projection.staleStatsObjectIds).toEqual([])
  })
})
