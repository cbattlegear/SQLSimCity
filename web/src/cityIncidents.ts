import type { DatabaseCityObject } from './databaseCityContracts'
import type { BlockingReference, DeadlockResource, DeadlockSample, LiveIncidentSnapshot, LiveRequest, LockResource, WaitingTask } from './liveContracts'
import { isBlockedReference } from './liveIncidents'

/**
 * Turns a live snapshot into map pins.
 *
 * The rule that governs every function here is the same rule the rest of the app follows: a
 * subsystem that could not be sampled produces **no marker**, never a "clear" one. An empty map is
 * "nothing was observed", which is not the same claim as "nothing is wrong", and the popup says
 * which of the two it is.
 *
 * A marker is only ever anchored to a building the map is actually drawing. A live wait that
 * resolves to an object outside the loaded bounded page is real, and is counted, but it has nowhere
 * to be drawn — so it is reported as an off-map count rather than pinned to the wrong lot.
 */

export type IncidentSeverity = 'blocked' | 'waiting' | 'cycle' | 'deadlock'

export interface IncidentMarker {
  readonly id: string
  readonly objectId: string
  /**
   * Other loaded objects this same incident named — the object a blocking session was itself
   * waiting on, or the second resource in a recorded deadlock. Used to put the pin on the road
   * *between* the two rather than on one of them; see {@link ./cityIncidentPlacement}. Usually
   * empty for a plain block, because a session that holds a lock and waits for nothing never
   * appears in the waiting DMVs and so names no object.
   */
  readonly counterpartObjectIds: readonly string[]
  /**
   * The sessions this incident names. One for a live block or cycle; the victim sessions a recorded
   * deadlock graph named, which may be none.
   *
   * Carried so a live sample can be matched back to the pin it produced rather than re-derived —
   * see `cityVehicles.ts`, which stops a blocked request's vehicle at this pin. A recorded deadlock
   * is history and its sessions are gone, so a reader of this field has to keep `severity` in mind:
   * a `deadlock` entry names who was rolled back, not who is waiting now.
   */
  readonly sessionIds: readonly number[]
  readonly severity: IncidentSeverity
  /** One line naming what is happening. Never a judgement, always the observation. */
  readonly headline: string
  /** The measured facts behind the headline, each already formatted for display. */
  readonly details: readonly string[]
  /** Where this came from and when it was observed. Shown in the popup, always. */
  readonly source: string
  readonly observedAt: string
}

export interface IncidentProjection {
  readonly markers: readonly IncidentMarker[]
  /**
   * Live waits that resolved to a real object that this bounded page has not loaded. Counted so the
   * absence of a pin is never read as the absence of a problem.
   */
  readonly offPageCount: number
  /**
   * Waits that were sampled but could not name an object at all, with the parser's reason. A page
   * lock or a database lock lands here rather than being guessed onto a building.
   */
  readonly unresolved: ReadonlyArray<{ readonly rawResource: string; readonly reason: string }>
  /**
   * False when the snapshot carried no evidence for this at all — no snapshot, a failed collection,
   * or a lock-resource probe that never ran. The UI must say "not observed", not "none".
   */
  readonly probeReported: boolean
  /**
   * What the `system_health` deadlock reader reported, kept apart from `probeReported` because the
   * two subsystems fail independently: blocking comes from the request and waiting-task DMVs and
   * deadlocks come from an extended-events session that Azure SQL Database does not have at all.
   *
   * `observed` false means the reader did not run or could not run, and the UI must render "not
   * observed" rather than "no deadlocks" — those are different claims and only one of them is
   * supported. `retainedCount` is the count before any cap, so a capped list is never read as a
   * calmer instance.
   */
  readonly deadlocks: {
    readonly observed: boolean
    readonly graphCount: number
    readonly retainedCount: number
    readonly pinnedCount: number
    readonly reason: string
  }
  /** Why the projection is empty or partial, in the collector's own words. */
  readonly reason: string
}

/**
 * Blocked waiters the probe saw but the map could not put a pin on: their object is outside this
 * bounded page, or their lock resource named no object at all.
 */
export function incidentUnpinnedCount(projection: IncidentProjection): number {
  return projection.offPageCount + projection.unresolved.length
}

