/**
 * The guided tour: the city driving itself, for a screen nobody is holding.
 *
 * A database city is built to be flown around, and the whole of it is only ever seen by someone who
 * knows to go looking. This module plans an itinerary out of what the page already measured — the
 * buildings carrying the most attributed CPU, the streets graded slowest, the pins where something
 * is blocked right now — and walks a camera through it indefinitely, so a map left up on a wall
 * reports the instance instead of sitting on one establishing shot forever.
 *
 * Everything here is arithmetic over plain records: no THREE, no canvas, no clock. The scene owns
 * the camera and the frame loop and asks this module two questions — "where should the tour go" and
 * "where is the camera at t" — which is what makes both answerable in a test. `web/`'s suite has no
 * WebGL and no DOM, so a shot computed inside the scene is a shot nothing can check.
 *
 * Two rules the captions live under, because a tour is narration and narration is where a map is
 * most tempted to editorialise:
 *
 * - **A caption states the measurement that earned the stop, never a verdict.** "Largest by reserved
 *   pages" is a fact about this page's own ordering. "Problem table" is a diagnosis nothing here is
 *   entitled to make.
 * - **An absence is captioned as an absence.** A street with no captured wait evidence says so
 *   rather than being described as free-flowing, which is a different claim and one the data does
 *   not support.
 */

import type { DatabaseCityObject } from './databaseCityContracts'
import type { RoadTraffic } from './cityTraffic'
import { CONGESTION_LABELS } from './cityTraffic'
import type { IncidentMarker } from './cityIncidents'
import { stableHash } from './atlasLayout'

/** A point on the ground plane. The tour never needs a third axis for anything it targets. */
export interface TourPoint {
  readonly x: number
  readonly z: number
}

export type TourStopKind = 'skyline' | 'landmark' | 'street' | 'incident' | 'neighbourhood'

/**
 * One shot in the itinerary: where to go, how to hold it, and what the caption is allowed to say.
 *
 * Framing is expressed as a ground **span** rather than an orbit distance because a distance means
 * nothing without the lens it is seen through — the same trap `applyZoomRange()` documents in the
 * scene, where the flat basemap's 13° field of view needs roughly 3.7x the distance of the oblique
 * 46° one to cover the same ground. A span is the thing a viewer actually perceives, so the planner
 * emits spans and the scene converts each one through whichever lens is currently mounted.
 */
export interface TourStop {
  readonly id: string
  readonly kind: TourStopKind
  /** Where the shot opens. When {@link path} is set this is also its first point. */
  readonly target: TourPoint
  /**
   * A street to follow, walked at constant arc length across the hold.
   *
   * This is what makes a street stop a street stop rather than a second building stop: the camera
   * tracks along the carriageway the way a traffic report does, and the road stays the subject for
   * the whole shot instead of sliding out of frame.
   */
  readonly path?: readonly TourPoint[]
  /** Height of the orbit target above ground. Aiming above the kerb is what tilts a facade into view. */
  readonly targetY: number
  /** Ground span the shot opens on, in world units. */
  readonly span: number
  /** Ground span the shot closes on. Smaller than {@link span} is a slow push in. */
  readonly spanEnd: number
  /** Compass bearing the camera sits at, in radians, measured the way the scene measures it. */
  readonly azimuth: number
  /** How far the camera drifts around the target across the hold, in radians. Signed. */
  readonly orbit: number
  /** Camera tilt in radians. Overridden by the scene when the flat basemap is mounted. */
  readonly polar: number
  /** Milliseconds spent travelling here from wherever the camera was. */
  readonly travelMs: number
  /** Milliseconds spent holding once arrived. */
  readonly holdMs: number
  /** What the stop is. A name, an address, a headline — never a judgement. */
  readonly caption: string
  /** The measurement that earned the visit, already formatted. */
  readonly detail: string
  /** The building this shot is about, when it is about one. */
  readonly objectId?: string
  /** The road this shot is about, when it is about one. */
  readonly routeId?: string
}

/** A camera pose, in the same span-not-distance currency {@link TourStop} uses. */
export interface TourShot {
  readonly x: number
  readonly z: number
  readonly y: number
  readonly span: number
  readonly azimuth: number
  readonly polar: number
}

