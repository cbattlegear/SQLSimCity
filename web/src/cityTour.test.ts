/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { DatabaseCityObject } from './databaseCityContracts'
import type { Evidence } from './contracts'
import type { IncidentMarker } from './cityIncidents'
import type { RoadTraffic } from './cityTraffic'
import {
  MAX_TOUR_STOPS,
  TOUR_START,
  breakingStopIndex,
  easeInOutCubic,
  easeInOutSine,
  holdShot,
  openingShot,
  planCityTour,
  pointAlongPath,
  resumeIndex,
  shortestTurn,
  stepTour,
  stopDuration,
  tourFrame,
  type TourFacts,
  type TourPoint,
  type TourStop,
} from './cityTour'

const EVIDENCE: Evidence = { status: 'Available', source: 'QueryStoreAggregate', reason: 'ok', observedAt: null, freshUntil: null }

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

function road(overrides: Partial<RoadTraffic> = {}): RoadTraffic {
  return {
    routeId: 'r1',
    fromObjectId: 'o1',
    toId: 'o2',
    kind: 'ObjectReference',
    confidence: 'Confirmed',
    pattern: 'solid',
    width: 5.2,
    grade: 'severe',
    color: 0xe4483c,
    executions: 100,
    waitShare: 0.5,
    delayPerExecution: 60,
    recentExecutions: 40,
    recentWindowMinutes: 15,
    familyIds: ['f1'],
    rationale: 'because',
    ...overrides,
  }
}