/**
 * What a folded, one-line summary of this projection says.
 *
 * On a narrow viewport this string may be the entire blocking probe a reader ever sees, so it has to
 * carry the finding rather than just name the panel. The case that matters is an empty marker list
 * with a non-zero unpinned count: the probe *did* see blocked waiters, the map just could not place
 * them. Calling that "No blocks" would turn a partial answer into an all-clear, which is exactly the
 * claim this codebase refuses to make.
 */
export function incidentSummaryLabel(projection: IncidentProjection): string {
  if (!projection.probeReported) return 'Not observed'
  if (projection.markers.length > 0) return `${projection.markers.length} blocked`
  const unpinned = incidentUnpinnedCount(projection)
  if (unpinned > 0) return `${unpinned} off-map`
  return 'No blocks'
}

/** The tone class for {@link incidentSummaryLabel}: alert for pins, unknown for anything unclaimed. */
export function incidentSummaryTone(projection: IncidentProjection): 'is-alert' | 'is-unknown' | '' {
  if (!projection.probeReported) return 'is-unknown'
  if (projection.markers.length > 0) return 'is-alert'
  return incidentUnpinnedCount(projection) > 0 ? 'is-unknown' : ''
}

/** True when this projection has something to say that a reader should not have to tap to find. */
export function incidentDemandsAttention(projection: IncidentProjection): boolean {
  return !projection.probeReported
    || projection.markers.length > 0
    || incidentUnpinnedCount(projection) > 0
    || !projection.deadlocks.observed
    || projection.deadlocks.retainedCount > 0
}

/**
 * What a folded, one-line summary of the deadlock reader says.
 *
 * "Not observed" and "none in window" are the two claims that must never be collapsed into each
 * other. The first means the reader could not run — Azure SQL Database has no `system_health`
 * session, and a login without `VIEW SERVER STATE` cannot read one that exists. The second means it
 * ran and the retained window held nothing, which still does not mean the instance never deadlocks,
 * because `system_health` rolls its files over.
 */
export function deadlockSummaryLabel(projection: IncidentProjection): string {
  const { observed, graphCount, retainedCount } = projection.deadlocks
  if (!observed) return 'Not observed'
  if (retainedCount === 0) return 'None in window'
  if (retainedCount > graphCount) return `${graphCount} of ${retainedCount} retained`
  return `${graphCount} retained`
}

/** The tone class for {@link deadlockSummaryLabel}. */
export function deadlockSummaryTone(projection: IncidentProjection): 'is-alert' | 'is-unknown' | '' {
  if (!projection.deadlocks.observed) return 'is-unknown'
  return projection.deadlocks.retainedCount > 0 ? 'is-alert' : ''
}

/**
 * Whether a vehicle that reaches this marker should stop at it.
 *
 * The rule is about *time*, not about severity ranking: three of the four severities describe
 * something happening right now, and `deadlock` describes something the engine already finished.
 * A recorded deadlock graph names the sessions that took part, but by the time the graph is
 * readable the victim has been killed and the winner has moved on — and SQL Server recycles
 * session ids, so a live session carrying the same number as one named in the graph is very
 * probably an unrelated request that merely inherited the id. Parking a running query at that pin
 * would claim it is caught in a deadlock that is over and was never its own.
 *
 * `waiting` and `cycle` must keep stopping traffic. A cycle is the weaker observation of the two —
 * the engine kills the victim before `sys.dm_exec_requests` can sample the whole ring — but both
 * are drawn from sessions that are still on the instance, so the vehicle and the pin refer to the
 * same request.
 *
 * Exported, rather than inlined at the one call site in `DatabaseCityScene.ts`, so the rule can be
 * tested across all four severities directly. Inline it and the only thing describing it is a
 * comment, which no suite reads.
 */
export function stopsTraffic(marker: Pick<IncidentMarker, 'severity'>): boolean {
  return marker.severity !== 'deadlock'
}

const DEADLOCKS_NOT_OBSERVED = {
  observed: false,
  graphCount: 0,
  retainedCount: 0,
  pinnedCount: 0,
  reason: 'The system_health deadlock reader has not reported, so nothing is claimed about deadlocks.',
} as const

const NOT_OBSERVED: IncidentProjection = {
  markers: [],
  offPageCount: 0,
  unresolved: [],
  probeReported: false,
  deadlocks: DEADLOCKS_NOT_OBSERVED,
  reason: 'No live snapshot has been received, so nothing is claimed about current activity.',
}

/** Only a *blocked* waiter is an incident. Holding a lock nobody waits behind is just work. */
function isBlocked(blocking: BlockingReference): boolean {
  return isBlockedReference(blocking)
}

