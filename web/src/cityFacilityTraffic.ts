import type { EdgeConfidence } from './contracts'
import type { DatabaseCityObject, DatabaseCityQueryFamily, QueryAttributionConfidence } from './databaseCityContracts'
import { FACILITY_LABELS, type FacilityKind } from './cityInfrastructure'
import { confidencePattern, type RoadPattern } from './cityTraffic'
import {
  familyTrafficMeasurement, trafficBasis, trafficBasisLabel, trafficCoverageNote, type TrafficBasis,
} from './cityTrafficWindow'

/**
 * Turns captured Query Store wait categories into **wait lanes**: measured traffic from a building to
 * the infrastructure facility whose resource that building's workload actually queued for.
 *
 * A building-to-building road answers "which objects are named together". A wait lane answers a
 * different question — "where did the time go" — so it is a separate lane rather than another road
 * grade. The scene no longer draws these lanes; their records feed evidence and hover text.
 * The retained lane-rendering metadata describes these channels:
 *
 * - **width**  = captured wait milliseconds on a documented log2 scale (roads have constant width).
 * - **colour** = which facility the lane ends at, so the destination stays readable when lanes cross.
 * - **pattern** = the contributing families' attribution confidence, the same channel roads use.
 *
 * Lanes come in two shapes. A family naming exactly one loaded object draws an **exclusive lane** from
 * that building, and such families' milliseconds accumulate per building. A family naming several
 * objects draws one **shared lane** ({@link SharedFacilityLane}) that threads through every named
 * object on this page before reaching the facility, carrying the family's whole total exactly once.
 * The shared shape exists so a multi-object query is visible as the relationship it is — these tables,
 * queried together, queued here — instead of vanishing into a footnote.
 *
 * Three deliberate refusals, because each alternative would invent a fact:
 *
 * 1. A family naming more than one object is **never divided** between its objects, and its total is
 *    **never added into a per-object lane**. Query Store reports one wait total per query, not per
 *    object, so either move would fabricate a per-building number. The shared lane keeps the figure
 *    whole and unowned; only when nothing it names is on this page, leaving no path to draw, does it
 *    fall back to text in {@link FacilityTraffic.shared}.
 * 2. A wait category with no physical counterpart in this city — Parallelism, Network IO, Compilation,
 *    Idle and friends — is **never folded into the CPU yard**. It is reported in
 *    {@link FacilityTraffic.unmapped} with the reason it has no destination.
 * 3. `Buffer Latch` is **not** routed to tempdb Works even though tempdb allocation contention is its
 *    most famous cause, because Query Store's category does not name a database. Guessing would be a
 *    fabrication; tempdb therefore has no Query Store lane at all.
 *
 * A building with no captured wait-category evidence gets **no lane**, never a zero-width one: a lane
 * only exists because waits were measured, so absence is reported in prose rather than drawn.
 */

/** Where a wait category is spent, or null when this city has no honest destination for it. */
export interface WaitCategoryRouting {
  readonly facility: FacilityKind | null
  /** Plain-language justification, shown verbatim wherever the category appears. */
  readonly reason: string
}

/**
 * The documented Query Store `wait_category_desc` values, routed to the six civic facilities.
 * Categories are matched case-insensitively but reported verbatim.
 */