function marker(overrides: Partial<IncidentMarker> = {}): IncidentMarker {
  return {
    id: 'i1',
    objectId: 'o1',
    counterpartObjectIds: [],
    sessionIds: [55],
    severity: 'blocked',
    headline: 'Session 55 blocked on dbo.Customer',
    details: ['Waiting 4.2 s on LCK_M_X'],
    source: 'sys.dm_exec_requests',
    observedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const BOUNDS = {
  minX: -500,
  maxX: 500,
  minZ: -400,
  maxZ: 400,
  centerX: 0,
  centerZ: 0,
  width: 1000,
  depth: 800,
}

function facts(overrides: Partial<TourFacts> = {}): TourFacts {
  return {
    cityName: 'AdventureWorks',
    bounds: BOUNDS,
    cell: 30,
    objects: [],
    lots: new Map<string, TourPoint>(),
    roads: [],
    roadPaths: new Map<string, readonly TourPoint[]>(),
    incidents: [],
    ...overrides,
  }
}

/** A city with something in every bucket, so the interleave has material to work with. */
function busyCity(): TourFacts {
  const objects = [
    cityObject({
      objectId: 'o1',
      name: 'SalesOrderHeader',
      schemaId: 's1',
      schemaName: 'Sales',
      reservedPages8KiB: '900000',
      attributedExposure: {
        ...cityObject().attributedExposure,
        totalCpuMicroseconds: '9000000',
      },
    }),
    cityObject({
      objectId: 'o2',
      name: 'SalesOrderDetail',
      schemaId: 's1',
      schemaName: 'Sales',
      reservedPages8KiB: '400000',
      attributedExposure: {
        ...cityObject().attributedExposure,
        totalCpuMicroseconds: '4000000',
      },
    }),
    cityObject({ objectId: 'o3', name: 'Person', schemaId: 's2', schemaName: 'Person', reservedPages8KiB: '50000' }),
    cityObject({ objectId: 'o4', name: 'Address', schemaId: 's2', schemaName: 'Person', reservedPages8KiB: '20000' }),
    cityObject({ objectId: 'o5', name: 'Product', schemaId: 's3', schemaName: 'Production', reservedPages8KiB: '9000' }),
    cityObject({
      objectId: 'o6',
      name: 'ProductReview',
      schemaId: 's3',
      schemaName: 'Production',
      reservedPages8KiB: '800',
    }),
  ]
  const lots = new Map<string, TourPoint>([
    ['o1', { x: 0, z: 0 }],
    ['o2', { x: 60, z: 0 }],
    ['o3', { x: -120, z: 90 }],
    ['o4', { x: -80, z: 130 }],
    ['o5', { x: 200, z: -140 }],
    ['o6', { x: 240, z: -100 }],
  ])
  return facts({
    objects,
    lots,
    roads: [
      road({ routeId: 'r1', fromObjectId: 'o1', toId: 'o2', delayPerExecution: 60, grade: 'severe' }),
      road({ routeId: 'r2', fromObjectId: 'o3', toId: 'o4', delayPerExecution: 6, grade: 'heavy' }),
      road({ routeId: 'r3', fromObjectId: 'o5', toId: 'o6', delayPerExecution: 1, grade: 'moderate' }),
    ],
    roadPaths: new Map<string, readonly TourPoint[]>([
      ['r1', [{ x: 0, z: 0 }, { x: 30, z: 0 }, { x: 60, z: 0 }]],
      ['r2', [{ x: -120, z: 90 }, { x: -80, z: 130 }]],
      ['r3', [{ x: 200, z: -140 }, { x: 240, z: -100 }]],
    ]),
    incidents: [marker({ id: 'i1', objectId: 'o1' })],
  })
}

function stop(overrides: Partial<TourStop> = {}): TourStop {
  return {
    id: 'tour:test',
    kind: 'landmark',
    target: { x: 10, z: 20 },
    targetY: 11,
    span: 100,
    spanEnd: 60,
    azimuth: 0.5,
    orbit: 0.4,
    polar: 0.848,
    travelMs: 4000,
    holdMs: 8000,
    caption: 'dbo.Customer',
    detail: 'Largest by reserved pages on this page · 80.0 KiB reserved',
    ...overrides,
  }
}

describe('easing', () => {
  it('rests at both ends and passes through the middle', () => {
    expect(easeInOutCubic(0)).toBe(0)
    expect(easeInOutCubic(1)).toBe(1)
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 10)
    expect(easeInOutSine(0)).toBeCloseTo(0, 10)
    expect(easeInOutSine(1)).toBeCloseTo(1, 10)
    expect(easeInOutSine(0.5)).toBeCloseTo(0.5, 10)
  })

  it('clamps rather than extrapolating past the leg it was asked about', () => {
    expect(easeInOutCubic(-3)).toBe(0)
    expect(easeInOutCubic(4)).toBe(1)
    expect(easeInOutSine(-3)).toBeCloseTo(0, 10)
    expect(easeInOutSine(4)).toBeCloseTo(1, 10)
  })
})

/**
 * The wrap is the whole point of this function, and it is invisible without it: an azimuth that
 * crosses ±π interpolated naively sends the camera three quarters of the way round the city to
 * reach a building that was next door.
 */
describe('shortestTurn', () => {
  it('takes the short way round when the leg crosses the seam', () => {
    expect(shortestTurn(3.0, -3.0)).toBeCloseTo(0.2831853, 5)
    expect(shortestTurn(-3.0, 3.0)).toBeCloseTo(-0.2831853, 5)
  })

  it('never returns a turn longer than half a revolution', () => {
    for (let from = -8; from <= 8; from += 0.37) {
      for (let to = -8; to <= 8; to += 0.53) {
        expect(Math.abs(shortestTurn(from, to))).toBeLessThanOrEqual(Math.PI + 1e-9)
      }
    }
  })

  it('lands on the requested bearing, modulo a full revolution', () => {
    const landed = 1.2 + shortestTurn(1.2, -2.9)
    expect(Math.abs(Math.sin(landed) - Math.sin(-2.9))).toBeLessThan(1e-9)
    expect(Math.abs(Math.cos(landed) - Math.cos(-2.9))).toBeLessThan(1e-9)
  })
})

/**
 * Arc length, not vertex count. A street graph puts its vertices where the geometry bends, so a
 * vertex-parameterised walk sprints down the straights and crawls round the corners.
 */
describe('pointAlongPath', () => {
  const uneven: readonly TourPoint[] = [{ x: 0, z: 0 }, { x: 90, z: 0 }, { x: 100, z: 0 }]

  it('walks at constant speed across unevenly spaced vertices', () => {
    expect(pointAlongPath(uneven, 0)).toEqual({ x: 0, z: 0 })
    expect(pointAlongPath(uneven, 0.5).x).toBeCloseTo(50, 9)
    expect(pointAlongPath(uneven, 1).x).toBeCloseTo(100, 9)
  })

  it('is exactly halfway along at t = 0.5 rather than at the middle vertex', () => {
    // The middle vertex sits at 90% of the arc. Parameterising by index would put it at 50%.
    expect(pointAlongPath(uneven, 0.5).x).not.toBeCloseTo(90, 3)
  })

  it('clamps outside the path rather than extrapolating off the end of the street', () => {
    expect(pointAlongPath(uneven, -1)).toEqual({ x: 0, z: 0 })
    expect(pointAlongPath(uneven, 9).x).toBeCloseTo(100, 9)
  })

  it('survives a degenerate path with no arc length at all', () => {
    expect(pointAlongPath([{ x: 5, z: 5 }, { x: 5, z: 5 }], 0.5)).toEqual({ x: 5, z: 5 })
    expect(pointAlongPath([{ x: 7, z: 8 }], 0.5)).toEqual({ x: 7, z: 8 })
  })
})

describe('the shot held at a stop', () => {
  it('opens on the stop and closes pushed in', () => {
    const subject = stop()
    expect(openingShot(subject).span).toBe(100)
    expect(holdShot(subject, 0).span).toBeCloseTo(100, 9)
    expect(holdShot(subject, subject.holdMs).span).toBeCloseTo(60, 9)
  })

  it('drifts around the target by the stop’s signed orbit', () => {
    const subject = stop({ orbit: -0.4 })
    expect(holdShot(subject, 0).azimuth).toBeCloseTo(0.5, 9)
    expect(holdShot(subject, subject.holdMs).azimuth).toBeCloseTo(0.1, 9)
  })

  it('follows the street rather than standing at its first corner', () => {
    const path: readonly TourPoint[] = [{ x: 0, z: 0 }, { x: 100, z: 0 }]
    const subject = stop({ kind: 'street', path, target: path[0] })
    expect(holdShot(subject, 0).x).toBeCloseTo(0, 9)
    expect(holdShot(subject, subject.holdMs / 2).x).toBeCloseTo(50, 9)
    expect(holdShot(subject, subject.holdMs).x).toBeCloseTo(100, 9)
  })

  it('stands still at a stop that holds for no time at all', () => {
    const subject = stop({ holdMs: 0 })
    expect(holdShot(subject, 0).span).toBeCloseTo(subject.spanEnd, 9)
  })
})

describe('the frame at t', () => {
  const from = { x: 500, z: 500, y: 8, span: 2000, azimuth: 3.0, polar: 0.848 }

  it('starts the leg exactly where the camera already was', () => {
    const frame = tourFrame(from, stop(), 0)
    expect(frame.phase).toBe('travel')
    expect(frame.shot.x).toBeCloseTo(from.x, 9)
    expect(frame.shot.span).toBeCloseTo(from.span, 6)
  })

  it('arrives on the stop’s opening shot', () => {
    const subject = stop()
    const frame = tourFrame(from, subject, subject.travelMs)
    expect(frame.phase).toBe('hold')
    expect(frame.shot.x).toBeCloseTo(subject.target.x, 9)
    expect(frame.shot.span).toBeCloseTo(subject.span, 9)
  })

  /*
   * Magnification is perceived multiplicatively, so a leg that goes from a 2,000-unit city framing
   * to a 100-unit building framing has to be interpolated in log space. Linearly, the halfway point
   * of a 20x change sits at 1,050 units — visually still the whole city, so the shot spends most of
   * its travel appearing not to move and then lunges at the end.
   */
  it('interpolates magnification geometrically, not linearly', () => {
    const subject = stop()
    const half = tourFrame(from, subject, subject.travelMs / 2).shot.span
    expect(half).toBeCloseTo(Math.sqrt(2000 * 100), 4)
    expect(half).toBeLessThan((2000 + 100) / 2)
  })

  it('turns the short way when the leg crosses the seam', () => {
    const subject = stop({ azimuth: -3.0 })
    const half = tourFrame({ ...from, azimuth: 3.0 }, subject, subject.travelMs / 2).shot.azimuth
    // The short way is 0.28 rad of turn, so the midpoint sits just past ±π rather than near zero.
    expect(Math.abs(half)).toBeGreaterThan(3.0)
  })

  it('cuts straight to the hold when there is no travel to make', () => {
    const frame = tourFrame(from, stop({ travelMs: 0 }), 0)
    expect(frame.phase).toBe('hold')
    expect(frame.shot.x).toBeCloseTo(10, 9)
  })
})

describe('stepTour', () => {
  const stops = [stop({ id: 'a', travelMs: 1000, holdMs: 1000 }), stop({ id: 'b', travelMs: 1000, holdMs: 1000 })]

  it('stays on a stop until its travel and hold are both spent', () => {
    expect(stepTour(TOUR_START, stops, 1999)).toEqual({ index: 0, elapsed: 1999 })
  })

  it('advances and carries the remainder', () => {
    expect(stepTour(TOUR_START, stops, 2500)).toEqual({ index: 1, elapsed: 500 })
  })

  it('wraps back to the start of the itinerary', () => {
    expect(stepTour({ index: 1, elapsed: 1900 }, stops, 200).index).toBe(0)
  })

  /*
   * A backgrounded tab hands back the whole gap on the frame it resumes. The scene clamps its own
   * delta, and this is the second guard: an unbounded loop here would run the itinerary forward
   * through an hour of it to land somewhere arbitrary.
   */
  it('is bounded against an enormous delta rather than looping through it', () => {
    const state = stepTour(TOUR_START, stops, 60 * 60 * 1000)
    expect(state.index).toBeGreaterThanOrEqual(0)
    expect(state.index).toBeLessThan(stops.length)
    expect(Number.isFinite(state.elapsed)).toBe(true)
  })

  it('returns to the start when the itinerary has emptied', () => {
    expect(stepTour({ index: 3, elapsed: 900 }, [], 16)).toEqual(TOUR_START)
  })

  it('brings an out-of-range index back in range rather than reading past the end', () => {
    expect(stepTour({ index: 7, elapsed: 0 }, stops, 0).index).toBe(1)
  })

  it('never reports a stop as lasting no time, which would spin the itinerary', () => {
    expect(stopDuration(stop({ travelMs: 0, holdMs: 0 }))).toBeGreaterThan(0)
  })
})

describe('resuming across a replan', () => {
  const before = [stop({ id: 'a' }), stop({ id: 'b' }), stop({ id: 'c' })]

  it('follows the current stop to wherever it moved', () => {
    const after = [stop({ id: 'c' }), stop({ id: 'a' }), stop({ id: 'b' })]
    expect(resumeIndex(before, after, 2)).toBe(0)
  })

  it('holds the ordinal when the current stop has gone', () => {
    expect(resumeIndex(before, [stop({ id: 'x' }), stop({ id: 'y' }), stop({ id: 'z' })], 1)).toBe(1)
  })

  it('clamps into a shorter itinerary rather than indexing off the end', () => {
    expect(resumeIndex(before, [stop({ id: 'x' })], 2)).toBe(0)
  })

  it('starts over when the replan produced nothing', () => {
    expect(resumeIndex(before, [], 2)).toBe(0)
  })
})

/**
 * The cut to the disaster. A block that started ten seconds ago is the one event on this map worth
 * abandoning a shot for; waiting out the rotation would routinely mean arriving after it cleared.
 */
describe('breakingStopIndex', () => {
  const incident = (id: string) => stop({ id, kind: 'incident' })

  it('finds an incident that was not in the previous itinerary', () => {
    expect(breakingStopIndex([incident('i1')], [stop({ id: 's' }), incident('i1'), incident('i2')])).toBe(2)
  })

  it('reports nothing when every incident was already being toured', () => {
    expect(breakingStopIndex([incident('i1')], [stop({ id: 's' }), incident('i1')])).toBe(-1)
  })

  /*
   * A landmark entering the itinerary because a later page raised its measured CPU is not news, it
   * is the same city better counted. Cutting to it would make every page load yank the camera.
   */
  it('does not treat a newly ranked building as breaking news', () => {
    expect(breakingStopIndex([incident('i1')], [incident('i1'), stop({ id: 'new-landmark' })])).toBe(-1)
  })
})

describe('planCityTour', () => {
  it('opens on an establishing shot of the whole city', () => {
    const itinerary = planCityTour(busyCity())
    expect(itinerary[0].kind).toBe('skyline')
    expect(itinerary[0].caption).toBe('AdventureWorks')
    expect(itinerary[0].span).toBeGreaterThan(BOUNDS.width)
  })

  it('still produces a tour for a city with nothing measured in it', () => {
    const itinerary = planCityTour(facts())
    expect(itinerary).toHaveLength(1)
    expect(itinerary[0].kind).toBe('skyline')
    expect(itinerary[0].detail).toContain('0 objects drawn')
  })

  /*
   * The interleave is the difference between a tour and a list. Concatenating the buckets would
   * spend the first half of every itinerary on six buildings in a row, which is exactly the shape
   * a viewer stops watching.
   */
  it('never visits the same kind twice in a row while another kind is waiting', () => {
    const itinerary = planCityTour(busyCity())
    const kinds = itinerary.map(entry => entry.kind)
    const remaining = (at: number) => new Set(kinds.slice(at)).size
    for (let index = 1; index < kinds.length; index += 1) {
      if (kinds[index] === kinds[index - 1]) {
        expect(remaining(index), `two ${kinds[index]} stops in a row at ${index}`).toBe(1)
      }
    }
  })

  it('leads with the incident, because it is the only stop that is news', () => {
    const itinerary = planCityTour(busyCity())
    expect(itinerary[1].kind).toBe('incident')
    expect(itinerary[1].caption).toBe('Session 55 blocked on dbo.Customer')
    expect(itinerary[1].detail).toBe('Waiting 4.2 s on LCK_M_X')
  })

  it('gives every stop a stable, unique id', () => {
    const itinerary = planCityTour(busyCity())
    expect(new Set(itinerary.map(entry => entry.id)).size).toBe(itinerary.length)
  })

  it('plans the same city the same way twice', () => {
    expect(planCityTour(busyCity())).toEqual(planCityTour(busyCity()))
  })

  it('caps the itinerary so a loop comes back round inside a few minutes', () => {
    const many = busyCity()
    const objects = Array.from({ length: 200 }, (_, index) =>
      cityObject({
        objectId: `x${index}`,
        name: `Table${index}`,
        schemaId: `s${index % 7}`,
        schemaName: `sch${index % 7}`,
        reservedPages8KiB: `${1000 + index}`,
      }))
    const lots = new Map<string, TourPoint>(objects.map((object, index) => [
      object.objectId,
      { x: index * 11, z: index * 7 },
    ]))
    const itinerary = planCityTour({ ...many, objects, lots })
    expect(itinerary.length).toBeLessThanOrEqual(MAX_TOUR_STOPS)
  })

  /*
   * A caption states the measurement that earned the stop. Ranking on attributed CPU alone would
   * skip every large table no ranked query named, and ranking on size alone would skip the small
   * hot one -- so both lists are toured and each says which list it came from.
   */
  it('says which measurement earned each landmark', () => {
    const itinerary = planCityTour(busyCity())
    const landmarks = itinerary.filter(entry => entry.kind === 'landmark')
    expect(landmarks.some(entry => entry.detail.includes('Most attributed Query Store CPU'))).toBe(true)
    expect(landmarks.some(entry => entry.detail.includes('Largest by reserved pages'))).toBe(true)
    const hottest = landmarks.find(entry => entry.objectId === 'o1')
    expect(hottest?.caption).toBe('Sales.SalesOrderHeader')
    expect(hottest?.detail).toContain('9.0 s')
  })

  it('tours a building once, however many rankings named it', () => {
    const itinerary = planCityTour(busyCity())
    const visited = itinerary.filter(entry => entry.kind === 'landmark').map(entry => entry.objectId)
    expect(new Set(visited).size).toBe(visited.length)
  })

  /*
   * The absence rule. A street with no captured wait evidence has not been shown to be quiet; it has
   * not been measured, and captioning it as free-flowing is a different claim than the data makes.
   */
  it('captions an unmeasured street as unmeasured, never as quiet', () => {
    const city = busyCity()
    const itinerary = planCityTour({
      ...city,
      roads: [road({ routeId: 'r1', delayPerExecution: null, grade: 'unknown', executions: null, recentExecutions: 5 })],
    })
    const street = itinerary.find(entry => entry.kind === 'street')
    expect(street?.detail).toContain('No captured wait evidence')
    expect(street?.detail).toContain('no captured executions')
    expect(street?.detail).not.toContain('Free-flowing')
  })

  it('names both ends of a street it follows', () => {
    const itinerary = planCityTour(busyCity())
    const street = itinerary.find(entry => entry.routeId === 'r1')
    expect(street?.caption).toBe('Sales.SalesOrderHeader → Sales.SalesOrderDetail')
    expect(street?.path?.length).toBe(3)
  })

  it('skips a road the scene never drew, because it has no ground to follow', () => {
    const city = busyCity()
    const itinerary = planCityTour({ ...city, roadPaths: new Map() })
    expect(itinerary.some(entry => entry.kind === 'street')).toBe(false)
  })

  it('skips an incident whose object is not on this page', () => {
    const city = busyCity()
    const itinerary = planCityTour({ ...city, incidents: [marker({ id: 'i9', objectId: 'not-loaded' })] })
    expect(itinerary.some(entry => entry.kind === 'incident')).toBe(false)
  })

  it('gathers neighbourhoods from the buildings that actually stand in them', () => {
    const itinerary = planCityTour(busyCity())
    const neighbourhood = itinerary.find(entry => entry.kind === 'neighbourhood')
    expect(neighbourhood?.detail).toContain('2 objects drawn')
    expect(['Sales', 'Person', 'Production']).toContain(neighbourhood?.caption)
  })

  it('points the camera down the street rather than across it', () => {
    const city = busyCity()
    // A street running due east: its bearing is +x, so the camera belongs to the west of the target.
    const itinerary = planCityTour({
      ...city,
      roads: [road({ routeId: 'r1' })],
      roadPaths: new Map([['r1', [{ x: 0, z: 0 }, { x: 100, z: 0 }]]]),
    })
    const street = itinerary.find(entry => entry.kind === 'street')!
    // The scene places the camera at (sin(az), _, cos(az)) from the target, so looking east means
    // standing west: sin(azimuth) is negative.
    expect(Math.sin(street.azimuth)).toBeLessThan(-0.9)
  })

  /*
   * A tour is not withdrawn under prefers-reduced-motion -- it was explicitly switched on, and it is
   * the only way to see the whole city without driving. What is withdrawn is the motion.
   */
  it('cuts between stops and holds still under reduced motion', () => {
    const itinerary = planCityTour(busyCity(), { reducedMotion: true })
    expect(itinerary.length).toBeGreaterThan(1)
    for (const entry of itinerary) {
      expect(entry.travelMs).toBe(0)
      expect(entry.orbit).toBe(0)
      expect(entry.spanEnd).toBe(entry.span)
      expect(entry.holdMs).toBeGreaterThan(0)
    }
  })

  it('holds each still stop for as long as the moving one took in total', () => {
    const moving = planCityTour(busyCity())
    const still = planCityTour(busyCity(), { reducedMotion: true })
    expect(still.map(stopDuration)).toEqual(moving.map(stopDuration))
  })

  it('rejects a size or CPU total it cannot parse rather than ranking it as zero', () => {
    const itinerary = planCityTour(facts({
      objects: [cityObject({ objectId: 'o1', reservedPages8KiB: 'not a number' })],
      lots: new Map([['o1', { x: 0, z: 0 }]]),
    }))
    expect(itinerary.some(entry => entry.kind === 'landmark')).toBe(false)
  })
})

/**
 * The one piece of the tour that lives in the scene and cannot be reached from here except as text.
 *
 * `stepTour` is pure and takes whatever delta it is handed, so every assertion above is true no
 * matter what the scene feeds it. The scene clamps that delta to bound a backgrounded tab's
 * catch-up, and the value of the clamp is the whole behaviour: a ceiling *below* the real frame
 * interval does not bound an exception, it rescales time on every frame.
 *
 * That is not hypothetical. The first implementation clamped at 100ms, and the establishing shot
 * over a 4,200-object city measured a median 147ms and a max 197ms per frame at 1440x900 -- so the
 * clamp bit continuously and ran the tour at roughly 68% speed. Measured in a browser: four stops
 * in sixty seconds where the itinerary asks for six. Nothing in this file could see it, and
 * nothing in it can see a regression either, which is why the guard is here as source text.
 */
describe('the scene clamps the tour delta above its own worst frame', () => {
  const scene = readFileSync(new URL('./DatabaseCityScene.ts', import.meta.url), 'utf8')

  it('clamps generously enough that a normally rendering frame never trips it', () => {
    /*
     * Sliced to the tour loop rather than searched across the file. The vehicle loop clamps too,
     * at a value that is correct for it, and a bare search would happily read that one instead --
     * a guard reporting on a different loop than the one it names.
     */
    const from = scene.indexOf('const runTourLoop')
    const to = scene.indexOf('const stopTourLoop')
    expect(from, 'runTourLoop has been renamed and this guard now covers nothing').toBeGreaterThan(-1)
    expect(to, 'stopTourLoop has been renamed or hoisted, inverting this slice').toBeGreaterThan(from)
    const loop = scene.slice(from, to)

    const match = loop.match(/Math\.min\(now - previous, (\d+)\)/)
    expect(match, 'the tour loop should clamp its frame delta').not.toBeNull()
    const clamp = Number(match![1])
    // 197ms was the worst frame measured. Anything at or under it rescales the whole itinerary.
    expect(clamp).toBeGreaterThan(197)
  })
})