/**
 * The database segment shared by every object id on this page, lowercased.
 *
 * City object ids are addressed by name — `primary/database/SimCitySmall/object/901578250` — while
 * a lock resource carries a per-instance `database_id`. The two cannot be compared, so the page
 * states its own database from the ids it already holds and the live sample is matched against that
 * by name instead. Null when the page is empty or the ids are not in that shape, which switches the
 * numeric join off rather than guessing.
 */
function pageDatabaseName(objects: readonly DatabaseCityObject[]): string | null {
  for (const object of objects) {
    const match = /\/database\/([^/]+)\/object\//.exec(object.objectId)
    if (match) return match[1].toLocaleLowerCase()
  }
  return null
}

function objectKeys(object: DatabaseCityObject): string[] {
  const keys = [
    object.objectId.toLocaleLowerCase(),
    `${object.schemaName}.${object.name}`.toLocaleLowerCase(),
  ]
  const numeric = numericObjectId(object.objectId)
  if (numeric !== null) keys.push(`object/${numeric}`)
  return keys
}

/**
 * The trailing `object_id` in a city object id such as
 * `primary/database/SimCitySmall/object/901578250`.
 *
 * This exists because an `OBJECT:`/`TAB:` lock is the one form the parser resolves with **no
 * catalog lookup at all** — it reads the ids straight out of the wait resource text and leaves
 * `schemaName`/`objectName` empty by design. So the name join those locks would need is never
 * populated, and a table-level block could only ever be matched numerically.
 */
function numericObjectId(objectId: string): string | null {
  const marker = objectId.lastIndexOf('/object/')
  if (marker < 0) return null
  const tail = objectId.slice(marker + '/object/'.length)
  return /^\d+$/.test(tail) ? tail : null
}