export const WAIT_CATEGORY_ROUTING: Readonly<Record<string, WaitCategoryRouting>> = {
  'CPU': {
    facility: 'cpu',
    reason: 'Signal and yield waits queue for a scheduler, which is what the CPU Scheduler Yard is.',
  },
  'Worker Thread': {
    facility: 'cpu',
    reason: 'A request waiting for a worker is queued at the scheduler that owns the worker pool.',
  },
  'Memory': {
    facility: 'memory',
    reason: 'Query memory grant waits queue at the Memory Grant Office counter.',
  },
  'Buffer IO': {
    facility: 'storage',
    reason: 'Reading a page that was not in the buffer pool is a trip to the Storage & I/O Depot.',
  },
  'Other Disk IO': {
    facility: 'storage',
    reason: 'Non-buffer disk waits are still storage waits.',
  },
  'Tran Log IO': {
    facility: 'log',
    reason: 'Log flush waits queue at the Log Yard, which is a different device from the data files.',
  },
  'Log Rate Governor': {
    facility: 'log',
    reason: 'The platform is throttling log generation, which is a Log Yard constraint, not a disk one.',
  },
  'Lock': {
    facility: 'lock',
    reason: 'Lock waits queue at the Lock Authority.',
  },
  'Buffer Latch': {
    facility: null,
    reason:
      'Buffer latch contention is often tempdb allocation, but the wait category does not name a database, so routing it to tempdb Works would be a guess.',
  },
  'Latch': {
    facility: null,
    reason: 'Non-buffer latches protect engine-internal structures that are not one of these facilities.',
  },
  'Parallelism': {
    facility: null,
    reason: 'Exchange waits are coordination between workers, not a queue at any one resource.',
  },
  'Network IO': {
    facility: null,
    reason: 'The client, not the engine, is the far end of a network wait; it is off this map.',
  },
  'Compilation': {
    facility: null,
    reason: 'Compilation waits happen in the optimizer, which this city does not render as a place.',
  },
  'Idle': {
    facility: null,
    reason: 'Idle waits are time the request was not asking for anything, so no resource was queued for.',
  },
  'Preemptive': {
    facility: null,
    reason: 'A preemptive wait is time spent outside the engine, so its destination is not on this map.',
  },
  'User Wait': {
    facility: null,
    reason: 'WAITFOR and similar are requested by the query itself, not imposed by a resource.',
  },
  'Transaction': {
    facility: null,
    reason: 'Transaction-state waits are not queued at a single physical resource.',
  },
  'Tracing': {
    facility: null,
    reason: 'Tracing waits belong to diagnostics infrastructure, which is not a city facility.',
  },
  'SQL CLR': {
    facility: null,
    reason: 'CLR waits happen in the hosted runtime, which this city does not render as a place.',
  },
  'Mirroring': {
    facility: null,
    reason: 'Mirroring waits involve another replica, which is outside this database city.',
  },
  'Replication': {
    facility: null,
    reason: 'Replication waits involve another server, which is outside this database city.',
  },
  'Service Broker': {
    facility: null,
    reason: 'Service Broker waits belong to messaging infrastructure, which is not a city facility.',
  },
  'Full Text Search': {
    facility: null,
    reason: 'Full-text waits belong to a separate service, which is not one of these facilities.',
  },
  'Unknown': {
    facility: null,
    reason: 'Query Store itself could not categorise this wait, so neither can the map.',
  },
}

const UNRECOGNIZED: WaitCategoryRouting = {
  facility: null,
  reason:
    'This build does not recognise this wait category, so it is reported verbatim rather than routed to a guessed facility.',
}

/** Lane colours, one per facility, so a lane's destination is readable where lanes cross. */
export const LANE_COLORS: Readonly<Record<FacilityKind, number>> = {
  cpu: 0xc48be0,
  memory: 0x4ea9f5,
  storage: 0xf5a04e,
  tempdb: 0x7fd4b0,
  log: 0xe06f9c,
  lock: 0xe4483c,
}

export const MIN_LANE_WIDTH = 1.6
/**
 * Accumulated milliseconds span many orders of magnitude. Road width no longer encodes a number;
 * this independent scale remains on the lane records for consumers that display them.
 */
export const LANE_WIDTH_PER_DOUBLING = 0.3
export const MAX_LANE_WIDTH = 9

/**
 * Captured milliseconds at which lane width reaches {@link MAX_LANE_WIDTH} and stops encoding
 * magnitude — roughly 7.4 hours of accumulated wait. Beyond this the width is a floor, not a
 * measurement, so the exact figure is always carried in the lane rationale and evidence table.
 */
export const LANE_WIDTH_SATURATION_MILLISECONDS = Math.round(
  2 ** ((MAX_LANE_WIDTH - MIN_LANE_WIDTH) / LANE_WIDTH_PER_DOUBLING) - 1,
)