export interface TourState {
  /** Index into the itinerary. Always in range for a non-empty one. */
  readonly index: number
  /** Milliseconds spent on the current stop, counting its travel and its hold together. */
  readonly elapsed: number
}

export const TOUR_START: TourState = { index: 0, elapsed: 0 }

/**
 * The longest itinerary worth planning.
 *
 * Long enough that a loop is not obviously a loop, short enough that it comes back around inside a
 * few minutes — by which point the live data has moved and the itinerary is replanned anyway, so a
 * longer list would mostly be stops describing a city that has since changed.
 */
export const MAX_TOUR_STOPS = 16

/** How many candidates each bucket contributes before the interleave runs out of material. */
const BUCKET_LIMITS = { incident: 4, landmark: 6, street: 5, neighbourhood: 3 } as const

/**
 * The order kinds are drawn in, cycled until every bucket is empty.
 *
 * Landmarks and streets appear twice per cycle because they are the bulk of any city and a rotation
 * that visited them once per lap would strand most of them unvisited inside {@link MAX_TOUR_STOPS}.
 * Incidents lead each cycle: they are the only entry that is news.
 */
const ROTATION: readonly TourStopKind[] = ['incident', 'landmark', 'street', 'landmark', 'neighbourhood', 'street']

export interface TourFacts {
  /** The database's own name, for the establishing shot's caption. */
  readonly cityName: string
  readonly bounds: {
    readonly minX: number
    readonly maxX: number
    readonly minZ: number
    readonly maxZ: number
    readonly centerX: number
    readonly centerZ: number
    readonly width: number
    readonly depth: number
  }
  /** Lot size in world units, which sets how tight a single-building shot can reasonably get. */
  readonly cell: number
  readonly objects: readonly DatabaseCityObject[]
  /** Where each object's building stands, from the plan the view already computed. */
  readonly lots: ReadonlyMap<string, TourPoint>
  readonly roads: readonly RoadTraffic[]
  /**
   * Each road's carriageway **as the scene drew it**.
   *
   * Passed in rather than derived, for the same reason `setVehicles` takes events instead of a
   * roster: a road's polyline is a property of the drawing, and a road the scene did not draw has
   * no ground for the camera to follow.
   */
  readonly roadPaths: ReadonlyMap<string, readonly TourPoint[]>
  readonly incidents: readonly IncidentMarker[]
}

export interface TourOptions {
  /**
   * Cut between stops instead of gliding, and hold still once there.
   *
   * The tour is not withdrawn under `prefers-reduced-motion`, because it was explicitly switched on
   * and it is the only way to see the whole city without driving. What is withdrawn is the motion:
   * the travel is instant, nothing orbits, and nothing dollies, which leaves a slideshow of the same
   * stops carrying the same captions.
   */
  readonly reducedMotion?: boolean
}

/* -------------------------------------------------------------------- easing */

/** Rest at both ends, quick through the middle: the shape a camera move wants. */
export function easeInOutCubic(t: number): number {
  const clamped = clamp01(t)
  return clamped < 0.5 ? 4 * clamped ** 3 : 1 - (-2 * clamped + 2) ** 3 / 2
}

/**
 * The gentler ease used for orbital drift and the dolly.
 *
 * Cubic is right for getting somewhere and wrong for staying there: over a seven-second hold its
 * flat middle reads as the camera lurching and then stalling. Sine still comes to rest at both ends
 * — which is what keeps the velocity continuous across a leg boundary — without the rush.
 */
export function easeInOutSine(t: number): number {
  return (1 - Math.cos(Math.PI * clamp01(t))) / 2
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t
}

/**
 * The signed angle from `from` to `to`, taken the short way round.
 *
 * Interpolating raw azimuths sends the camera the long way round whenever a leg crosses ±π, which
 * on a map reads as the city spinning through three quarters of a turn to reach a building that was
 * next door. Every azimuth this module interpolates goes through here.
 */
export function shortestTurn(from: number, to: number): number {
  const turn = (to - from) % (Math.PI * 2)
  if (turn > Math.PI) return turn - Math.PI * 2
  if (turn < -Math.PI) return turn + Math.PI * 2
  return turn
}

