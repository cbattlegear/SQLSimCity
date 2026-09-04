/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * The shadow map is regenerated on demand, and this is the contract that keeps it honest.
 *
 * `renderer.shadowMap.autoUpdate = false` turns a 2048² pass over 948 casters from something that
 * happens on every frame into something that happens when asked. Measured over a 4,200-object city
 * that is 7.6 ms of a 138 ms frame and 948 of 22,406 draw calls — worth having, and cheap to get
 * catastrophically wrong: a missed invalidation leaves the city casting the shadows of a city that
 * is no longer on screen, which is a worse defect than the cost it saves.
 *
 * The design that makes that safe is an inverted default. `requestRender()` — which every scene
 * mutation already goes through — marks the map stale, and only the handful of call sites that move
 * the camera alone opt out via `requestCameraRender()`. Forgetting therefore costs an extra shadow
 * pass, which is exactly the behaviour this replaced, rather than a stale one.
 *
 * These assertions read the scene as source text because it cannot be instantiated here: it needs a
 * WebGL context, and `web/`'s suite is vitest over pure modules with no DOM. `databaseCity.test.ts`
 * reads `DatabaseCityView.tsx` the same way for the same reason. Source text cannot prove the
 * shadows are correct on screen — only a browser can, which is what `tools/measure-browser` is for —
 * but it can prove nobody quietly moved a rebuild onto the camera-only path.
 */

const scene = readFileSync(new URL('./DatabaseCityScene.ts', import.meta.url), 'utf8')

/**
 * The same source with its comments removed.
 *
 * These guards assert that a region of code does *not* mention `requestRender()` or `needsUpdate`,
 * and a doc comment explaining why it must not is exactly such a mention. Matching raw text would
 * therefore make documenting the rule break the guard for it, which is a bad trade in both
 * directions: it discourages the explanation, and it hides real code behind prose noise. Stripping
 * comments first makes each assertion a statement about behaviour rather than about wording.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** The body of one method of the returned controller object, which sits at four-space indent. */