/** One building's captured wait time to one facility. */
export interface FacilityLane {
  readonly laneId: string
  readonly objectId: string
  readonly facility: FacilityKind
  readonly facilityLabel: string
  /** Exact captured milliseconds, as a lossless base-10 string. */
  readonly waitMilliseconds: string
  readonly width: number
  /** True when the lane exceeds the widest drawable value, so width no longer encodes magnitude. */
  readonly saturated: boolean
  readonly color: number
  readonly pattern: RoadPattern
  /** Weakest attribution confidence among the contributing families. */
  readonly confidence: QueryAttributionConfidence
  /** Verbatim wait categories that fed this lane, descending by milliseconds. */
  readonly categories: readonly CategoryTotal[]
  readonly familyIds: readonly string[]
  readonly rationale: string
}

/**
 * One query family's captured wait time to one facility, where the family names more than one
 * object. The figure is the family's whole captured wait: it is never divided between the objects
 * and never handed to whichever of them happens to be loaded. It is drawn exactly once, as a single
 * lane that threads through every named object on this page before reaching the facility, so the
 * relationship is visible without any object claiming the time as its own.
 */
export interface SharedFacilityLane {
  readonly laneId: string
  readonly familyId: string
  /** Named objects that are on this page, in stable order; the lane's path threads through these. */
  readonly objectIds: readonly string[]
  /** How many objects the family names in total, including any not loaded on this page. */
  readonly namedObjectCount: number
  /** Named objects absent from this page, so the drawn path is a subset of the real relationship. */
  readonly offPageObjectCount: number
  readonly facility: FacilityKind
  readonly facilityLabel: string
  /** Exact captured milliseconds for the whole family, as a lossless base-10 string. */
  readonly waitMilliseconds: string
  readonly width: number
  readonly saturated: boolean
  readonly color: number
  readonly pattern: RoadPattern
  readonly confidence: QueryAttributionConfidence
  readonly categories: readonly CategoryTotal[]
  readonly rationale: string
}

export interface CategoryTotal {
  readonly category: string
  readonly waitMilliseconds: string
}

/** A category with no facility, kept visible instead of being folded into one. */
export interface UnmappedWait extends CategoryTotal {
  readonly reason: string
}

export interface FacilityTraffic {
  readonly lanes: readonly FacilityLane[]
  /**
   * Wait time from families naming more than one loaded object, drawn whole as one threaded lane per
   * family and facility. These are deliberately kept out of {@link lanes} so that no per-object total
   * absorbs time the family never attributed to a single object.
   */
  readonly sharedLanes: readonly SharedFacilityLane[]
  /** Categories that have no destination facility, summed across every captured family. */
  readonly unmapped: readonly UnmappedWait[]
  /**
   * Wait time from multi-object families with no named object on this page, so there is nothing to
   * thread a lane through: reported whole, never divided, and never handed to an unnamed building.
   */
  readonly shared: readonly CategoryTotal[]
  /** Wait time from families naming no object, or naming one object that is not on this page. */
  readonly unattributed: readonly CategoryTotal[]
  /** How many of the supplied families carried any wait-category evidence. */
  readonly measuredFamilyCount: number
  readonly familyCount: number
  readonly basis: TrafficBasis
  /** Missing or malformed category evidence, not measured zero. */
  readonly unknownFamilyIds: readonly string[]
  /** Known waits whose category breakdown is unavailable, separate from category-labelled totals. */
  readonly unclassifiedWaitMilliseconds: string
  /** Always-shown disclosure of what this layer does and does not claim. */
  readonly note: string
}

/**
 * Lane width in world units. Every doubling of captured wait milliseconds adds
 * {@link LANE_WIDTH_PER_DOUBLING}, independently of constant road width, until
 * {@link LANE_WIDTH_SATURATION_MILLISECONDS}, past which width is clamped and the exact figure is
 * only available as text.
 */
