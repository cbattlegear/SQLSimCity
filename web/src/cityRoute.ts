import type { NormalizedShowplan, ShowplanNode, ShowplanObjectReference } from './contracts'
import type { DatabaseCityObject } from './databaseCityContracts'
import type { CityPlan } from './cityPlan'
import { streetPolyline } from './cityPlan'
import { FACILITY_LABELS, type FacilityKind } from './cityInfrastructure'
import { planCostSplit } from './planCost'

/**
 * Turns a compiled query plan into a driving route through the city.
 *
 * A route visits **buildings**. Nothing else is a place.
 *
 * It used to visit the civic wait facilities too, so a two-table join was drawn as a detour: read
 * Orders, drive across town to the Memory Grant Office, drive back for Customers. No query does that.
 * A hash join is not somewhere the query *goes*; it is work done on rows that two tables produced, and
 * the honest place to draw it is at the tables it drew from. So every operator still appears — nothing
 * is dropped — but an operator that names no object is folded onto the stop whose subtree it consumed
 * from, and the resource it wanted is recorded on it rather than becoming a place of its own.
 *
 * What is left is the journey a query actually makes: table to table, in the order rows flow.
 *
 * The facilities are still on the map and still measure something real — which *resource* the
 * instance waited on — but that is a different question from which *table* was involved, and mixing
 * the two into one path made neither legible.
 *
 * This describes the plan's *compiled shape*, never live operator progress. Callers must surface
 * {@link NormalizedShowplan.runtimeOverlayCaveat} verbatim next to the route.
 */

export type StopKind = 'building' | 'offmap'

/** Physical operators that request a memory grant. */
export const MEMORY_GRANT_OPERATORS: ReadonlySet<string> = new Set([
  'Sort',
  'Hash Match',
  'Adaptive Join',
  'Window Aggregate',
])

/** Spools materialize into tempdb rather than a query memory grant. */
export const TEMPDB_OPERATORS: ReadonlySet<string> = new Set([
  'Table Spool',
  'Index Spool',
  'Row Count Spool',
  'Window Spool',
])

/** One operator, at the stop where its work belongs. */
export interface RouteOperation {
  readonly nodeId: number
  readonly physicalOperation: string
  readonly logicalOperation: string
  readonly estimatedRows: number | null
  readonly estimatedCpuCost: number | null
  readonly estimatedIoCost: number | null
  /** True when this operator itself named the object; false when its work was folded onto the stop. */
  readonly readsHere: boolean
  /** The resource this operator leans on. Answers "which facility", not "where does it drive". */
  readonly resource: FacilityKind
  /** Set when the operator named a specific index. */
  readonly indexName: string | null
  readonly instruction: string
  readonly warnings: readonly string[]
}

export interface RouteStop {
  /** 1-based position along the route, matching the numbered map pins. */
  readonly ordinal: number
  readonly kind: StopKind
  readonly label: string
  /** Set for `building` stops. */
  readonly objectId: string | null
  /** Every index the plan named at this stop, in first-seen order. */
  readonly indexNames: readonly string[]
  readonly x: number | null
  readonly z: number | null
  /** The operators whose work happens here, in the order rows flow. Never empty. */
  readonly operations: readonly RouteOperation[]
  /**
   * Share of the plan's estimated cost that fell to this stop, 0..1.
   *
   * The optimizer's arithmetic about work it expected to do — not a measurement of work done.
   */
  readonly estimatedCostShare: number
  /** Turn-by-turn line shown in the route panel. */
  readonly instruction: string
  /** Present on `offmap` stops: why this object has no place on the map. */
  readonly unresolvedReason: string | null
  readonly warnings: readonly string[]
}

/**
 * An index the optimizer asked for, resolved against the city where possible.
 *
 * Plan-level, not per-stop: `<MissingIndexes>` is written before the first `<RelOp>`, so it belongs
 * to no operator and cannot be read off a stop's warnings. `objectId` is null when the suggestion
 * names a table this page does not hold — a cross-database reference, or an object on another page.
 */
export interface RouteMissingIndex {
  readonly objectId: string | null
  readonly label: string
  /** The optimizer's own estimate of how much cheaper the query would be, 0..100. */
  readonly impactPercent: number | null
  readonly equalityColumns: readonly string[]
  readonly inequalityColumns: readonly string[]
  readonly includedColumns: readonly string[]
}