function waitMs(value: number | string | null): number | null {
  if (value === null) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function formatMs(value: number | null): string {
  if (value === null) return 'wait duration not reported'
  if (value < 1000) return `${Math.round(value)} ms waited`
  return `${(value / 1000).toFixed(1)} s waited`
}

/**
 * Builds the marker set for one bounded page of objects.
 *
 * `sessionsInCycle` comes from the blocking graph's detected cycles. SQL Server does not report a
 * deadlock in `sys.dm_exec_requests` — a deadlock is already resolved by the time you could see it —
 * so a cycle in the *current* wait graph is reported as exactly that: a cycle, not a deadlock
 * verdict. The severity is named `deadlock` because that is the shape being drawn, and the popup
 * text says precisely what was measured.
 */
export function projectIncidents(
  snapshot: LiveIncidentSnapshot | null,
  objects: readonly DatabaseCityObject[],
): IncidentProjection {
  if (!snapshot) return NOT_OBSERVED
  if (snapshot.status !== 'Available' && snapshot.status !== 'Stale') {
    return {
      markers: [],
      offPageCount: 0,
      unresolved: [],
      probeReported: false,
      deadlocks: DEADLOCKS_NOT_OBSERVED,
      reason: `Live collection reported ${snapshot.status}: ${snapshot.reason}`,
    }
  }

  const byKey = new Map<string, string>()
  for (const object of objects) {
    for (const key of objectKeys(object)) byKey.set(key, object.objectId)
  }

  const sessionsInCycle = new Set<number>()
  for (const cycle of snapshot.blockingGraph.cycles) {
    for (const nodeId of cycle) {
      const node = snapshot.blockingGraph.nodes.find(candidate => candidate.nodeId === nodeId)
      if (node?.sessionId !== null && node?.sessionId !== undefined) sessionsInCycle.add(node.sessionId)
    }
  }

  const observedAt = snapshot.sourceTimestamp ?? snapshot.collectedAt
  const markers: IncidentMarker[] = []
  const unresolved: { rawResource: string; reason: string }[] = []
  let offPageCount = 0
  let probeReported = false
  // One marker per object: the worst wait wins the pin, and the rest become detail lines.
  const byObject = new Map<string, IncidentMarker>()

  /*
   * Which database each sampled session was running in, and which one this page draws.
   *
   * Needed because an `OBJECT:` lock resolves to a bare `object_id`, and an `object_id` is unique
   * only inside its own database — instance-wide it is just a number, and two databases on the same
   * server routinely reuse one. `sys.dm_os_waiting_tasks` reports no database at all, so a waiting
   * task borrows its own session's request: a task is a worker inside a request, and both are in
   * the same sample.
   */
  const databaseBySession = new Map<number, string>()
  for (const request of snapshot.requests) {
    if (request.databaseName) {
      databaseBySession.set(request.sessionId, request.databaseName.toLocaleLowerCase())
    }
  }
  const pageDatabase = pageDatabaseName(objects)

  /**
   * The loaded object a resolved lock names, or null when this page cannot place it.
   *
   * The name join is tried first and needs no gate: `schemaName`/`objectName` are only ever
   * populated by the `sessions.lock_resource_objects` probe, which ran against one database. The
   * numeric join is the fallback for the `OBJECT:`/`TAB:` forms the parser reads straight out of
   * the wait-resource text without any lookup — those carry no names at all, so before this existed
   * a table-level block could never match a building and was counted off-map every time.
   *
   * The numeric key deliberately does not carry `lock.databaseId`. That field is a per-instance
   * `database_id` like `6`, while a city object id is addressed by name, so pairing them built a
   * key of the form `6/object/901578250` that no object id could match under any circumstance.
   * The database is established here by name instead, which is a check the key could never be.
   */
  function resolveLockObject(lock: LockResource, sessionId: number): string | null {
    if (lock.schemaName && lock.objectName) {
      const named = byKey.get(`${lock.schemaName}.${lock.objectName}`.toLocaleLowerCase())
      if (named) return named
    }
    if (lock.objectId === null) return null
    const sessionDatabase = databaseBySession.get(sessionId)
    if (pageDatabase === null || sessionDatabase !== pageDatabase) return null
    return byKey.get(`object/${lock.objectId}`.toLocaleLowerCase()) ?? null
  }

  // Which loaded object each sampled session is itself waiting on. A blocking session that appears
  // in the sample as a waiter of its own — the middle of an A→B→C chain — is the one case where the
  // block's *other* end can be named, and it is what lets the pin sit on the road between them.
  const objectBySession = new Map<number, string>()
  const noteSessionObject = (source: LiveRequest | WaitingTask) => {
    const lock = source.lockResource
    if (!lock || lock.status !== 'Resolved') return
    const objectId = resolveLockObject(lock, source.sessionId)
    if (objectId) objectBySession.set(source.sessionId, objectId)
  }
  for (const request of snapshot.requests) noteSessionObject(request)
  for (const task of snapshot.waitingTasks) noteSessionObject(task)

  const consider = (
    source: LiveRequest | WaitingTask,
    kind: 'request' | 'task',
  ) => {
    const lock = source.lockResource
    if (lock === undefined) return
    probeReported = true
    if (lock === null) return
    if (!isBlocked(source.blocking)) return

    if (lock.status !== 'Resolved') {
      unresolved.push({ rawResource: lock.rawResource, reason: lock.reason })
      return
    }

    const objectId = resolveLockObject(lock, source.sessionId)
    if (!objectId) {
      offPageCount += 1
      return
    }

    const duration = waitMs(kind === 'request' ? (source as LiveRequest).waitTimeMs : (source as WaitingTask).waitDurationMs)
    const inCycle = sessionsInCycle.has(source.sessionId)
    const severity: IncidentSeverity = inCycle ? 'cycle' : 'blocked'
    const blocker = source.blocking.blockingSessionId
    const blockerObjectId = blocker === null ? undefined : objectBySession.get(blocker)
    const details = [
      formatMs(duration),
      `wait type ${source.waitType ?? 'not reported'}`,
      blocker !== null
        ? `session ${source.sessionId} is blocked by session ${blocker}`
        : `session ${source.sessionId} is blocked behind ${source.blocking.sentinel}`,
      `lock resource ${lock.rawResource} resolved to ${lock.schemaName ?? '?'}.${lock.objectName ?? '?'}`,
    ]
    if (inCycle) {
      details.push('This session is part of a cycle in the current wait graph. A cycle is what was measured; SQL Server resolves real deadlocks before they can be sampled.')
    }

    const marker: IncidentMarker = {
      id: `${kind}:${source.sessionId}:${objectId}`,
      objectId,
      counterpartObjectIds: blockerObjectId && blockerObjectId !== objectId ? [blockerObjectId] : [],
      sessionIds: [source.sessionId],
      severity,
      headline: inCycle
        ? `Session ${source.sessionId} is in a wait cycle here`
        : `Session ${source.sessionId} is blocked here`,
      details,
      source: kind === 'request'
        ? 'sys.dm_exec_requests, with the lock resource resolved by the backend probe'
        : 'sys.dm_os_waiting_tasks, with the lock resource resolved by the backend probe',
      observedAt,
    }

    const existing = byObject.get(objectId)
    if (!existing) {
      byObject.set(objectId, marker)
      return
    }
    // A cycle outranks a plain block; otherwise the longer wait keeps the pin.
    const promote = marker.severity === 'cycle' && existing.severity !== 'cycle'
    const merged = promote
      ? { ...marker, details: [...marker.details, ...existing.details] }
      : { ...existing, details: [...existing.details, ...marker.details] }
    byObject.set(objectId, {
      ...merged,
      counterpartObjectIds: [...new Set([...existing.counterpartObjectIds, ...marker.counterpartObjectIds])],
      // Every session that named this object keeps its claim on the pin. Dropping the loser would
      // strand its vehicle: the block is measured, and one pin is all the page has room for.
      sessionIds: [...new Set([...existing.sessionIds, ...marker.sessionIds])],
    })
  }

  for (const request of snapshot.requests) consider(request, 'request')
  for (const task of snapshot.waitingTasks) consider(task, 'task')
  markers.push(...byObject.values())

  /*
   * `deadlocks` is optional at runtime even though the contract declares it.
   *
   * A snapshot served by an older build of the API predates the reader entirely, and a browser tab
   * left open across a deployment will hand exactly that to this function. Absent is not the same as
   * `Unsupported` -- one means "this instance has no system_health session", the other means "this
   * server never looked" -- but both are "not observed", and neither is "no deadlocks".
   */
  const deadlockSample = snapshot.deadlocks as DeadlockSample | undefined
  const deadlockMarkers = deadlockSample ? projectDeadlocks(deadlockSample, byKey, pageDatabase) : []
  markers.push(...deadlockMarkers)
  markers.sort((left, right) => left.objectId.localeCompare(right.objectId) || left.id.localeCompare(right.id))

  const deadlocksObserved = deadlockSample?.status === 'Available' || deadlockSample?.status === 'Stale'

  return {
    markers,
    offPageCount,
    unresolved,
    probeReported,
    deadlocks: !deadlockSample
      ? DEADLOCKS_NOT_OBSERVED
      : {
        observed: deadlocksObserved,
        graphCount: deadlocksObserved ? deadlockSample.graphs.length : 0,
        retainedCount: deadlocksObserved ? deadlockSample.totalRetainedCount : 0,
        pinnedCount: deadlockMarkers.length,
        reason: deadlocksObserved
          ? deadlockSample.reason
          : `The system_health deadlock reader reported ${deadlockSample.status}: ${deadlockSample.reason}`,
      },
    reason: probeReported
      ? snapshot.reason
      : 'No sampled request or task carried a lock resource, so no blocking is claimed either way.',
  }
}

/**
 * Turns recorded deadlock graphs into crash pins.
 *
 * These are the only markers on this map that report a deadlock, because they are the only evidence
 * of one that exists: `sys.dm_exec_requests` cannot show a deadlock, since the engine has already
 * chosen a victim and rolled it back before anything could sample it. A cycle in the *live* wait
 * graph is a different and weaker observation and keeps its own, weaker severity.
 *
 * A graph is pinned only when at least one of its resources names an object this page has loaded.
 * A deadlock between two tables in another database is real and is counted in `retainedCount`; it
 * has nowhere to be drawn here, and drawing it anywhere would be a lie about where it happened.
 *
 * The anchor is what the **victim** was waiting for when it was chosen, because that is the request
 * the engine killed. The other loaded objects in the graph become counterparts, so the pin lands on
 * the road between them.
 */
function projectDeadlocks(
  sample: DeadlockSample,
  byKey: ReadonlyMap<string, string>,
  pageDatabase: string | null,
): IncidentMarker[] {
  if (sample.status !== 'Available' && sample.status !== 'Stale') return []

  const markers: IncidentMarker[] = []
  for (const graph of sample.graphs) {
    const victims = new Set(graph.victimProcessIds)
    /*
     * Whether this graph happened in the database the page is drawing.
     *
     * Gates the numeric fallback in `resolveDeadlockObject` for the same reason the live path is
     * gated: an `object_id` is unique only inside its database, and a graph read from
     * `system_health` is instance-wide. A deadlock between two other databases' tables is real, is
     * counted in `retainedCount`, and must not be pinned onto a building here.
     */
    const inPageDatabase = pageDatabase !== null && graph.processes.some(
      process => (process.databaseName ?? '').toLocaleLowerCase() === pageDatabase)
    const resolved = graph.resources
      .map(resource => ({ resource, objectId: resolveDeadlockObject(resource, byKey, inPageDatabase) }))
      .filter((entry): entry is { resource: DeadlockResource; objectId: string } => entry.objectId !== null)
    if (resolved.length === 0) continue

    const victimResource = resolved.find(entry => entry.resource.waiters.some(waiter => victims.has(waiter.processId)))
    const anchor = victimResource ?? resolved[0]
    const counterparts = [...new Set(resolved.map(entry => entry.objectId))].filter(id => id !== anchor.objectId)

    const victimProcesses = graph.processes.filter(process => process.isVictim || victims.has(process.id))
    const victimSessions = victimProcesses
      .map(process => process.sessionId)
      .filter((sessionId): sessionId is number => sessionId !== null)

    const details = [
      `recorded at ${graph.occurredAt}`,
      victimSessions.length > 0
        ? `victim session ${victimSessions.join(', ')} was rolled back by the engine`
        : 'the graph named no victim session id',
      `${graph.processes.length} process(es) over ${graph.resources.length} resource(s)`,
      ...resolved.map(entry =>
        `${entry.resource.resourceKind} on ${entry.resource.objectName ?? 'an unnamed object'}: `
        + `${entry.resource.owners.length} owner(s), ${entry.resource.waiters.length} waiter(s)`,
      ),
    ]
    if (!victimResource) {
      details.push('The victim\'s own resource is not on this page, so the pin is anchored to another resource from the same graph.')
    }
    if (!graph.includesSqlText) {
      details.push('Statement text was not requested for this graph, so the statements are absent rather than empty.')
    }
    details.push('This is history: the engine resolved this deadlock before it could be sampled live, and it is dated from when it happened rather than from this snapshot.')

    markers.push({
      id: `deadlock:${graph.id}:${anchor.objectId}`,
      objectId: anchor.objectId,
      counterpartObjectIds: counterparts,
      sessionIds: victimSessions,
      severity: 'deadlock',
      headline: `A deadlock was recorded here at ${graph.occurredAt}`,
      details,
      source: 'the system_health extended-events session, read on its own slower interval',
      observedAt: sample.collectedAt ?? graph.occurredAt,
    })
  }
  return markers
}

/**
 * The loaded object one deadlock resource names, or null.
 *
 * `objectName` is the engine's three-part name, so the trailing two parts are matched against the
 * `schema.object` keys the page already builds. `associatedObjectId` gives the same second chance
 * the live lock-resource probe gets. A resource kind that names no object — an `exchangeEvent` is
 * parallelism inside one query — resolves to null, which is correct and not a failure.
 *
 * `inPageDatabase` gates the numeric fallback only. The name join is safe ungated because a
 * three-part name is a name; an `object_id` is unique only inside its own database and needs the
 * caller to have established which database this graph ran in.
 */
function resolveDeadlockObject(
  resource: DeadlockResource,
  byKey: ReadonlyMap<string, string>,
  inPageDatabase: boolean,
): string | null {
  const keys: string[] = []
  if (resource.objectName) {
    const parts = resource.objectName.split('.').filter(part => part.length > 0)
    if (parts.length >= 2) keys.push(parts.slice(-2).join('.').toLocaleLowerCase())
  }
  if (inPageDatabase && resource.associatedObjectId !== null) {
    /*
     * Deliberately not keyed by `resource.databaseId`.
     *
     * That was the previous shape, `<database_id>/object/<id>`, and it could never match: a city
     * object id is addressed by name (`primary/database/CityDb/object/200`), never by the
     * per-instance number a deadlock graph reports. The database is checked by the caller instead,
     * against the graph's own processes, which is a check the key could not be.
     */
    keys.push(`object/${resource.associatedObjectId}`.toLocaleLowerCase())
  }
  for (const key of keys) {
    const objectId = byKey.get(key)
    if (objectId) return objectId
  }
  return null
}

export const SEVERITY_LABELS: Record<IncidentSeverity, string> = {
  blocked: 'Blocked waiter',
  waiting: 'Waiting',
  cycle: 'Wait cycle',
  deadlock: 'Car crash (recorded deadlock)',
}