export function laneWidth(milliseconds: bigint): number {
  if (milliseconds <= 0n) return MIN_LANE_WIDTH
  return Math.min(
    MAX_LANE_WIDTH,
    MIN_LANE_WIDTH + Math.log2(1 + Number(milliseconds)) * LANE_WIDTH_PER_DOUBLING,
  )
}

/** Routing for one verbatim category. An unrecognised category is reported, never dropped. */
export function routeWaitCategory(category: string): WaitCategoryRouting {
  const match = Object.keys(WAIT_CATEGORY_ROUTING).find(
    known => known.toLocaleLowerCase() === category.trim().toLocaleLowerCase(),
  )
  return match ? WAIT_CATEGORY_ROUTING[match] : UNRECOGNIZED
}

/** One facility's share of the captured waiting attributed to a single object. */
export interface FacilityShare {
  readonly facility: FacilityKind
  readonly label: string
  /** Exact captured milliseconds for this object and facility, as a lossless base-10 string. */
  readonly waitMilliseconds: string
  /** Fraction of this object's attributed waiting, in 0..1. */
  readonly share: number
  readonly partial?: boolean
  readonly windowMinutes?: number | null
}

/**
 * Where one object's captured waiting queued, by facility, descending.
 *
 * The six-hue lanes that used to draw this on the map are gone: the map now says how congested a
 * road is and nothing more, which is the whole point of a GPS colour. The measurement is not gone
 * with them — this is what puts it back where a reader actually asks the question, in the road's
 * hover readout and beside the object, and it is the same per-object per-facility total the
 * evidence table prints.
 *
 * Shared lanes are deliberately excluded. A multi-object family's wait belongs to no single object,
 * and folding it in here would hand one building time that was never attributed to it — the exact
 * thing {@link FacilityTraffic.sharedLanes} exists to prevent.
 */
export function facilityShares(objectId: string, traffic: FacilityTraffic): FacilityShare[] {
  const totals = new Map<FacilityKind, { label: string; milliseconds: bigint }>()
  let overall = 0n
  for (const lane of traffic.lanes) {
    if (lane.objectId !== objectId) continue
    const milliseconds = toBigInt(lane.waitMilliseconds) ?? 0n
    if (milliseconds <= 0n) continue
    const existing = totals.get(lane.facility)
    totals.set(lane.facility, {
      label: lane.facilityLabel,
      milliseconds: (existing?.milliseconds ?? 0n) + milliseconds,
    })
    overall += milliseconds
  }
  if (overall <= 0n) return []
  return [...totals.entries()]
    .map(([facility, entry]) => ({
      facility,
      label: entry.label,
      waitMilliseconds: entry.milliseconds.toString(),
      share: Number(entry.milliseconds) / Number(overall),
      partial: traffic.unknownFamilyIds.length > 0,
      windowMinutes: traffic.basis.kind === 'recent' ? traffic.basis.window?.windowMinutes ?? null : undefined,
    }))
    .sort((left, right) => right.share - left.share || left.facility.localeCompare(right.facility))
}

/**
 * The facility mix as one short phrase, or null when nothing was attributed to this object.
 *
 * Null is not "no waiting happened": it is "no ranked query family carried wait-category evidence
 * naming this object", and the caller must not render it as a quiet building.
 */
export function facilityMixLabel(shares: readonly FacilityShare[]): string | null {
  if (shares.length === 0) return null
  const label = shares
    .slice(0, 3)
    .map(entry => `${entry.label.toLocaleLowerCase()} ${Math.round(entry.share * 100)}%`)
    .join(', ')
  const window = shares[0].windowMinutes
  return label
    + (window !== undefined ? ` (recent${window === null ? '' : ` ${window} min`})` : '')
    + (shares.some(share => share.partial) ? ' — partial captured categories' : '')
}

const CONFIDENCE_RANK: Readonly<Record<QueryAttributionConfidence, number>> = {
  Confirmed: 2,
  Probable: 1,
  Unknown: 0,
}

/**
 * Projects captured wait categories onto facility lanes.
 *
 * `objects` bounds attribution to the buildings actually on this page: a family naming an object that
 * is not loaded contributes to {@link FacilityTraffic.unattributed} rather than being dropped.
 */