export interface CityRoute {
  readonly planId: string
  readonly stops: readonly RouteStop[]
  /** World-space polyline following the street graph. Empty when no stop could be placed. */
  readonly polyline: ReadonlyArray<{ x: number; z: number }>
  /** Stops that could not be placed on the map, surfaced rather than hidden. */
  readonly offMapStops: readonly RouteStop[]
  /**
   * Operators belonging to no table at all — compute over constants, a final Select, plan-level work.
   * Listed rather than dropped, and given no place on the map because they have none.
   */
  readonly unplacedOperations: readonly RouteOperation[]
  /** Share of the plan's estimated cost that reached no building, 0..1. */
  readonly estimatedCostUnattributed: number
  /** Copied verbatim from the plan; never paraphrased. */
  readonly runtimeOverlayCaveat: string
  /**
   * Indexes the optimizer asked for. Empty both when the plan asked for none and when the plan was
   * normalized by a build that did not read them; `missingIndexesObserved` tells those apart.
   */
  readonly missingIndexes: readonly RouteMissingIndex[]
  /** False when the plan carries no missing-index evidence at all, so "none" is not claimed. */
  readonly missingIndexesObserved: boolean
}

export interface RouteContext {
  readonly plan: CityPlan
  readonly objects: readonly DatabaseCityObject[]
  /** Name of the database this city page was loaded for, used to detect cross-database references. */
  readonly databaseName: string
}

/** Post-order operator sequence: children in ascending node id, then the parent. */
export function operatorSequence(nodes: readonly ShowplanNode[]): ShowplanNode[] {
  if (nodes.length === 0) return []
  const byId = new Map<number, ShowplanNode>()
  for (const node of nodes) byId.set(node.nodeId, node)

  const children = new Map<number, number[]>()
  const roots: number[] = []
  for (const node of nodes) {
    if (node.parentNodeId === null || !byId.has(node.parentNodeId)) {
      roots.push(node.nodeId)
      continue
    }
    const bucket = children.get(node.parentNodeId)
    if (bucket) bucket.push(node.nodeId)
    else children.set(node.parentNodeId, [node.nodeId])
  }
  for (const bucket of children.values()) bucket.sort((a, b) => a - b)
  roots.sort((a, b) => a - b)

  const ordered: ShowplanNode[] = []
  const seen = new Set<number>()
  const walk = (nodeId: number): void => {
    if (seen.has(nodeId)) return
    seen.add(nodeId)
    for (const child of children.get(nodeId) ?? []) walk(child)
    const node = byId.get(nodeId)
    if (node) ordered.push(node)
  }
  for (const root of roots) walk(root)
  // A malformed tree (a cycle among parent links) must not lose operators.
  for (const node of nodes) if (!seen.has(node.nodeId)) ordered.push(node)
  return ordered
}

/** Strips showplan bracket quoting: `[dbo]` -> `dbo`. */
export function unquote(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed
}

/**
 * Matches a showplan object reference to a loaded city object by `schema.table`, case-insensitively
 * and ignoring bracket quoting. Returns null when the reference names another database or an object
 * outside the loaded page -- both of which become explicit off-map stops.
 */
export function matchObject(
  reference: ShowplanObjectReference,
  objects: readonly DatabaseCityObject[],
  databaseName: string,
): DatabaseCityObject | null {
  const database = unquote(reference.database)
  if (database !== null && database.toLowerCase() !== databaseName.toLowerCase()) return null
  const schema = unquote(reference.schema)
  const table = unquote(reference.table)
  if (table === null) return null
  const wanted = `${schema ?? ''}.${table}`.toLowerCase()
  return (
    objects.find(object => `${object.schemaName}.${object.name}`.toLowerCase() === wanted) ??
    (schema === null
      ? objects.find(object => object.name.toLowerCase() === table.toLowerCase()) ?? null
      : null)
  )
}

/**
 * The resource an operator leans on: which civic facility would see its wait, if it waited.
 *
 * This is a property recorded *on* the operator, at the table where its work happens. It is no longer
 * a destination — an operator does not travel to a facility.
 */
