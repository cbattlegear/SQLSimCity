import { describe, expect, it } from 'vitest'
import { planCity, type CityPlanOptions } from './cityPlan'
import {
  HEAVY_DELAY_MS_PER_EXECUTION,
  MODERATE_DELAY_MS_PER_EXECUTION,
  SEVERE_DELAY_MS_PER_EXECUTION,
  gradeRoads,
} from './cityTraffic'
import {
  assignWorkloadTraffic,
  congestionFromDelay,
  visitOrder,
} from './cityWorkloadTraffic'
import type {
  DatabaseCityObject,
  DatabaseCityQueryFamily,
  DatabaseCityRecentActivity,
  DatabaseCitySchema,
  DatabaseCityWaitAttribution,
} from './databaseCityContracts'
import type { Evidence } from './contracts'

const evidence: Evidence = {
  source: 'QueryStoreAggregate',
  status: 'Available',
  observedAt: null,
  freshUntil: null,
  reason: 'test',
}

function object(objectId: string, schemaId: string, neighborhoodOrdinal: number, objectOrdinal: number): DatabaseCityObject {
  return {
    objectId,
    schemaId,
    schemaName: schemaId.replace('schema:', ''),
    name: objectId,
    kind: 'Table',
    reservedPages8KiB: '4096',
    usedPages8KiB: '2048',
    reservedBytes: String(4096n * 8192n),
    usedBytes: String(2048n * 8192n),
    sizeStatus: 'Known',
    sizeReason: null,
    layout: { neighborhoodOrdinal, objectOrdinal, x: 0, z: 0 },
    indexes: [],
    directActivity: { totalOperations: '1', resetEpochToken: null, evidence },
    attributedExposure: {
      executionCount: null,
      totalCpuMicroseconds: null,
      totalDurationMicroseconds: null,
      totalLogicalReads8KiBPages: null,
      confidence: 'Unknown',
      rationale: 'test',
      evidence,
    },
  }
}

function sampleCity(): DatabaseCityObject[] {
  const objects: DatabaseCityObject[] = []
  for (let index = 0; index < 11; index += 1) objects.push(object(`object:dbo:${100 + index}`, 'schema:dbo', 0, index))
  for (let index = 0; index < 5; index += 1) objects.push(object(`object:rep:${300 + index}`, 'schema:reporting', 1, index))
  return objects
}

function sampleSchemas(): DatabaseCitySchema[] {
  return [
    { schemaId: 'schema:dbo', name: 'dbo', neighborhoodOrdinal: 0, objectCount: '11', evidence },
    { schemaId: 'schema:reporting', name: 'reporting', neighborhoodOrdinal: 1, objectCount: '5', evidence },
  ]
}

function options(overrides: Partial<CityPlanOptions> = {}): CityPlanOptions {
  return { seed: 'db:sales', totalObjects: '16', schemas: sampleSchemas(), ...overrides }
}

function attribution(objects: Array<[string, number, string]>, unattributed = '0'): DatabaseCityWaitAttribution {
  return {
    objects: objects.map(([objectId, estimatedCostShare, waitMilliseconds]) => ({
      objectId,
      estimatedCostShare,
      waitMilliseconds,
    })),
    unattributedWaitMilliseconds: unattributed,
    plansRead: 1,
    rationale: 'test',
  }
}

function family(
  familyId: string,
  objectIds: string[],
  executionCount: string,
  totalWaitMilliseconds = '0',
  waitAttribution: DatabaseCityWaitAttribution | null = null,
): DatabaseCityQueryFamily {
  return {
    familyId,
    queryHash: '0x00',
    executionCount,
    totalCpuMicroseconds: '0',
    totalDurationMicroseconds: '0',
    totalLogicalReads8KiBPages: '0',
    totalWaitMilliseconds,
    waitMillisecondsByCategory: {},
    objectIds,
    confidence: 'Confirmed',
    rationale: 'test',
    evidence,
    waitAttribution,
  }
}

const plan = planCity(sampleCity(), options())