/**
 * A point at fraction `t` of a polyline's **arc length**, not of its vertex count.
 *
 * Parameterising by vertex would make the camera sprint down a road's long straights and crawl
 * around its corners, because a warped street graph puts its vertices where the geometry bends
 * rather than at even spacing.
 */
export function pointAlongPath(path: readonly TourPoint[], t: number): TourPoint {
  if (path.length === 0) return { x: 0, z: 0 }
  if (path.length === 1) return path[0]
  const spans: number[] = []
  let total = 0
  for (let index = 1; index < path.length; index += 1) {
    const length = Math.hypot(path[index].x - path[index - 1].x, path[index].z - path[index - 1].z)
    spans.push(length)
    total += length
  }
  // A degenerate path — every vertex on the same spot — has no arc length to divide by.
  if (total === 0) return path[0]
  let remaining = clamp01(t) * total
  for (let index = 0; index < spans.length; index += 1) {
    if (remaining <= spans[index] || index === spans.length - 1) {
      const share = spans[index] === 0 ? 0 : clamp01(remaining / spans[index])
      return {
        x: lerp(path[index].x, path[index + 1].x, share),
        z: lerp(path[index].z, path[index + 1].z, share),
      }
    }
    remaining -= spans[index]
  }
  return path[path.length - 1]
}

/* ------------------------------------------------------------- shot geometry */

/** The pose a stop opens its hold on, which is also what the travel leg aims at. */
export function openingShot(stop: TourStop): TourShot {
  return {
    x: stop.target.x,
    z: stop.target.z,
    y: stop.targetY,
    span: stop.span,
    azimuth: stop.azimuth,
    polar: stop.polar,
  }
}

/** The pose during a stop's hold, `elapsed` measured from the start of the hold. */
export function holdShot(stop: TourStop, holdElapsedMs: number): TourShot {
  const t = stop.holdMs <= 0 ? 1 : clamp01(holdElapsedMs / stop.holdMs)
  const eased = easeInOutSine(t)
  const point = stop.path && stop.path.length > 1 ? pointAlongPath(stop.path, t) : stop.target
  return {
    x: point.x,
    z: point.z,
    y: stop.targetY,
    span: lerp(stop.span, stop.spanEnd, eased),
    azimuth: stop.azimuth + stop.orbit * eased,
    polar: stop.polar,
  }
}

export interface TourFrame {
  readonly shot: TourShot
  readonly phase: 'travel' | 'hold'
  /** How far through the current phase, 0 to 1. Drives the caption's progress bar. */
  readonly progress: number
}

/**
 * Where the camera is, `elapsed` measured from the moment the stop was entered.
 *
 * `from` is the pose the camera held when the leg began — captured by the scene rather than
 * recomputed, because the leg may begin from a stop that has since been replanned away, or from
 * wherever the viewer had dragged the camera before switching the tour on.
 */
export function tourFrame(from: TourShot, stop: TourStop, elapsedMs: number): TourFrame {
  if (elapsedMs >= stop.travelMs || stop.travelMs <= 0) {
    return {
      shot: holdShot(stop, elapsedMs - stop.travelMs),
      phase: 'hold',
      progress: stop.holdMs <= 0 ? 1 : clamp01((elapsedMs - stop.travelMs) / stop.holdMs),
    }
  }
  const raw = clamp01(elapsedMs / stop.travelMs)
  const t = easeInOutCubic(raw)
  const to = openingShot(stop)
  return {
    shot: {
      x: lerp(from.x, to.x, t),
      z: lerp(from.z, to.z, t),
      y: lerp(from.y, to.y, t),
      // Span rather than distance again: interpolating distances across a leg that changes
      // magnification by 40x spends most of the move already arrived.
      span: Math.exp(lerp(Math.log(Math.max(from.span, 1)), Math.log(Math.max(to.span, 1)), t)),
      azimuth: from.azimuth + shortestTurn(from.azimuth, to.azimuth) * t,
      polar: lerp(from.polar, to.polar, t),
    },
    phase: 'travel',
    progress: raw,
  }
}