export function facilityForOperator(node: ShowplanNode): FacilityKind {
  if (MEMORY_GRANT_OPERATORS.has(node.physicalOperation)) return 'memory'
  if (TEMPDB_OPERATORS.has(node.physicalOperation)) return 'tempdb'
  if ((node.estimatedIoCost ?? 0) > 0) return 'storage'
  return 'cpu'
}

interface StopKey {
  /** Stable identity: an objectId for a placed building, or a described reference for an off-map one. */
  readonly key: string
  readonly kind: StopKind
  readonly object: DatabaseCityObject | null
  readonly reference: ShowplanObjectReference
}

function ownCost(node: ShowplanNode): number {
  return (node.estimatedCpuCost ?? 0) + (node.estimatedIoCost ?? 0)
}

/**
 * Builds the ordered stop list: one stop per table the plan reads, in the order rows flow.
 *
 * An operator that names no object is attached to the heaviest object beneath it — the table its rows
 * mostly came from. That keeps a join with the input it is really about, rather than stranding it or
 * giving it a place of its own.
 */
export function planStops(showplan: NormalizedShowplan, context: RouteContext): RouteStop[] {
  return buildStops(showplan, context).stops
}

interface Built {
  readonly stops: RouteStop[]
  readonly unplaced: RouteOperation[]
}

function buildStops(showplan: NormalizedShowplan, context: RouteContext): Built {
  const sequence = operatorSequence(showplan.nodes)
  if (sequence.length === 0) return { stops: [], unplaced: [] }

  const byId = new Map<number, ShowplanNode>()
  for (const node of showplan.nodes) byId.set(node.nodeId, node)
  const children = new Map<number, number[]>()
  for (const node of showplan.nodes) {
    const parent = node.parentNodeId
    if (parent === null || parent === node.nodeId || !byId.has(parent)) continue
    const bucket = children.get(parent)
    if (bucket) bucket.push(node.nodeId)
    else children.set(parent, [node.nodeId])
  }

  const keyOf = new Map<number, StopKey>()
  const keys = new Map<string, StopKey>()
  for (const node of showplan.nodes) {
    if (node.objectReference === null) continue
    const matched = matchObject(node.objectReference, context.objects, context.databaseName)
    const key = matched ? matched.objectId : `offmap:${describeReference(node.objectReference)}`
    const existing = keys.get(key)
    const entry: StopKey = existing ?? {
      key,
      kind: matched ? 'building' : 'offmap',
      object: matched,
      reference: node.objectReference,
    }
    keys.set(key, entry)
    keyOf.set(node.nodeId, entry)
  }

  // Heaviest table beneath each operator, computed children-first so a parent can read its children's
  // answers. Weight is own cost, or a count of reads when a plan reports no cost at all.
  const owner = new Map<number, StopKey | null>()
  const weight = new Map<number, Map<string, number>>()
  for (const node of sequence) {
    const totals = new Map<string, number>()
    for (const childId of children.get(node.nodeId) ?? []) {
      for (const [key, value] of weight.get(childId) ?? []) {
        totals.set(key, (totals.get(key) ?? 0) + value)
      }
    }
    const own = keyOf.get(node.nodeId)
    if (own) totals.set(own.key, (totals.get(own.key) ?? 0) + Math.max(ownCost(node), 1e-9))
    weight.set(node.nodeId, totals)

    if (own) {
      owner.set(node.nodeId, own)
      continue
    }
    let best: string | null = null
    let bestValue = -1
    for (const [key, value] of totals) {
      // Ties resolve by key so the fold never depends on map insertion order.
      if (value > bestValue || (value === bestValue && best !== null && key < best)) {
        bestValue = value
        best = key
      }
    }
    owner.set(node.nodeId, best === null ? null : keys.get(best) ?? null)
  }

  const split = planCostSplit(showplan)
  const shareByKey = new Map<string, number>()
  if (split.total > 0) {
    for (const entry of split.objects) {
      // Two index-keyed references to one table resolve to one building, so their shares merge here.
      const matched = matchObject(entry.reference, context.objects, context.databaseName)
      const key = matched ? matched.objectId : `offmap:${describeReference(entry.reference)}`
      shareByKey.set(key, (shareByKey.get(key) ?? 0) + entry.cost / split.total)
    }
  }

  const collected = new Map<string, RouteOperation[]>()
  const order: string[] = []
  const unplaced: RouteOperation[] = []
  for (const node of sequence) {
    const stopKey = owner.get(node.nodeId) ?? null
    const operation = operationFor(node, stopKey, showplan, context)
    if (stopKey === null) {
      unplaced.push(operation)
      continue
    }
    const bucket = collected.get(stopKey.key)
    if (bucket) bucket.push(operation)
    else {
      collected.set(stopKey.key, [operation])
      order.push(stopKey.key)
    }
  }

  const stops: RouteStop[] = []
  order.forEach((key, index) => {
    const entry = keys.get(key)!
    const operations = collected.get(key)!
    const indexNames: string[] = []
    for (const operation of operations) {
      if (operation.indexName !== null && !indexNames.includes(operation.indexName)) {
        indexNames.push(operation.indexName)
      }
    }
    const warnings = operations.flatMap(operation => operation.warnings)
    const lot = entry.object ? context.plan.lots.get(entry.object.objectId) : undefined
    const label = entry.object
      ? `${entry.object.schemaName}.${entry.object.name}`
      : describeReference(entry.reference)
    stops.push({
      ordinal: index + 1,
      kind: entry.kind,
      label,
      objectId: entry.object?.objectId ?? null,
      indexNames,
      x: lot?.accessX ?? null,
      z: lot?.accessZ ?? null,
      operations,
      estimatedCostShare: shareByKey.get(key) ?? 0,
      instruction: stopInstruction(label, entry.kind, operations, indexNames),
      unresolvedReason:
        entry.kind === 'offmap' ? unresolvedReason(entry.reference, context.databaseName) : null,
      warnings,
    })
  })

  return { stops, unplaced }
}