export function projectFacilityTraffic(
  families: readonly DatabaseCityQueryFamily[],
  objects: readonly Pick<DatabaseCityObject, 'objectId'>[],
  basis: TrafficBasis = trafficBasis(families),
): FacilityTraffic {
  const loaded = new Set(objects.map(object => object.objectId))
  const lanes = new Map<string, MutableLane>()
  const sharedLanes = new Map<string, MutableSharedLane>()
  const unmapped = new Map<string, bigint>()
  const shared = new Map<string, bigint>()
  const unattributed = new Map<string, bigint>()
  let measuredFamilyCount = 0
  let quietFamilyCount = 0
  let unclassifiedWait = 0n
  const unknownFamilyIds: string[] = []

  for (const family of families) {
    const sample = familyTrafficMeasurement(family, basis)
    if (sample.quiet) quietFamilyCount += 1
    const captured = categoryTotals(sample.categories)
    const categorySum = captured.reduce((sum, entry) => sum + entry.milliseconds, 0n)
    const malformed = sample.categories
      && Object.values(sample.categories).some(value => toBigInt(value) === null)
    const unavailable = basis.kind === 'recent'
      ? !sample.covered || !!malformed || sample.waitMilliseconds !== categorySum
        || (!sample.quiet && sample.categories === null)
      : captured.length === 0
    if (unavailable) {
      unknownFamilyIds.push(family.familyId)
      unclassifiedWait += sample.waitMilliseconds ?? 0n
      continue
    }
    if (captured.length === 0) continue
    measuredFamilyCount += 1

    // The refusal to divide is decided by what the family *names*, not by what happens to be loaded.
    // A family naming two objects where only one is on this page must not have all of its wait time
    // handed to that one building. So a multi-object family never feeds a per-object lane; it gets
    // its own lane threaded through the objects it names, carrying the undivided family total.
    const namesOneObject = family.objectIds.length === 1
    const attributableObjectId =
      namesOneObject && loaded.has(family.objectIds[0]) ? family.objectIds[0] : null
    // Sorted for a stable path: the same family threads the same route on every render.
    const threadable = namesOneObject
      ? []
      : [...new Set(family.objectIds.filter(id => loaded.has(id)))].sort()

    for (const { category, milliseconds } of captured) {
      const routing = routeWaitCategory(category)
      if (routing.facility === null) {
        add(unmapped, category, milliseconds)
        continue
      }
      if (!namesOneObject && family.objectIds.length > 0) {
        // Nothing this family names is on the page, so there is no honest path to draw.
        if (threadable.length === 0) {
          add(shared, category, milliseconds)
          continue
        }
        const sharedId = `shared:${family.familyId}->${routing.facility}`
        const sharedLane = sharedLanes.get(sharedId) ?? {
          familyId: family.familyId,
          objectIds: threadable,
          namedObjectCount: new Set(family.objectIds).size,
          facility: routing.facility,
          milliseconds: 0n,
          categories: new Map<string, bigint>(),
          confidence: family.confidence,
        }
        sharedLane.milliseconds += milliseconds
        add(sharedLane.categories, category, milliseconds)
        sharedLanes.set(sharedId, sharedLane)
        continue
      }
      if (attributableObjectId === null) {
        add(unattributed, category, milliseconds)
        continue
      }

      const laneId = `${attributableObjectId}->${routing.facility}`
      const lane = lanes.get(laneId) ?? {
        objectId: attributableObjectId,
        facility: routing.facility,
        milliseconds: 0n,
        categories: new Map<string, bigint>(),
        familyIds: new Set<string>(),
        confidence: family.confidence,
      }
      lane.milliseconds += milliseconds
      add(lane.categories, category, milliseconds)
      lane.familyIds.add(family.familyId)
      if (CONFIDENCE_RANK[family.confidence] < CONFIDENCE_RANK[lane.confidence]) {
        lane.confidence = family.confidence
      }
      lanes.set(laneId, lane)
    }
  }

  return {
    lanes: [...lanes.entries()]
      .map(([laneId, lane]) => finish(laneId, lane, basis, unknownFamilyIds.length > 0))
      .sort(
        (left, right) =>
          compareDescending(left.waitMilliseconds, right.waitMilliseconds) ||
          left.laneId.localeCompare(right.laneId),
      ),
    sharedLanes: [...sharedLanes.entries()]
      .map(([laneId, lane]) => finishShared(laneId, lane, basis, unknownFamilyIds.length > 0))
      .sort(
        (left, right) =>
          compareDescending(left.waitMilliseconds, right.waitMilliseconds) ||
          left.laneId.localeCompare(right.laneId),
      ),
    unmapped: sortTotals(unmapped).map(total => ({
      ...total,
      reason: routeWaitCategory(total.category).reason,
    })),
    shared: sortTotals(shared),
    unattributed: sortTotals(unattributed),
    measuredFamilyCount,
    familyCount: families.length,
    basis,
    unknownFamilyIds,
    unclassifiedWaitMilliseconds: String(unclassifiedWait),
    note: `${trafficCoverageNote(families, basis)} `
      + (quietFamilyCount > 0 && quietFamilyCount === families.length
        ? 'All covered families report no executions and no waits, so no facility traffic is drawn.'
        : describe(measuredFamilyCount, families.length, sharedLanes.size))
      + (unknownFamilyIds.length > 0
        ? ` Partial category evidence: ${unknownFamilyIds.length} families are unknown; ${unclassifiedWait.toLocaleString()} measured wait ms have no usable breakdown.`
        : ''),
  }
}