/** Total milliseconds a stop occupies, travel and hold together. */
export function stopDuration(stop: TourStop): number {
  return Math.max(stop.travelMs + stop.holdMs, 1)
}

/**
 * Advance the itinerary by `deltaMs`, wrapping at the end.
 *
 * Bounded rather than a bare `while`: a tab that was backgrounded for an hour hands back the whole
 * gap on the frame it resumes, and running the itinerary forward through it would burn hundreds of
 * iterations to land somewhere arbitrary. The scene clamps its delta as well, for the same reason
 * the vehicle loop does — this is the second guard, not the first.
 */
export function stepTour(state: TourState, stops: readonly TourStop[], deltaMs: number): TourState {
  if (stops.length === 0) return TOUR_START
  let index = stops.length === 0 ? 0 : ((state.index % stops.length) + stops.length) % stops.length
  let elapsed = Math.max(state.elapsed, 0) + Math.max(deltaMs, 0)
  for (let guard = 0; guard < stops.length + 1; guard += 1) {
    const duration = stopDuration(stops[index])
    if (elapsed < duration) return { index, elapsed }
    elapsed -= duration
    index = (index + 1) % stops.length
  }
  return { index, elapsed: 0 }
}

/**
 * Where to carry on from after a replan.
 *
 * The itinerary is rebuilt whenever the page loads more objects or the live feed moves, which on a
 * busy instance is every few seconds. Restarting at stop zero each time would pin the tour on the
 * establishing shot forever and it would never reach a building at all, so the current stop is
 * followed by **id** into the new list. An id that has gone — a block that cleared, an object that
 * was never on this page — falls back to the same ordinal, which keeps the tour roughly where it
 * was rather than throwing it back to the start.
 */
export function resumeIndex(
  previous: readonly TourStop[],
  next: readonly TourStop[],
  index: number,
): number {
  if (next.length === 0) return 0
  const current = previous[index]
  if (current) {
    const moved = next.findIndex(stop => stop.id === current.id)
    if (moved !== -1) return moved
  }
  return Math.min(Math.max(index, 0), next.length - 1)
}

/**
 * The index of an incident stop that has just appeared, or -1.
 *
 * This is the "and then it cuts to the disaster" behaviour, and it is the one thing allowed to
 * interrupt a hold. A block that started ten seconds ago is the only event on this map worth
 * abandoning a shot for, and waiting out the rest of the rotation to reach it would routinely mean
 * arriving after it had cleared.
 *
 * Only incidents qualify. A landmark that entered the itinerary because a later page raised its
 * measured CPU is not news; it is the same city, better counted.
 */
export function breakingStopIndex(previous: readonly TourStop[], next: readonly TourStop[]): number {
  const known = new Set(previous.filter(stop => stop.kind === 'incident').map(stop => stop.id))
  return next.findIndex(stop => stop.kind === 'incident' && !known.has(stop.id))
}

/* ------------------------------------------------------------------ planning */

/**
 * Parse one of the contracts' decimal strings.
 *
 * They are strings precisely because they outrun a JSON number, so a malformed or absent one has to
 * come back as "not measured" rather than as `NaN` quietly sorting to the bottom of a ranking.
 */
function numeric(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === '') return null
  try {
    return Number(BigInt(value))
  } catch {
    return null
  }
}

function objectLabel(object: DatabaseCityObject): string {
  return `${object.schemaName}.${object.name}`
}

/** A deterministic angle from an id, so a city tours the same way twice without looking mechanical. */
function scatterAzimuth(id: string): number {
  return (stableHash(id) / 0x100000000) * Math.PI * 2
}

/** Alternating drift, so consecutive stops do not all sweep the same way. */
function orbitFor(id: string, magnitude: number): number {
  return stableHash(id) % 2 === 0 ? magnitude : -magnitude
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString()
}

/** Microseconds as the seconds a reader can hold in their head, without inventing precision. */
function formatMicroseconds(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} s`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} ms`
  return `${formatCount(value)} µs`
}

function formatPages(pages: number): string {
  const kib = pages * 8
  if (kib >= 1024 * 1024) return `${(kib / (1024 * 1024)).toFixed(1)} GiB`
  if (kib >= 1024) return `${(kib / 1024).toFixed(1)} MiB`
  return `${formatCount(kib)} KiB`
}