function recent(overrides: Partial<DatabaseCityRecentActivity> = {}): DatabaseCityRecentActivity {
  const wait = overrides.totalWaitMilliseconds ?? '0'
  return {
    windowMinutes: 15, windowStart: '2024-05-01T00:45:00Z', windowEnd: '2024-05-01T01:00:00Z',
    covered: true, executionCount: '0', totalDurationMicroseconds: '0', totalWaitMilliseconds: '0',
    waitAttribution: { objects: [], unattributedWaitMilliseconds: wait, plansRead: 0, rationale: 'No usable plan' },
    waitMillisecondsByCategory: { CPU: wait },
    rationale: 'test', ...overrides,
  }
}

describe('congestionFromDelay', () => {
  it('grades an unrouted street as unknown rather than free-flowing', () => {
    expect(congestionFromDelay(null)).toBe('unknown')
  })

  it('grades by measured waiting per execution', () => {
    expect(congestionFromDelay(0)).toBe('free')
    expect(congestionFromDelay(MODERATE_DELAY_MS_PER_EXECUTION)).toBe('moderate')
    expect(congestionFromDelay(HEAVY_DELAY_MS_PER_EXECUTION)).toBe('heavy')
    expect(congestionFromDelay(SEVERE_DELAY_MS_PER_EXECUTION)).toBe('severe')
  })

  /**
   * The streets and the co-reference roads have to be the same ladder, not two that happen to share
   * a palette. Re-exporting is what makes "the street is amber and the road along it is green"
   * impossible for reasons of drift rather than of measurement.
   */
  it('is the same function the roads are graded by', async () => {
    const roads = await import('./cityTraffic')
    expect(congestionFromDelay).toBe(roads.congestionFromDelay)
  })
})