interface MutableLane {
  objectId: string
  facility: FacilityKind
  milliseconds: bigint
  categories: Map<string, bigint>
  familyIds: Set<string>
  confidence: QueryAttributionConfidence
}

interface MutableSharedLane {
  familyId: string
  objectIds: readonly string[]
  namedObjectCount: number
  facility: FacilityKind
  milliseconds: bigint
  categories: Map<string, bigint>
  confidence: QueryAttributionConfidence
}

function finishShared(laneId: string, lane: MutableSharedLane, basis: TrafficBasis, partial: boolean): SharedFacilityLane {
  const categories = sortTotals(lane.categories)
  const label = FACILITY_LABELS[lane.facility]
  const saturated = lane.milliseconds > BigInt(LANE_WIDTH_SATURATION_MILLISECONDS)
  const offPageObjectCount = lane.namedObjectCount - lane.objectIds.length
  return {
    laneId,
    familyId: lane.familyId,
    objectIds: lane.objectIds,
    namedObjectCount: lane.namedObjectCount,
    offPageObjectCount,
    facility: lane.facility,
    facilityLabel: label,
    waitMilliseconds: lane.milliseconds.toString(),
    width: laneWidth(lane.milliseconds),
    saturated,
    color: LANE_COLORS[lane.facility],
    pattern: confidencePattern(lane.confidence as EdgeConfidence),
    confidence: lane.confidence,
    categories,
    rationale:
      `${trafficBasisLabel(basis)}. ${partial ? 'Partial category evidence; unknown families are excluded, not zero. ' : ''}` +
      `${lane.milliseconds.toLocaleString()} captured wait ms to the ${label} from query family ` +
      `${lane.familyId}, which names ${lane.namedObjectCount} objects ` +
      `(${categories.map(total => `${total.category} ${BigInt(total.waitMilliseconds).toLocaleString()} ms`).join(', ')}). ` +
      'This is the whole family total, drawn once along the objects it names: it is not divided ' +
      'between them and no single object waited this long on its own account. ' +
      (offPageObjectCount > 0
        ? `${offPageObjectCount} named object/objects are not on this page, so the drawn path is ` +
          'shorter than the relationship it stands for. '
        : '') +
      `Attribution is ${lane.confidence.toLocaleLowerCase()}; this is captured wait time, not live traffic.` +
      (saturated
        ? ' This lane exceeds the widest drawable value, so its width is a floor and only this figure is exact.'
        : ''),
  }
}