const DEFAULT_POLAR = 0.848

interface Candidate {
  readonly kind: TourStopKind
  readonly stop: TourStop
  /** Descending sort key inside a bucket. Never leaves this module. */
  readonly rank: number
}

/**
 * Build the itinerary.
 *
 * Deterministic in its inputs, so the same page tours identically on every screen showing it and a
 * test can assert the whole list rather than a property of it.
 */
export function planCityTour(facts: TourFacts, options: TourOptions = {}): readonly TourStop[] {
  const still = options.reducedMotion === true
  const timing = (travel: number, hold: number) => ({
    travelMs: still ? 0 : travel,
    holdMs: still ? hold + travel : hold,
  })
  const drift = (id: string, magnitude: number) => (still ? 0 : orbitFor(id, magnitude))
  const dolly = (span: number, factor: number) => (still ? span : span * factor)

  const byId = new Map(facts.objects.map(object => [object.objectId, object]))
  const buckets = new Map<TourStopKind, Candidate[]>()
  const push = (candidate: Candidate) => {
    const bucket = buckets.get(candidate.kind)
    if (bucket) bucket.push(candidate)
    else buckets.set(candidate.kind, [candidate])
  }

  /* The establishing shot. Always first, and always present: a city with nothing measured in it is
   * still a city, and an itinerary of one wide slow orbit is a better answer than an empty one. */
  const citySpan = Math.max(facts.bounds.width, facts.bounds.depth, facts.cell * 4, 90)
  const skyline: TourStop = {
    id: 'tour:skyline',
    kind: 'skyline',
    target: { x: facts.bounds.centerX, z: facts.bounds.centerZ },
    targetY: 8,
    span: citySpan * 1.12,
    spanEnd: dolly(citySpan * 1.12, 0.92),
    azimuth: 0.595,
    orbit: still ? 0 : 0.62,
    polar: DEFAULT_POLAR,
    ...timing(4600, 7200),
    caption: facts.cityName,
    detail: `${formatCount(facts.objects.length)} objects drawn · ${formatCount(facts.roads.length)} streets graded`,
  }

  /*
   * Landmarks, earned two different ways and captioned accordingly.
   *
   * Ranking by one measure alone would tour one kind of building: attributed CPU on its own skips
   * every large table no ranked query happened to name, and reserved pages on its own skips the
   * small hot one that is the more interesting building of the two. Both lists are taken and the
   * caption says which list the visit came from, so "why am I looking at this" is answered on
   * screen rather than in this comment.
   */
  const withLot = facts.objects.filter(object => facts.lots.has(object.objectId))
  const byCpu = withLot
    .map(object => ({ object, cpu: numeric(object.attributedExposure.totalCpuMicroseconds) }))
    .filter((entry): entry is { object: DatabaseCityObject; cpu: number } => entry.cpu !== null && entry.cpu > 0)
    .sort((left, right) => right.cpu - left.cpu || left.object.objectId.localeCompare(right.object.objectId))
    .slice(0, 4)
  const bySize = withLot
    .map(object => ({ object, pages: numeric(object.reservedPages8KiB) }))
    .filter((entry): entry is { object: DatabaseCityObject; pages: number } => entry.pages !== null && entry.pages > 0)
    .sort((left, right) => right.pages - left.pages || left.object.objectId.localeCompare(right.object.objectId))
    .slice(0, 4)

  const claimed = new Set<string>()
  const addLandmark = (object: DatabaseCityObject, detail: string, rank: number) => {
    if (claimed.has(object.objectId)) return
    claimed.add(object.objectId)
    const lot = facts.lots.get(object.objectId)
    if (!lot) return
    const id = `tour:landmark:${object.objectId}`
    const span = Math.max(facts.cell * 3.4, 70)
    push({
      kind: 'landmark',
      rank,
      stop: {
        id,
        kind: 'landmark',
        target: { x: lot.x, z: lot.z },
        // Aiming above the kerb rather than at it is what puts the facade in frame instead of the
        // pavement in front of it.
        targetY: 11,
        span,
        // The slow push in the tour exists for. Held wide enough on arrival to place the building
        // in its neighbourhood, closed to roughly its own block by the end.
        spanEnd: dolly(span, 0.6),
        azimuth: scatterAzimuth(id),
        orbit: drift(id, 0.42),
        polar: DEFAULT_POLAR,
        ...timing(4200, 7600),
        caption: objectLabel(object),
        detail,
        objectId: object.objectId,
      },
    })
  }

  for (const { object, cpu } of byCpu) {
    addLandmark(
      object,
      `Most attributed Query Store CPU on this page · ${formatMicroseconds(cpu)} attributed to this object alone`,
      cpu,
    )
  }
  for (const { object, pages } of bySize) {
    addLandmark(object, `Largest by reserved pages on this page · ${formatPages(pages)} reserved`, pages)
  }

  /*
   * Busy streets, ranked by the same grading the map is already coloured with.
   *
   * `delayPerExecution` is what the colour is graded from, so ranking on it means the tour visits
   * the streets a viewer can already see are red — rather than arriving somewhere green and leaving
   * them to wonder what the shot was for. A road with no captured wait evidence is ranked last and
   * captioned as unmeasured, never as quiet.
   */
  const streets = facts.roads
    .map(road => ({ road, path: facts.roadPaths.get(road.routeId) }))
    .filter((entry): entry is { road: RoadTraffic; path: readonly TourPoint[] } =>
      entry.path !== undefined && entry.path.length >= 2)
    .map(entry => ({
      ...entry,
      rank: (entry.road.delayPerExecution ?? 0) * 1000 + (entry.road.recentExecutions ?? entry.road.executions ?? 0),
    }))
    .filter(entry => entry.rank > 0)
    .sort((left, right) => right.rank - left.rank || left.road.routeId.localeCompare(right.road.routeId))
    .slice(0, BUCKET_LIMITS.street)

  for (const { road, path, rank } of streets) {
    const id = `tour:street:${road.routeId}`
    const from = byId.get(road.fromObjectId)
    const to = byId.get(road.toId)
    const endpoints = `${from ? objectLabel(from) : road.fromObjectId} → ${to ? objectLabel(to) : road.toId}`
    const delay = road.delayPerExecution === null
      ? CONGESTION_LABELS.unknown
      : `${CONGESTION_LABELS[road.grade]} · ${road.delayPerExecution.toFixed(1)} ms mean captured wait per execution`
    const executions = road.executions === null
      ? 'no captured executions'
      : `${formatCount(road.executions)} captured executions`
    // Behind the direction of travel, so the camera looks *down* the street it is following. The
    // scene's azimuth is the bearing of the camera from its target, hence the half turn.
    const heading = Math.atan2(
      path[path.length - 1].x - path[0].x,
      path[path.length - 1].z - path[0].z,
    )
    const length = pathLength(path)
    push({
      kind: 'street',
      rank,
      stop: {
        id,
        kind: 'street',
        target: path[0],
        path,
        targetY: 4,
        // Wide enough to hold the carriageway and the frontage either side of it, and no wider:
        // the subject of the shot is the street, not the district it runs through.
        span: Math.max(length * 0.55, facts.cell * 2.6, 80),
        spanEnd: dolly(Math.max(length * 0.55, facts.cell * 2.6, 80), 0.88),
        azimuth: heading + Math.PI,
        orbit: drift(id, 0.2),
        polar: DEFAULT_POLAR,
        ...timing(3800, 8200),
        caption: endpoints,
        detail: `${delay} · ${executions}`,
        routeId: road.routeId,
      },
    })
  }

  /*
   * Live incidents. The severity order is the order the sidebar uses, so the tour visits them in
   * the order the list reads.
   */
  const severityRank: Record<IncidentMarker['severity'], number> = {
    deadlock: 4,
    cycle: 3,
    blocked: 2,
    waiting: 1,
  }
  for (const marker of facts.incidents) {
    const lot = facts.lots.get(marker.objectId)
    if (!lot) continue
    const id = `tour:incident:${marker.id}`
    const span = Math.max(facts.cell * 4.2, 90)
    push({
      kind: 'incident',
      rank: severityRank[marker.severity] ?? 0,
      stop: {
        id,
        kind: 'incident',
        target: { x: lot.x, z: lot.z },
        targetY: 9,
        span,
        spanEnd: dolly(span, 0.72),
        azimuth: scatterAzimuth(id),
        orbit: drift(id, 0.34),
        polar: DEFAULT_POLAR,
        ...timing(3400, 7400),
        caption: marker.headline,
        detail: marker.details[0] ?? marker.source,
        objectId: marker.objectId,
      },
    })
  }

  /*
   * Neighbourhoods, gathered from the lots rather than from the plan's districts.
   *
   * A district's extent lives behind the block warp and resolving it needs the plan's own geometry,
   * which this module deliberately does not take. The centroid and bounding box of the buildings
   * actually standing in a schema is a weaker claim about the district's shape and an exactly
   * correct one about where its objects are — which is all a camera needs.
   */
  const schemas = new Map<string, { name: string; points: TourPoint[] }>()
  for (const object of withLot) {
    const lot = facts.lots.get(object.objectId)!
    const entry = schemas.get(object.schemaId)
    if (entry) entry.points.push(lot)
    else schemas.set(object.schemaId, { name: object.schemaName, points: [lot] })
  }
  const neighbourhoods = [...schemas.entries()]
    .filter(([, entry]) => entry.points.length >= 2)
    .sort((left, right) => right[1].points.length - left[1].points.length || left[0].localeCompare(right[0]))
    .slice(0, BUCKET_LIMITS.neighbourhood)

  for (const [schemaId, entry] of neighbourhoods) {
    const id = `tour:neighbourhood:${schemaId}`
    const centroid = {
      x: entry.points.reduce((sum, point) => sum + point.x, 0) / entry.points.length,
      z: entry.points.reduce((sum, point) => sum + point.z, 0) / entry.points.length,
    }
    const extent = Math.max(
      Math.max(...entry.points.map(point => point.x)) - Math.min(...entry.points.map(point => point.x)),
      Math.max(...entry.points.map(point => point.z)) - Math.min(...entry.points.map(point => point.z)),
      facts.cell * 3,
    )
    push({
      kind: 'neighbourhood',
      rank: entry.points.length,
      stop: {
        id,
        kind: 'neighbourhood',
        target: centroid,
        targetY: 9,
        span: extent * 1.25,
        spanEnd: dolly(extent * 1.25, 0.82),
        azimuth: scatterAzimuth(id),
        orbit: drift(id, 0.5),
        polar: DEFAULT_POLAR,
        ...timing(4400, 7000),
        caption: entry.name,
        detail: `${formatCount(entry.points.length)} objects drawn in this neighbourhood`,
      },
    })
  }

  /*
   * The interleave.
   *
   * Buckets are drained in rotation rather than concatenated, so the tour does not spend its first
   * half on six buildings in a row. A kind that runs out is skipped rather than stalling the
   * rotation, which is what lets a city with no incidents and no graded streets still produce a
   * sensible itinerary out of the two buckets it does have.
   */
  const queues = new Map<TourStopKind, TourStop[]>()
  for (const [kind, candidates] of buckets) {
    const limit = BUCKET_LIMITS[kind as keyof typeof BUCKET_LIMITS] ?? candidates.length
    queues.set(
      kind,
      candidates
        .slice()
        .sort((left, right) => right.rank - left.rank || left.stop.id.localeCompare(right.stop.id))
        .slice(0, limit)
        .map(candidate => candidate.stop),
    )
  }

  const itinerary: TourStop[] = [skyline]
  let cursor = 0
  let drained = 0
  while (itinerary.length < MAX_TOUR_STOPS && drained < ROTATION.length) {
    const kind = ROTATION[cursor % ROTATION.length]
    cursor += 1
    const queue = queues.get(kind)
    if (queue && queue.length > 0) {
      itinerary.push(queue.shift()!)
      drained = 0
    } else {
      drained += 1
    }
  }
  return itinerary
}

function pathLength(path: readonly TourPoint[]): number {
  let total = 0
  for (let index = 1; index < path.length; index += 1) {
    total += Math.hypot(path[index].x - path[index - 1].x, path[index].z - path[index - 1].z)
  }
  return total
}