describe('visitOrder', () => {
  const positions: Record<string, { x: number; z: number }> = {
    a: { x: 0, z: 0 },
    b: { x: 10, z: 0 },
    c: { x: 100, z: 0 },
  }
  const positionOf = (id: string) => positions[id] ?? null

  it('starts at the table the plan spent most of its estimated cost on', () => {
    const order = visitOrder(['a', 'b', 'c'], new Map([['c', 0.9], ['a', 0.1]]), positionOf)
    expect(order[0]).toBe('c')
  })

  it('walks to the nearest building it has not visited', () => {
    const order = visitOrder(['a', 'b', 'c'], new Map([['a', 1]]), positionOf)
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('drops objects this page does not place', () => {
    const order = visitOrder(['a', 'missing', 'b'], new Map(), positionOf)
    expect(order).toEqual(['a', 'b'])
  })

  it('is stable when no cost share distinguishes the stops', () => {
    const first = visitOrder(['c', 'b', 'a'], new Map(), positionOf)
    const second = visitOrder(['a', 'b', 'c'], new Map(), positionOf)
    expect(first).toEqual(second)
  })
})

describe('assignWorkloadTraffic', () => {
  it('draws nothing from an empty workload', () => {
    const traffic = assignWorkloadTraffic(plan, [])
    expect(traffic.streets.size).toBe(0)
    expect(traffic.trips.size).toBe(0)
  })

  it('loads streets from families that visit more than one building', () => {
    const traffic = assignWorkloadTraffic(plan, [
      family('f1', ['object:dbo:100', 'object:rep:300'], '5000'),
    ])
    expect(traffic.streets.size).toBeGreaterThan(0)
    expect(traffic.trips.size).toBe(1)
    expect(traffic.busiest).toBe(5000)
  })

  it('routes a family only through buildings, never through a facility', () => {
    const traffic = assignWorkloadTraffic(plan, [
      family('f1', ['object:dbo:100', 'object:dbo:105', 'object:rep:300'], '500'),
    ])
    const trip = traffic.trips.get('f1')!
    expect(trip.stops).toHaveLength(3)
    for (const stop of trip.stops) expect(plan.lots.has(stop)).toBe(true)
  })

  it('bookends a trip at the kerb of its first and last building', () => {
    const traffic = assignWorkloadTraffic(plan, [
      family('f1', ['object:dbo:100', 'object:rep:300'], '500'),
    ])
    const trip = traffic.trips.get('f1')!
    const first = plan.lots.get(trip.stops[0])!
    const last = plan.lots.get(trip.stops[trip.stops.length - 1])!
    expect(trip.points[0].x).toBeCloseTo(first.accessX, 3)
    expect(trip.points[0].z).toBeCloseTo(first.accessZ, 3)
    expect(trip.points[trip.points.length - 1].x).toBeCloseTo(last.accessX, 3)
    expect(trip.points[trip.points.length - 1].z).toBeCloseTo(last.accessZ, 3)
  })

  it('charges a leg the whole apportioned wait of the buildings it connects', () => {
    // Two stops, so each end has exactly one adjacent leg and takes its share whole. Every street on
    // that leg therefore carries the family's full apportioned wait — halving both ends instead would
    // quietly discard half of it. Wait is a per-traversal intensity like executions, so it is charged
    // to each street the leg crosses rather than divided between them.
    const traffic = assignWorkloadTraffic(plan, [
      family(
        'f1',
        ['object:dbo:100', 'object:rep:300'],
        '1000',
        '9000',
        attribution([
          ['object:dbo:100', 0.7, '6300'],
          ['object:rep:300', 0.3, '2700'],
        ]),
      ),
    ])
    const loaded = [...traffic.streets.values()]
    expect(loaded.length).toBeGreaterThan(0)
    for (const street of loaded) {
      expect(street.waitMilliseconds).toBeCloseTo(9000, 6)
      expect(street.delayPerExecution).toBeCloseTo(9, 6)
      // 9 ms per execution is past the 5 ms cut point and short of the 50 ms one.
      expect(street.grade).toBe('heavy')
    }
  })

  it('splits an interior building between its two legs and keeps the ends whole', () => {
    const traffic = assignWorkloadTraffic(plan, [
      family(
        'f1',
        ['object:dbo:100', 'object:dbo:105', 'object:rep:300'],
        '1000',
        '9000',
        attribution([
          ['object:dbo:100', 0.5, '4500'],
          ['object:dbo:105', 0.3, '2700'],
          ['object:rep:300', 0.2, '1800'],
        ]),
      ),
    ])
    expect(traffic.trips.get('f1')!.stops).toHaveLength(3)
    // Leg one: 4500 + 2700/2. Leg two: 2700/2 + 1800. Together they are the apportioned 9000.
    const legWaits = new Set([...traffic.streets.values()].map(street => Math.round(street.waitMilliseconds!)))
    expect(legWaits.has(5850)).toBe(true)
    expect(legWaits.has(3150)).toBe(true)
    expect(5850 + 3150).toBe(9000)
  })

  it('leaves a street carrying no apportioned wait ungraded rather than clear', () => {
    const traffic = assignWorkloadTraffic(plan, [
      family('f1', ['object:dbo:100', 'object:rep:300'], '1000'),
    ])
    for (const street of traffic.streets.values()) {
      expect(street.grade).toBe('unknown')
      expect(street.delayPerExecution).toBeNull()
    }
  })

  it('adds the executions of two families that share a street', () => {    const one = assignWorkloadTraffic(plan, [family('f1', ['object:dbo:100', 'object:rep:300'], '100')])
    const two = assignWorkloadTraffic(plan, [
      family('f1', ['object:dbo:100', 'object:rep:300'], '100'),
      family('f2', ['object:dbo:100', 'object:rep:300'], '100'),
    ])
    const total = (traffic: typeof one): number =>
      [...traffic.streets.values()].reduce((sum, street) => sum + street.executions, 0)
    expect(total(two)).toBeGreaterThan(total(one))
    // Each street carries one family's executions or both; nothing in between is invented.
    for (const street of two.streets.values()) expect([100, 200]).toContain(street.executions)
  })

  it('leaves a street with no apportioned wait ungraded rather than calling it clear', () => {
    const traffic = assignWorkloadTraffic(plan, [
      family('f1', ['object:dbo:100', 'object:rep:300'], '500'),
    ])
    for (const street of traffic.streets.values()) expect(street.grade).toBe('unknown')
  })

  it('colours a street by the waiting its buildings were apportioned', () => {
    const busy = assignWorkloadTraffic(plan, [
      family(
        'f1',
        ['object:dbo:100', 'object:rep:300'],
        '10',
        '100000',
        attribution([['object:dbo:100', 0.5, '50000'], ['object:rep:300', 0.5, '50000']]),
      ),
    ])
    const graded = [...busy.streets.values()].filter(street => street.grade !== 'unknown')
    expect(graded.length).toBeGreaterThan(0)
    for (const street of graded) expect(street.grade).toBe('severe')
  })

  it('keeps a single-building family off the streets but does not call it unroutable', () => {
    const traffic = assignWorkloadTraffic(plan, [family('f1', ['object:dbo:100'], '900')])
    expect(traffic.resident).toEqual(['f1'])
    expect(traffic.unroutable).toEqual([])
    expect(traffic.streets.size).toBe(0)
  })

  it('reports a family naming nothing this page draws', () => {
    const traffic = assignWorkloadTraffic(plan, [family('f1', ['object:elsewhere:1'], '900')])
    expect(traffic.unroutable).toEqual(['f1'])
  })

  it('does not route a family with no captured executions', () => {
    const traffic = assignWorkloadTraffic(plan, [
      family('f1', ['object:dbo:100', 'object:rep:300'], '0'),
    ])
    expect(traffic.streets.size).toBe(0)
    expect(traffic.resident).toEqual(['f1'])
  })

  it('is identical when run twice over the same workload', () => {
    const families = [
      family('f1', ['object:dbo:100', 'object:rep:300'], '500', '900', attribution([['object:dbo:100', 1, '900']])),
      family('f2', ['object:dbo:103', 'object:rep:302', 'object:dbo:108'], '120'),
    ]
    const first = assignWorkloadTraffic(plan, families)
    const second = assignWorkloadTraffic(plan, families)
    expect([...second.streets.entries()].map(([id, street]) => [id, street.executions, street.waitMilliseconds])).toEqual(
      [...first.streets.entries()].map(([id, street]) => [id, street.executions, street.waitMilliseconds]),
    )
    expect(second.trips.get('f2')!.stops).toEqual(first.trips.get('f2')!.stops)
  })

  it('says the milliseconds are measured and the streets are not', () => {
    const traffic = assignWorkloadTraffic(plan, [
      family('f1', ['object:dbo:100', 'object:rep:300'], '500'),
    ])
    expect(traffic.note).toContain('measured')
    expect(traffic.note).toContain('SQL Server has no streets')
  })

  const endpoints = ['object:dbo:100', 'object:rep:300']
  const oldHot = family('old-hot', endpoints, '1000', '1000000',
    attribution([[endpoints[0], 0.9, '900000'], [endpoints[1], 0.1, '100000']]))
  const roadFor = (families: DatabaseCityQueryFamily[]) => gradeRoads([{
    routeId: 'road', fromObjectId: endpoints[0], toId: endpoints[1],
    kind: 'ObjectReference', confidence: 'Confirmed', rationale: 'test', evidence,
  }], families)[0]

  it('makes old-hot recent-zero streets quiet without removing their historical trips', () => {
    const historical = assignWorkloadTraffic(plan, [oldHot])
    const families = [{ ...oldHot, recentActivity: recent() }]
    const current = assignWorkloadTraffic(plan, families)
    expect(current.streets.size).toBeGreaterThan(0)
    expect(current.trips.get('old-hot')!.stops).toEqual(historical.trips.get('old-hot')!.stops)
    expect(current.trips.get('old-hot')!.edgeIds).toEqual(historical.trips.get('old-hot')!.edgeIds)
    expect(current.trips.get('old-hot')!.points).toEqual(historical.trips.get('old-hot')!.points)
    expect(current.trips.get('old-hot')!.waitMilliseconds).toBe(0)
    for (const street of current.streets.values()) {
      expect(street.executions).toBe(1000)
      expect(street.measuredExecutions).toBe(0)
      expect(street.waitMilliseconds).toBe(0)
      expect(street.delayPerExecution).toBe(0)
      expect(street.grade).toBe(roadFor(families).grade)
    }
  })

  it('uses recent measured waits and runtime allocation without changing retained visit order', () => {
    const families = [{
      ...oldHot, recentActivity: recent({
        executionCount: '2', totalWaitMilliseconds: '120',
        waitAttribution: attribution([[endpoints[0], 0.1, '12'], [endpoints[1], 0.9, '108']]),
      }),
    }]
    const current = assignWorkloadTraffic(plan, families)
    expect(current.trips.get('old-hot')!.stops[0]).toBe(endpoints[0])
    for (const street of current.streets.values()) {
      expect(street.waitMilliseconds).toBe(120)
      expect(street.measuredExecutions).toBe(2)
      expect(street.delayPerExecution).toBe(60)
      expect(street.grade).toBe(roadFor(families).grade)
    }
  })

  it('does not rescale retained allocation when recent waits lack their own split', () => {
    const traffic = assignWorkloadTraffic(plan, [{
      ...oldHot, recentActivity: recent({ executionCount: '100', totalWaitMilliseconds: '10' }),
    }])
    expect(traffic.streets.size).toBeGreaterThan(0)
    for (const street of traffic.streets.values()) {
      expect(street.grade).toBe('unknown')
      expect(street.waitMilliseconds).toBeNull()
      expect(street.delayPerExecution).toBeNull()
    }
    expect(traffic.note).toContain('no usable wait placement')
  })

  it('does not call executions with zero waits quiet without a recent placement model', () => {
    const traffic = assignWorkloadTraffic(plan, [{
      ...oldHot, recentActivity: recent({ executionCount: '10' }),
    }])
    for (const street of traffic.streets.values()) expect(street.grade).toBe('unknown')
  })

  it('keeps shared streets unknown when a covered quiet family hides a missing contributor', () => {
    const traffic = assignWorkloadTraffic(plan, [
      { ...oldHot, recentActivity: recent() },
      { ...oldHot, familyId: 'missing' },
    ])
    const missingEdges = traffic.trips.get('missing')!.edgeIds
    const sharedEdges = traffic.trips.get('old-hot')!.edgeIds.filter(id => missingEdges.includes(id))
    expect(sharedEdges.length).toBeGreaterThan(0)
    for (const id of sharedEdges) {
      const street = traffic.streets.get(id)!
      expect(street.grade).toBe('unknown')
      expect(street.measuredExecutions).toBeNull()
      expect(street.waitMilliseconds).toBeNull()
      expect(street.rationale).toContain('1 of 2')
    }
  })

  it('uses the global recent basis even when only an unroutable family publishes it', () => {
    const traffic = assignWorkloadTraffic(plan, [
      oldHot,
      { ...family('publisher', [], '1'), recentActivity: recent() },
    ])
    expect(traffic.streets.size).toBeGreaterThan(0)
    for (const street of traffic.streets.values()) expect(street.grade).toBe('unknown')
    expect(traffic.basis.kind).toBe('recent')
  })

  it.each(['bad', '-1', '', '0x10'])('does not grade malformed recent executions %j as zero', value => {
    const traffic = assignWorkloadTraffic(plan, [{
      ...oldHot, recentActivity: recent({ executionCount: value }),
    }])
    expect(traffic.streets.size).toBeGreaterThan(0)
    for (const street of traffic.streets.values()) {
      expect(street.grade).toBe('unknown')
      expect(street.measuredExecutions).toBeNull()
    }
  })

  it.each(['0', '10'])('keeps runtime-covered executions %s unknown when both recent wait records are null', executionCount => {
    const traffic = assignWorkloadTraffic(plan, [{
      ...oldHot, recentActivity: recent({
        executionCount, totalWaitMilliseconds: '0', waitAttribution: null, waitMillisecondsByCategory: null,
      }),
    }])
    expect(traffic.streets.size).toBeGreaterThan(0)
    for (const street of traffic.streets.values()) {
      expect(street.grade).toBe('unknown')
      expect(street.waitMilliseconds).toBeNull()
      expect(street.delayPerExecution).toBeNull()
    }
  })

  it('leaves legacy recent zero counters unknown when both optional wait records are omitted', () => {
    const traffic = assignWorkloadTraffic(plan, [{
      ...oldHot, recentActivity: recent({ waitAttribution: undefined, waitMillisecondsByCategory: undefined }),
    }])
    expect(traffic.streets.size).toBeGreaterThan(0)
    for (const street of traffic.streets.values()) expect(street.grade).toBe('unknown')
  })
})