function finish(laneId: string, lane: MutableLane, basis: TrafficBasis, partial: boolean): FacilityLane {
  const categories = sortTotals(lane.categories)
  const familyIds = [...lane.familyIds].sort()
  const label = FACILITY_LABELS[lane.facility]
  const saturated = lane.milliseconds > BigInt(LANE_WIDTH_SATURATION_MILLISECONDS)
  return {
    laneId,
    objectId: lane.objectId,
    facility: lane.facility,
    facilityLabel: label,
    waitMilliseconds: lane.milliseconds.toString(),
    width: laneWidth(lane.milliseconds),
    saturated,
    color: LANE_COLORS[lane.facility],
    // QueryAttributionConfidence and EdgeConfidence share their three values by design, so lanes and
    // roads carry confidence in exactly the same visual channel.
    pattern: confidencePattern(lane.confidence as EdgeConfidence),
    confidence: lane.confidence,
    categories,
    familyIds,
    rationale:
      `${trafficBasisLabel(basis)}. ${partial ? 'Partial category evidence; unknown families are excluded, not zero. ' : ''}` +
      `${lane.milliseconds.toLocaleString()} captured wait ms to the ${label} from ` +
      `${familyIds.length} query family/families naming only this object ` +
      `(${categories.map(total => `${total.category} ${BigInt(total.waitMilliseconds).toLocaleString()} ms`).join(', ')}). ` +
      `Attribution is ${lane.confidence.toLocaleLowerCase()}; this is captured wait time, not live traffic.` +
      (saturated
        ? ' This lane exceeds the widest drawable value, so its width is a floor and only this figure is exact.'
        : ''),
  }
}

function describe(measured: number, total: number, sharedLaneCount: number): string {
  if (total === 0) {
    return 'No query family was returned for this page, so no wait lane is drawn and none is claimed.'
  }
  if (measured === 0) {
    return (
      `None of the ${total} ranked query families carried Query Store wait-category evidence, so no ` +
      'lane is drawn. sys.query_store_wait_stats does not exist before SQL Server 2017 (14.x); an ' +
      'absent breakdown is not evidence that nothing waited.'
    )
  }
  return (
    `${measured} of ${total} ranked query families carried wait-category evidence. A family naming ` +
    'one loaded object draws a lane from that building. A family naming several draws one shared ' +
    'lane threaded through each of them, carrying the whole family total exactly once: shared lanes ' +
    'are never divided between the objects and never added into a per-object total. ' +
    (sharedLaneCount > 0 ? `${sharedLaneCount} shared lane/lanes are drawn. ` : '') +
    'Wait time from families naming nothing on this page is reported separately rather than assigned.'
  )
}

function categoryTotals(
  source: Readonly<Record<string, string>> | null,
): Array<{ category: string; milliseconds: bigint }> {
  if (!source) return []
  const totals: Array<{ category: string; milliseconds: bigint }> = []
  for (const [category, value] of Object.entries(source)) {
    const milliseconds = toBigInt(value)
    if (milliseconds === null || milliseconds <= 0n) continue
    totals.push({ category, milliseconds })
  }
  return totals
}

function add(totals: Map<string, bigint>, key: string, value: bigint): void {
  totals.set(key, (totals.get(key) ?? 0n) + value)
}

function sortTotals(totals: ReadonlyMap<string, bigint>): CategoryTotal[] {
  return [...totals.entries()]
    .map(([category, milliseconds]) => ({ category, waitMilliseconds: milliseconds.toString() }))
    .sort(
      (left, right) =>
        compareDescending(left.waitMilliseconds, right.waitMilliseconds) ||
        left.category.localeCompare(right.category),
    )
}

function compareDescending(left: string, right: string): number {
  const a = BigInt(left)
  const b = BigInt(right)
  return a === b ? 0 : a > b ? -1 : 1
}

/** Wait totals are lossless base-10 strings, so they are parsed defensively and never coerced to 0. */
function toBigInt(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return null
  return BigInt(trimmed)
}
