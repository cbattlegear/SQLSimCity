import { assignTraffic, tourDemands, type TravelDemand } from './cityAssignment'
import { dedupePoints, nearestIntersectionId, type CityPlan } from './cityPlan'
import type { DatabaseCityQueryFamily } from './databaseCityContracts'
import { familyCostShares, familyWaitByObject } from './cityWaitAttribution'
import { CONGESTION_COLORS, congestionFromDelay, type CongestionGrade } from './cityTraffic'
import {
  familyTrafficMeasurement, trafficBasis, trafficCoverageNote,
  type FamilyTrafficMeasurement, type TrafficBasis,
} from './cityTrafficWindow'

/**
 * Building the city's traffic map out of the workload itself.
 *
 * Every ranked query family is driven through the buildings its plans read, once per captured
 * execution, and what accumulates on each street is the traffic layer. This is the aggregate view the
 * map shows by default. A single query's *path* is a detail you ask for by selecting a plan; what you
 * want to see standing back is which parts of town are busy and which are slow, which is a property
 * of the whole workload rather than of any one query.
 *
 * Two quantities accumulate per street, and they are kept apart on purpose because they answer
 * different questions and are measured differently:
 *
 * - **measuredExecutions** — executions in the city-wide traffic window. The separate retained
 *   `executions` fixes route assignment and label ordering, not the colour denominator.
 * - **wait milliseconds** — the wait time apportioned to the buildings at each end of the leg. The
 *   milliseconds are measured; which building they were placed on is the optimizer's estimated cost
 *   share weighted by runtime from that same window; spreading them along a route is this module's
 *   model. No recent split means unplaced, not retained waits rescaled. Colour comes from the ratio of
 *   the two, which is the mean waiting a single execution carried over this street.
 *
 * There is deliberately no single blended "traffic score". Executions are a count and waits are a
 * duration; a number mixing them would have no unit and no way to be checked against anything
 * SQL Server reported. Two honest channels beat one invented one — even now that only one of them
 * is drawn.
 *
 * The route between two buildings remains invented — SQL Server has no streets — so which street a
 * family's traffic lands on is scenery, and the legend says so. What the traffic is *made of* is not.
 *
 * The ladder that turns the ratio into a colour lives in {@link ./cityTraffic}, so a street and the
 * co-reference road running along it are graded by one rule rather than by two that agree by
 * coincidence.
 */

export interface StreetLoad {
  readonly edgeId: number
  /** Retained executions, used only for stable geography and label priority. */
  readonly executions: number
  /** Grading denominator in the selected window; null for incomplete capture. */
  readonly measuredExecutions: number | null
  /**
   * Apportioned wait milliseconds the journeys crossing this street carried. Like `measuredExecutions`, this
   * is a per-traversal intensity rather than a divisible share: a street is charged the whole wait of
   * every leg that crosses it, so summing this across streets is meaningless. These same-window fields divide
   * cleanly into each other. Null means missing capture or placement, never zero wait.
   */
  readonly waitMilliseconds: number | null
  /** Mean waiting one execution carried over this street, or null when nothing routed here. */
  readonly delayPerExecution: number | null
  readonly grade: CongestionGrade
  readonly color: number
  readonly points: ReadonlyArray<{ x: number; z: number }>
  readonly rationale: string
}

/** One family's journey through the buildings it reads, drawn only when that family is selected. */
export interface FamilyTrip {
  readonly familyId: string
  /** Object ids in visit order. Never a facility: a query does not drive to the CPU yard. */
  readonly stops: readonly string[]
  readonly edgeIds: readonly number[]
  readonly points: Array<{ x: number; z: number }>
  readonly executions: number
  readonly measuredExecutions: number | null
  readonly waitMilliseconds: number | null
}

export interface WorkloadTraffic {
  /** Loaded streets, keyed by graph edge id. Streets nothing routed over are absent, not zero. */
  readonly streets: ReadonlyMap<number, StreetLoad>
  readonly trips: ReadonlyMap<string, FamilyTrip>
  /** Largest execution count on any one street, for scaling. */
  readonly busiest: number
  /** Families with a building on this page but no journey to make from it. */
  readonly resident: readonly string[]
  /** Families whose buildings could not be placed on the street network. */
  readonly unroutable: readonly string[]
  readonly basis: TrafficBasis
  readonly note: string
}