function operationFor(
  node: ShowplanNode,
  stopKey: StopKey | null,
  showplan: NormalizedShowplan,
  context: RouteContext,
): RouteOperation {
  const resource = facilityForOperator(node)
  const readsHere = node.objectReference !== null
  const indexName = node.objectReference === null ? null : unquote(node.objectReference.index)
  return {
    nodeId: node.nodeId,
    physicalOperation: node.physicalOperation,
    logicalOperation: node.logicalOperation,
    estimatedRows: node.estimatedRows,
    estimatedCpuCost: node.estimatedCpuCost,
    estimatedIoCost: node.estimatedIoCost,
    readsHere,
    resource,
    indexName,
    instruction: operationInstruction(node, stopKey, resource, indexName, showplan, context),
    warnings: node.warnings.map(warning =>
      warning.detail === null ? warning.kind : `${warning.kind}: ${warning.detail}`,
    ),
  }
}

function operationInstruction(
  node: ShowplanNode,
  stopKey: StopKey | null,
  resource: FacilityKind,
  indexName: string | null,
  showplan: NormalizedShowplan,
  context: RouteContext,
): string {
  const rows =
    node.estimatedRows === null ? '' : `, estimating ${formatRows(node.estimatedRows)} row(s)`

  if (node.objectReference !== null) {
    const matched = matchObject(node.objectReference, context.objects, context.databaseName)
    const label = matched
      ? `${matched.schemaName}.${matched.name}`
      : `${describeReference(node.objectReference)} (off this map)`
    return (
      `${node.physicalOperation} at ${label}` +
      (indexName === null ? '' : ` using ${indexName}`) +
      rows
    )
  }

  const where = stopKey === null ? '' : ` on rows from ${stopLabel(stopKey)}`
  switch (resource) {
    case 'memory': {
      const requested =
        showplan.serialDesiredMemoryKiB === null
          ? 'an unreported grant'
          : `${formatRows(showplan.serialDesiredMemoryKiB)} KiB (plan-level serial desired memory)`
      return `${node.physicalOperation}${where}, wanting ${requested} from the ${FACILITY_LABELS.memory}${rows}`
    }
    case 'tempdb':
      return `${node.physicalOperation}${where}, materializing through ${FACILITY_LABELS.tempdb}${rows}`
    case 'storage':
      return (
        `${node.physicalOperation}${where}, reading through the ${FACILITY_LABELS.storage}` +
        (node.estimatedIoCost === null ? '' : `, estimated I/O cost ${node.estimatedIoCost}`) +
        rows
      )
    default:
      return (
        `${node.physicalOperation}${where}` +
        (node.estimatedCpuCost === null ? '' : `, estimated CPU cost ${node.estimatedCpuCost}`) +
        rows
      )
  }
}