function controllerMethod(name: string): string {
  const start = scene.indexOf(`\n    ${name}(`)
  expect(start, `${name} should be a method on the scene controller`).toBeGreaterThan(-1)
  const rest = scene.slice(start + 1)
  const next = rest.slice(1).search(/\n {4}[A-Za-z]\w*[(:]/)
  return next === -1 ? rest : rest.slice(0, next + 1)
}

describe('the shadow map is invalidated by whatever changed what casts', () => {
  it('does not regenerate the shadow map on every frame', () => {
    expect(scene).toMatch(/renderer\.shadowMap\.autoUpdate\s*=\s*false/)
    // Armed for the first frame, which nothing else would ask for.
    expect(scene).toMatch(/renderer\.shadowMap\.needsUpdate\s*=\s*true/)
  })

  it('marks the map stale on the path every scene change already takes', () => {
    const requestRender = scene.slice(
      scene.indexOf('const requestRender = ()'),
      scene.indexOf('const requestCameraRender = ()'),
    )
    expect(requestRender).toMatch(/renderer\.shadowMap\.needsUpdate\s*=\s*true/)
  })

  it('skips it only where the camera moved and nothing under it did', () => {
    const cameraRender = scene.slice(
      scene.indexOf('const requestCameraRender = ()'),
      scene.indexOf('const runDampingLoop'),
    )
    expect(cameraRender).not.toMatch(/needsUpdate/)
    expect(cameraRender).toMatch(/scheduleFrame\(\)/)
  })

  /*
   * The enumeration the issue asks for, pinned one method at a time.
   *
   * Object rebuilds, road/traffic/facility/route/incident rebuilds, selection, layer
   * visibility and the map↔city swap all reach the renderer through these methods. Asset arrival
   * and the time-of-day change are not methods, so they are checked separately below.
   */
  it.each([
    ['setObjects', 'a re-plan moves every building'],
    ['setRoads', 'roads cast and receive'],
    ['setTraffic', 'traffic ribbons are geometry'],
    ['setFacilities', 'facility shells are casters'],
    ['setRoute', 'a drawn route adds geometry'],
    ['setSelected', 'selection changes what a building looks like'],
    ['setSelectedRoad', 'road highlight changes geometry'],
    ['setLayers', 'toggling a layer changes caster visibility'],
    ['setViewMode', 'map mode turns the shadow map off and city mode turns it back on'],
    ['setIncidents', 'incident markers are objects in the scene'],
    ['setVehicles', 'a live sample adds, moves and removes vehicle meshes'],
  ])('%s invalidates, because %s', name => {
    const body = controllerMethod(name)
    expect(body).toMatch(/[^a-zA-Z]requestRender\(\)/)
    expect(body).not.toMatch(/requestCameraRender\(\)/)
  })

  it('invalidates when the authored kits arrive after the first draw', () => {
    const asset = scene.slice(scene.indexOf('void loadCityAssets()'))
    const body = asset.slice(0, asset.indexOf('\n  })'))
    expect(body).toMatch(/buildGround\(plan\)/)
    expect(body).toMatch(/[^a-zA-Z]requestRender\(\)/)
    expect(body).not.toMatch(/requestCameraRender\(\)/)
  })

  it('invalidates when the hour moves the sun', () => {
    const clock = scene.slice(scene.indexOf('const stopWatchingClock = watchTimeOfDay'))
    const body = clock.slice(0, clock.indexOf('\n  })'))
    expect(body).toMatch(/applyAtmosphere\(\)/)
    expect(body).toMatch(/[^a-zA-Z]requestRender\(\)/)
    expect(body).not.toMatch(/requestCameraRender\(\)/)
  })

  it('leaves the damping loop drawing without asking for a new shadow pass', () => {
    const loop = code(scene.slice(
      scene.indexOf('const runDampingLoop'),
      scene.indexOf('const runVehicleLoop'),
    ))
    // The loop calls draw() straight, so an orbit renders many frames and invalidates on none.
    expect(loop).toMatch(/\n\s*draw\(\)/)
    expect(loop).not.toMatch(/requestRender\(\)/)
    expect(loop).not.toMatch(/needsUpdate/)
  })

  /*
   * The vehicle loop is the one continuous frame loop this scene runs, so it gets the strictest
   * version of the same contract.
   *
   * Unlike the damping loop, which ends within a second of the camera settling, this one runs for as
   * long as anything is executing on the instance — which on a busy server is indefinitely. A single
   * `requestRender()` inside it would therefore re-arm the 948-caster shadow pass on *every frame*,
   * restoring more than issue #90 removed and doing it in the one place where nothing casts a shadow
   * to begin with.
   */
  it('leaves the vehicle loop drawing without asking for a new shadow pass', () => {
    const loop = code(scene.slice(
      scene.indexOf('const runVehicleLoop'),
      scene.indexOf('const stopVehicleLoop'),
    ))
    expect(loop).toMatch(/\n\s*draw\(\)/)
    expect(loop).not.toMatch(/requestRender\(\)/)
    expect(loop).not.toMatch(/scheduleFrame\(\)/)
    expect(loop).not.toMatch(/needsUpdate/)
  })

  /*
   * Two handles, not one.
   *
   * `runDampingLoop` zeroes `animationHandle` the moment damping settles. A vehicle loop sharing it
   * would be orphaned by that — a second rAF chain still running with nothing left holding its
   * handle, so neither `stopVehicleLoop` nor `dispose()` could ever cancel it, and the frames it
   * kept drawing would outlive the scene. The two loops therefore keep separate handles, and
   * `dispose()` cancels both.
   */
  it('gives the vehicle loop its own handle, and cancels it on dispose', () => {
    const loop = code(scene.slice(
      scene.indexOf('const runVehicleLoop'),
      scene.indexOf('const stopVehicleLoop'),
    ))
    expect(loop).not.toMatch(/animationHandle/)
    expect(loop).toMatch(/vehicleHandle = requestAnimationFrame/)
    const dispose = code(controllerMethod('dispose'))
    expect(dispose).toMatch(/vehicleHandle !== 0\) cancelAnimationFrame\(vehicleHandle\)/)
  })

  /*
   * The loop must end on its own, not merely be cancellable.
   *
   * An idle instance samples an empty roster, and a loop that kept running over one would burn a
   * frame every 16 ms drawing nothing at all — the exact "renders continuously" behaviour this
   * scene's on-demand design exists to avoid, reintroduced at the moment there is least to show.
   */
  it('stops the vehicle loop when nothing is moving', () => {
    const loop = code(scene.slice(
      scene.indexOf('const runVehicleLoop'),
      scene.indexOf('const stopVehicleLoop'),
    ))
    // Guarded before the first frame is ever requested…
    expect(loop).toMatch(/movingVehicles === 0\) return/)
    // …and re-tested inside the step, so it ends whenever the roster drains.
    expect(loop).toMatch(/if \(disposed \|\| movingVehicles === 0\) \{\s*vehicleHandle = 0/)
  })

  /*
   * The guided tour is the second indefinite loop, and it is the more dangerous of the two.
   *
   * A vehicle loop ends when the roster drains; an attract-mode tour is meant to run on a wall
   * display for hours, moving the camera on every single frame of it. That is precisely the case
   * issue #90 measured — 948 draw calls and 7.6 ms per frame redrawing shadows for a city that had
   * not moved — so a `requestRender()` in here would not merely undo the saving, it would undo it
   * for the longest-running thing this scene ever does. The sun is directional and its shadow map is
   * rendered from the light, so a camera flying around underneath cannot change a texel of it.
   */
  it('leaves the tour loop drawing without asking for a new shadow pass', () => {
    const from = scene.indexOf('const runTourLoop')
    const to = scene.indexOf('const stopTourLoop')
    expect(from, 'runTourLoop has been renamed and this guard now covers nothing')
      .toBeGreaterThan(-1)
    expect(to, 'stopTourLoop has been renamed or moved above the loop, inverting this slice')
      .toBeGreaterThan(from)
    const loop = code(scene.slice(from, to))
    expect(loop).toMatch(/\n\s*draw\(\)/)
    expect(loop).not.toMatch(/requestRender\(\)/)
    expect(loop).not.toMatch(/requestCameraRender\(\)/)
    expect(loop).not.toMatch(/scheduleFrame\(\)/)
    expect(loop).not.toMatch(/needsUpdate/)
  })

  /*
   * Three handles now, and the argument for the third is the argument for the second.
   *
   * Whichever `cancelAnimationFrame` runs last silently orphans the others if they share a handle,
   * and an orphaned tour is worse than an orphaned vehicle loop: it keeps *writing to the camera*,
   * so a scene that has been disposed goes on flying over a city nothing can stop.
   */
  it('gives the tour loop its own handle, and cancels it on dispose', () => {
    const loop = code(scene.slice(
      scene.indexOf('const runTourLoop'),
      scene.indexOf('const stopTourLoop'),
    ))
    expect(loop).not.toMatch(/animationHandle/)
    expect(loop).not.toMatch(/vehicleHandle/)
    expect(loop).toMatch(/tourHandle = requestAnimationFrame/)
    const dispose = code(controllerMethod('dispose'))
    expect(dispose).toMatch(/tourHandle !== 0\) cancelAnimationFrame\(tourHandle\)/)
  })

  /*
   * And it ends by itself, rather than idling forever once the tour is switched off.
   *
   * Switching the toggle off is not a render-loop concern anywhere else in this scene, so the guard
   * has to be inside the step: a `stopTourLoop()` that is only ever called from the controller
   * would leave a disposed scene's loop running, which is the one thing the handle cannot fix
   * because `dispose()` has already run by then.
   */
  it('stops the tour loop when the tour is switched off, emptied or disposed', () => {
    const loop = code(scene.slice(
      scene.indexOf('const runTourLoop'),
      scene.indexOf('const stopTourLoop'),
    ))
    // Guarded before the first frame is ever requested…
    expect(loop).toMatch(/if \(tourHandle !== 0 \|\| disposed \|\| !tourActive/)
    // …and re-tested inside the step, so the next frame after any of them ends the chain.
    expect(loop).toMatch(/if \(disposed \|\| !tourActive \|\| tourStops\.length === 0\) \{\s*tourHandle = 0/)
  })

  /*
   * The per-frame camera write is guarded separately, because the loop guard cannot see it.
   *
   * These are source-text slices, so a `requestRender()` moved one call deep — into the function the
   * loop invokes on every frame — passes the loop assertion above while costing exactly as much.
   * `placeTourCamera` is that function, so it gets the same contract.
   */
  it('places the tour camera without scheduling a frame or a shadow pass', () => {
    const from = scene.indexOf('function placeTourCamera(')
    const to = scene.indexOf('function reportTourHeading(')
    expect(from, 'placeTourCamera has been renamed and this guard now covers nothing')
      .toBeGreaterThan(-1)
    expect(to, 'reportTourHeading has been renamed or hoisted, inverting this slice')
      .toBeGreaterThan(from)
    const place = code(scene.slice(from, to))
    expect(place).toMatch(/camera\.position\.copy/)
    expect(place).not.toMatch(/shadowMap/)
    expect(place).not.toMatch(/needsUpdate/)
    expect(place).not.toMatch(/requestRender\(\)/)
    expect(place).not.toMatch(/scheduleFrame\(\)/)
  })


  /*
   * Nothing a vehicle does can dirty the shadow map, because no vehicle casts into it.
   *
   * This is the property that makes the loop above safe at all. It is asserted over the whole build
   * function rather than over one line so that adding a second mesh kind — a bus, a train — cannot
   * quietly opt back in.
   */
  it('never lets a vehicle cast or receive a shadow', () => {
    const build = code(scene.slice(
      scene.indexOf('function buildVehicles()'),
      scene.indexOf('const vehicleMatrix'),
    ))
    expect(build).toMatch(/castShadow = false/)
    expect(build).toMatch(/receiveShadow = false/)
    expect(build).not.toMatch(/castShadow = true/)
    expect(build).not.toMatch(/receiveShadow = true/)
    expect(build).not.toMatch(/needsUpdate\s*=\s*true;?\s*$/m)
  })

  /*
   * And nothing the *trail* does can dirty it either.
   *
   * The trail is a single ribbon mesh rewritten in place on every frame of the vehicle loop, so it
   * is the one piece of geometry in this scene that genuinely changes 60 times a second. That makes
   * it the most dangerous possible caster: `castShadow = true` here would re-arm a 948-caster pass
   * on every frame *and* be justified-looking, because the geometry really did change. It is
   * excluded outright instead, which is also why `writeTrails` needs no invalidation of its own.
   *
   * Bounded by `const trailSampleX` rather than by the end of the file, so this stays a statement
   * about the mesh's setup and does not silently grow to cover whatever is added below it. The
   * geometry rewrite that follows is guarded by the vehicle-loop assertions above.
   */
  it('never lets the vehicle trail cast or receive a shadow', () => {
    const from = scene.indexOf('const TRAIL_SEGMENTS')
    const to = scene.indexOf('const trailSampleX')
    expect(from, 'the trail constants have been renamed and this guard now covers nothing')
      .toBeGreaterThan(-1)
    expect(to, 'the trail scratch buffers have been renamed and this slice is unbounded')
      .toBeGreaterThan(from)
    const trail = code(scene.slice(from, to))
    expect(trail).toMatch(/trailMesh\.castShadow = false/)
    expect(trail).toMatch(/trailMesh\.receiveShadow = false/)
    expect(trail).not.toMatch(/castShadow = true/)
    expect(trail).not.toMatch(/receiveShadow = true/)
    expect(trail).not.toMatch(/needsUpdate/)
  })

  /*
   * The trail is written from inside the frame loop, and writing it must not schedule anything.
   *
   * `writeTrails` runs per frame and touches `BufferAttribute.needsUpdate` — the *attribute's* flag,
   * which is how a rewritten buffer is uploaded to the GPU and has nothing to do with the shadow
   * map. That collision of names is the trap: this guard names the renderer's flag specifically, so
   * the legitimate upload is allowed and `renderer.shadowMap.needsUpdate` is not.
   */
  it('writes the trail without scheduling a frame or a shadow pass', () => {
    const from = scene.indexOf('function writeTrails(')
    const to = scene.indexOf('function placeVehicles()')
    expect(from, 'writeTrails has been renamed and this guard now covers nothing').toBeGreaterThan(-1)
    expect(to, 'placeVehicles has been renamed and this slice is unbounded').toBeGreaterThan(from)
    const write = code(scene.slice(from, to))
    expect(write).toMatch(/trailPositions\[/)
    expect(write).not.toMatch(/shadowMap/)
    expect(write).not.toMatch(/requestRender\(\)/)
    expect(write).not.toMatch(/scheduleFrame\(\)/)
  })
})

/**
 * That `buildIncidents` still *asks* whether a marker stops traffic.
 *
 * `stopsTraffic` was extracted from this function precisely so the rule could be tested directly,
 * and `cityIncidents.test.ts` now covers all four severities against it. That guards the rule and
 * not the use of it: the scene can stop consulting `stopsTraffic` altogether -- replacing the
 * conditional with `if (true)`, or deleting it while tidying -- and every behavioural test in the
 * repository still passes. Verified, not assumed: that exact mutation left 919/919 green.
 *
 * What is at stake is not a style point. SQL Server recycles session ids, so a recorded deadlock
 * graph naming session 55 and a live session 55 are unrelated queries. Admitting deadlock markers
 * to `blockedPlacements` parks a *running* request's vehicle at the scene of something that already
 * finished, and asserts a connection between them that nothing in the data supports.
 *
 * This is a source-text guard, which is weaker than a behavioural one and is used here for the
 * reason the file already uses several: `buildIncidents` is a closure over the scene factory and
 * is not reachable from a test without a refactor larger than the change it would protect. The
 * assertions below are written so the mutation above fails them.
 */
describe('a live block stops traffic only when stopsTraffic says so', () => {
/** `buildIncidents` through to the next sibling function, both at two-space indent. */
const incidents = (() => {
  const start = scene.indexOf('\n  function buildIncidents(')
  expect(start, 'buildIncidents should exist at two-space indent').toBeGreaterThan(-1)
  const rest = scene.slice(start + 1)
  const next = rest.slice(1).search(/\n {2}function [A-Za-z]/)
  return code(next === -1 ? rest : rest.slice(0, next + 1))
})()

it('consults stopsTraffic rather than deciding for itself', () => {
  expect(incidents).toMatch(/if \(stopsTraffic\(marker\)\)/)
})

it('records no placement that the guard has not admitted', () => {
  /*
   * Ordering, not just presence, is what makes this fail on the mutation. `if (true)` and a
   * deleted conditional both leave `blockedPlacements.set` reachable with no call to
   * `stopsTraffic` before it, so requiring the call to appear *first* rejects both -- where
   * asserting only that the file mentions `stopsTraffic` somewhere would accept them.
   */
  const writes = [...incidents.matchAll(/blockedPlacements\.set\(/g)]
  expect(writes, 'buildIncidents should record blocked placements').toHaveLength(1)
  const guard = incidents.indexOf('stopsTraffic(marker)')
  expect(guard, 'stopsTraffic should be consulted').toBeGreaterThan(-1)
  expect(guard).toBeLessThan(writes[0].index!)
})

it('takes stopsTraffic from cityIncidents rather than redefining it locally', () => {
  // A local `const stopsTraffic = () => true` would satisfy both assertions above.
  expect(code(scene)).toMatch(/import \{[^}]*\bstopsTraffic\b[^}]*\} from '\.\/cityIncidents'/)
  expect(code(scene)).not.toMatch(/(?:const|let|function)\s+stopsTraffic\b/)
})
})