const EMPTY: WorkloadTraffic = {
  streets: new Map(),
  trips: new Map(),
  busiest: 0,
  resident: [],
  unroutable: [],
  basis: { kind: 'retained', window: null },
  note: 'No ranked query family could be routed through this page, so no traffic is drawn.',
}

export { congestionFromDelay }

/**
 * Orders a family's buildings into the journey it makes.
 *
 * Query Store hands back the objects a plan named as a set, with no order, so an order has to be
 * chosen. It starts at the building the plan spent most of its estimated cost on — the table the
 * query is really about — and walks to the nearest building it has not visited yet. That produces a
 * journey across town rather than a scribble, and it is fixed by the data rather than by chance, so
 * the same family always drives the same way.
 */
export function visitOrder(
  objectIds: readonly string[],
  shares: ReadonlyMap<string, number>,
  positionOf: (objectId: string) => { x: number; z: number } | null,
): string[] {
  const placed = objectIds
    .filter(objectId => positionOf(objectId) !== null)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  if (placed.length < 2) return placed

  let start = placed[0]
  let best = shares.get(start) ?? 0
  for (const objectId of placed) {
    const share = shares.get(objectId) ?? 0
    if (share > best) {
      best = share
      start = objectId
    }
  }

  const remaining = new Set(placed)
  remaining.delete(start)
  const order = [start]
  let current = positionOf(start)!
  while (remaining.size > 0) {
    let nearest: string | null = null
    let nearestDistance = Number.POSITIVE_INFINITY
    for (const objectId of remaining) {
      const point = positionOf(objectId)!
      const distance = (point.x - current.x) ** 2 + (point.z - current.z) ** 2
      // Ties resolve by id so the walk never depends on set iteration order.
      if (distance < nearestDistance || (distance === nearestDistance && nearest !== null && objectId < nearest)) {
        nearestDistance = distance
        nearest = objectId
      }
    }
    if (nearest === null) break
    remaining.delete(nearest)
    order.push(nearest)
    current = positionOf(nearest)!
  }
  return order
}