function stopLabel(stopKey: StopKey): string {
  return stopKey.object
    ? `${stopKey.object.schemaName}.${stopKey.object.name}`
    : describeReference(stopKey.reference)
}

function stopInstruction(
  label: string,
  kind: StopKind,
  operations: readonly RouteOperation[],
  indexNames: readonly string[],
): string {
  const reads = operations.filter(operation => operation.readsHere)
  const lead = reads.length > 0 ? reads[0].physicalOperation : operations[0].physicalOperation
  const place = kind === 'offmap' ? `${label} (off this map)` : label
  const using = indexNames.length === 0 ? '' : ` using ${indexNames.join(', ')}`
  const extra = operations.length - 1
  const also = extra <= 0 ? '' : `, then ${extra} more operation${extra === 1 ? '' : 's'} here`
  return `${lead} at ${place}${using}${also}`
}

function describeReference(reference: ShowplanObjectReference): string {
  const parts = [unquote(reference.database), unquote(reference.schema), unquote(reference.table)]
    .filter((part): part is string => part !== null)
  return parts.length === 0 ? 'an unnamed object' : parts.join('.')
}

function unresolvedReason(reference: ShowplanObjectReference, databaseName: string): string {
  const database = unquote(reference.database)
  if (database !== null && database.toLowerCase() !== databaseName.toLowerCase()) {
    return `This operator reads ${describeReference(reference)}, which is in database "${database}" rather than "${databaseName}". Load that database's city to see the building.`
  }
  return `${describeReference(reference)} is not in the currently loaded page of objects, so it has no building yet. Load more objects to place it.`
}

/** Route polyline following the street graph between consecutive placed stops. */
export function routeThroughStreets(
  stops: readonly RouteStop[],
  plan: CityPlan,
): Array<{ x: number; z: number }> {
  const placed = stops.filter(
    (stop): stop is RouteStop & { x: number; z: number } => stop.x !== null && stop.z !== null,
  )
  if (placed.length === 0) return []
  const points: Array<{ x: number; z: number }> = [{ x: placed[0].x, z: placed[0].z }]
  for (let index = 1; index < placed.length; index += 1) {
    const from = placed[index - 1]
    const to = placed[index]
    if (from.x === to.x && from.z === to.z) continue
    const leg = streetPolyline(plan, from, to)
    for (const point of leg.slice(1)) points.push(point)
  }
  return points
}

export function buildCityRoute(showplan: NormalizedShowplan, context: RouteContext): CityRoute {
  const { stops, unplaced } = buildStops(showplan, context)
  const split = planCostSplit(showplan)
  let placedShare = 0
  for (const stop of stops) if (stop.kind === 'building') placedShare += stop.estimatedCostShare
  return {
    planId: showplan.planId,
    stops,
    polyline: routeThroughStreets(stops, context.plan),
    offMapStops: stops.filter(stop => stop.kind === 'offmap'),
    unplacedOperations: unplaced,
    estimatedCostUnattributed:
      split.total > 0 ? Math.max(0, Math.min(1, 1 - placedShare)) : 0,
    runtimeOverlayCaveat: showplan.runtimeOverlayCaveat,
    missingIndexes: buildMissingIndexes(showplan, context),
    missingIndexesObserved: showplan.missingIndexes !== undefined,
  }
}

function buildMissingIndexes(
  showplan: NormalizedShowplan,
  context: RouteContext,
): RouteMissingIndex[] {
  return (showplan.missingIndexes ?? []).map(missing => {
    const matched = matchObject(
      { database: missing.database, schema: missing.schema, table: missing.table, index: null },
      context.objects,
      context.databaseName,
    )
    return {
      objectId: matched?.objectId ?? null,
      label: matched
        ? `${matched.schemaName}.${matched.name}`
        : describeReference({
            database: missing.database,
            schema: missing.schema,
            table: missing.table,
            index: null,
          }),
      impactPercent: missing.impactPercent,
      equalityColumns: (missing.equalityColumns ?? []).map(column => unquote(column) ?? column),
      inequalityColumns: (missing.inequalityColumns ?? []).map(column => unquote(column) ?? column),
      includedColumns: (missing.includedColumns ?? []).map(column => unquote(column) ?? column),
    }
  })
}

function formatRows(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 })
}