function toNumber(value: string | null | undefined): number {
  if (value === null || value === undefined || value.trim() === '') return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export function assignWorkloadTraffic(
  plan: CityPlan,
  families: readonly DatabaseCityQueryFamily[],
): WorkloadTraffic {
  if (families.length === 0) return EMPTY
  const basis = trafficBasis(families)
  const coverageNote = trafficCoverageNote(families, basis)
  const unplaced = families.filter(family => {
    const sample = familyTrafficMeasurement(family, basis)
    return !sample.quiet && !sample.attribution?.objects.length
  }).length
  const allocationNote = unplaced > 0
    ? ` ${unplaced} families have no usable wait placement in this window; their street contribution is unknown, not zero.`
    : ''

  const nodeByObject = new Map<string, number | null>()
  const nodeFor = (objectId: string): number | null => {
    const cached = nodeByObject.get(objectId)
    if (cached !== undefined) return cached
    const lot = plan.lots.get(objectId)
    const nearest = lot
      ? plan.intersections.get(nearestIntersectionId(plan, lot.accessX, lot.accessZ))
      : undefined
    const node = nearest ? nearest.col : null
    nodeByObject.set(objectId, node)
    return node
  }
  const positionOf = (objectId: string): { x: number; z: number } | null => {
    const lot = plan.lots.get(objectId)
    return lot && nodeFor(objectId) !== null ? { x: lot.accessX, z: lot.accessZ } : null
  }

  const demands: TravelDemand[] = []
  const routed = new Map<number, {
    family: DatabaseCityQueryFamily
    stops: string[]
    waits: Map<string, bigint>
    sample: FamilyTrafficMeasurement
  }>()
  const resident: string[] = []
  const unroutable: string[] = []

  families.forEach((family, index) => {
    const executions = toNumber(family.executionCount)
    const ordered = visitOrder(family.objectIds, familyCostShares(family), positionOf)
    // Two buildings can share a kerb, and the assignment collapses repeated stops, so collapse them
    // here too or the legs stop lining up with the buildings they connect.
    const seen = new Set<number>()
    const stops = ordered.filter(objectId => {
      const node = nodeFor(objectId)!
      if (seen.has(node)) return false
      seen.add(node)
      return true
    })
    if (stops.length === 0) {
      unroutable.push(family.familyId)
      return
    }
    if (stops.length < 2) {
      // One building on this page: the family's wait belongs to that building, and it does, but there
      // is no journey to spread over the streets.
      resident.push(family.familyId)
      return
    }
    if (executions <= 0) {
      resident.push(family.familyId)
      return
    }

    routed.set(index, {
      family, stops, waits: familyWaitByObject(family, basis), sample: familyTrafficMeasurement(family, basis),
    })
    const nodeIds = stops.map(objectId => nodeFor(objectId)!)
    for (const demand of tourDemands(String(index), nodeIds, executions)) demands.push(demand)
  })

  if (demands.length === 0) {
    return {
      ...EMPTY, resident, unroutable, basis,
      note: `${coverageNote}${allocationNote} ${note(0, 0, resident.length, unroutable.length)}`,
    }
  }

  const assignment = assignTraffic(plan.graph, plan.roadProperties, demands)
  const edgeById = new Map(plan.graph.edges.map(edge => [edge.id, edge]))

  for (const key of assignment.unroutable) {
    const index = Number.parseInt(key.split(':')[0], 10)
    const entry = routed.get(index)
    if (entry && !unroutable.includes(entry.family.familyId)) unroutable.push(entry.family.familyId)
  }

  const executionsByEdge = new Map<number, number>()
  const waitByEdge = new Map<number, number>()
  const measuredExecutionsByEdge = new Map<number, number | null>()
  const unknownEdges = new Set<number>()
  const familiesByEdge = new Map<number, Set<number>>()
  const tripEdges = new Map<number, number[]>()
  const tripPoints = new Map<number, Array<{ x: number; z: number }>>()

  for (const trip of assignment.trips) {
    const index = Number.parseInt(trip.key.split(':')[0], 10)
    const entry = routed.get(index)
    if (!entry) continue

    // Which leg this is, so the wait of the two buildings it connects can be charged to it.
    const legIndex = trip.key.includes(':')
      ? Number.parseInt(trip.key.slice(trip.key.indexOf(':') + 1), 10)
      : 0
    // Each building's apportioned wait is spread across the legs that touch it: the two end stops
    // have one adjacent leg each and take it whole, an interior stop has two and splits it evenly.
    // Summed over the legs this returns the family's apportioned total exactly, so the street charges
    // reconcile with the buildings the way every other total in this codebase does. Halving both ends
    // instead would quietly discard the outer halves of the first and last stop.
    const legCount = entry.stops.length - 1
    const shareOf = (stopIndex: number): number => {
      const objectId = entry.stops[stopIndex]
      const wait = Number(entry.waits.get(objectId) ?? 0n)
      const adjacentLegs = stopIndex === 0 || stopIndex === legCount ? 1 : 2
      return wait / adjacentLegs
    }
    const legWait = shareOf(legIndex) + shareOf(legIndex + 1)
    const sample = entry.sample
    const placed = sample.quiet || !!sample.attribution?.objects.length
    const known = sample.covered && placed
      && (legWait > 0 || sample.waitMilliseconds === 0n
        || sample.attribution?.unattributedWaitMilliseconds === '0')

    for (const edgeId of trip.route.edgeIds) {
      executionsByEdge.set(edgeId, (executionsByEdge.get(edgeId) ?? 0) + trip.trips)
      waitByEdge.set(edgeId, (waitByEdge.get(edgeId) ?? 0) + legWait)
      const previousCount = measuredExecutionsByEdge.get(edgeId)
      const count = sample.executions === null ? null : Number(sample.executions)
      measuredExecutionsByEdge.set(edgeId,
        previousCount === null || count === null || !Number.isFinite(count)
          ? null : (previousCount ?? 0) + count)
      if (!known) unknownEdges.add(edgeId)
      const contributors = familiesByEdge.get(edgeId) ?? new Set<number>()
      contributors.add(index)
      familiesByEdge.set(edgeId, contributors)
    }

    const edges = tripEdges.get(index) ?? []
    edges.push(...trip.route.edgeIds)
    tripEdges.set(index, edges)

    const points = tripPoints.get(index) ?? []
    const leg = trip.route.path.map(point => ({ x: point.x, z: point.z }))
    points.push(...leg)
    tripPoints.set(index, points)
  }

  const streets = new Map<number, StreetLoad>()
  let busiest = 0
  for (const [edgeId, executions] of executionsByEdge) {
    const edge = edgeById.get(edgeId)
    if (!edge || executions <= 0) continue
    const measuredExecutions = measuredExecutionsByEdge.get(edgeId) ?? null
    const waitMilliseconds = unknownEdges.has(edgeId) ? null : waitByEdge.get(edgeId) ?? 0
    const delayPerExecution = waitMilliseconds === null || measuredExecutions === null
      ? null
      : measuredExecutions > 0 ? waitMilliseconds / measuredExecutions
        : waitMilliseconds === 0 && basis.kind === 'recent' ? 0 : null
    const grade = congestionFromDelay(delayPerExecution)
    busiest = Math.max(busiest, executions)
    streets.set(edgeId, {
      edgeId,
      executions,
      measuredExecutions,
      waitMilliseconds,
      delayPerExecution,
      grade,
      color: CONGESTION_COLORS[grade],
      points: edge.points,
      rationale: trafficCoverageNote([...familiesByEdge.get(edgeId)!].map(index => families[index]), basis)
        + (unknownEdges.has(edgeId) ? ' Missing wait placement keeps this street unknown; covered contributors cannot stand for the whole street.' : '')
        + ' Geography uses retained executions; colour divides same-window modelled wait placement by same-window executions.',
    })
  }

  const trips = new Map<string, FamilyTrip>()
  for (const [index, entry] of routed) {
    const points = tripPoints.get(index)
    if (!points || points.length === 0) continue
    let waitMilliseconds = 0
    for (const value of entry.waits.values()) waitMilliseconds += Number(value)
    const first = plan.lots.get(entry.stops[0])!
    const last = plan.lots.get(entry.stops[entry.stops.length - 1])!
    // The assigned route runs junction to junction; bookend it with the kerb each building is entered
    // from, so the drawn journey meets its doors and not the nearest corner.
    trips.set(entry.family.familyId, {
      familyId: entry.family.familyId,
      stops: entry.stops,
      edgeIds: tripEdges.get(index) ?? [],
      points: dedupePoints([
        { x: first.accessX, z: first.accessZ },
        ...points,
        { x: last.accessX, z: last.accessZ },
      ]),
      executions: toNumber(entry.family.executionCount),
      measuredExecutions: entry.sample.executions === null ? null : Number(entry.sample.executions),
      waitMilliseconds: entry.sample.quiet || entry.sample.attribution?.objects.length ? waitMilliseconds : null,
    })
  }

  return {
    streets,
    trips,
    busiest,
    resident,
    unroutable,
    basis,
    note: `${coverageNote}${allocationNote} ${note(streets.size, trips.size, resident.length, unroutable.length)}`,
  }
}

function note(streets: number, trips: number, resident: number, unroutable: number): string {
  if (trips === 0) {
    return (
      'No ranked family visits two buildings on this page, so there is no traffic to spread over the streets. ' +
      'Wait time apportioned to individual buildings is unaffected.'
    )
  }
  const parts = [
    `${trips.toLocaleString()} ranked query families are driven through the buildings their plans read, ` +
    `using retained executions for stable geography across ${streets.toLocaleString()} streets.`,
  ]
  if (resident > 0) {
    parts.push(
      `${resident.toLocaleString()} more make no retained journey here; any measured wait placement remains with their buildings.`,
    )
  }
  if (unroutable > 0) {
    parts.push(`${unroutable.toLocaleString()} name no building this page draws.`)
  }
  parts.push(
    'Executions and wait milliseconds are measured. Which street they were driven along is not: SQL Server has no streets.',
  )
  return parts.join(' ')
}
