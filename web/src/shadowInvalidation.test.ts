/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { labelPixelHeight, labelScreenScale } from './cityLabels'

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
    ['setFireObjects', 'a fire adds flame and smoke meshes to the scene'],
    ['setWaterMainBreaks', 'a burst main adds jets and a puddle to the scene'],
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

  /*
   * The disaster loop is the third continuous loop, and it is the most dangerous of the three.
   *
   * The vehicle loop stops when the instance goes quiet. A fire does not: a table whose plan carries
   * a high-impact missing index is on fire for as long as that plan is the one Query Store hands
   * back, which is hours. So this loop genuinely runs indefinitely on an idle machine, and a single
   * `requestRender()` inside it would re-arm the 948-caster shadow pass sixty times a second for the
   * rest of the session — worse than the state issue #90 removed, because #90's cost at least
   * stopped when the camera did.
   */
  it('leaves the disaster loop drawing without asking for a new shadow pass', () => {
    const from = scene.indexOf('const runDisasterLoop')
    const to = scene.indexOf('const stopDisasterLoop')
    expect(from, 'runDisasterLoop has been renamed and this guard now covers nothing')
      .toBeGreaterThan(-1)
    expect(to, 'stopDisasterLoop has been renamed and this slice is unbounded').toBeGreaterThan(from)
    const loop = code(scene.slice(from, to))
    expect(loop).toMatch(/\n\s*draw\(\)/)
    expect(loop).not.toMatch(/requestRender\(\)/)
    expect(loop).not.toMatch(/scheduleFrame\(\)/)
    expect(loop).not.toMatch(/needsUpdate/)
  })

  /*
   * Three handles now, not two.
   *
   * Every pair of these loops can orphan the other by sharing a handle, and the failure is silent:
   * whichever `cancelAnimationFrame` runs last wins, and the loser keeps drawing frames that nothing
   * holds a handle to — surviving `dispose()`, and outliving the canvas it was drawing into.
   */
  it('gives the disaster loop its own handle, and cancels it on dispose', () => {
    const from = scene.indexOf('const runDisasterLoop')
    const to = scene.indexOf('const stopDisasterLoop')
    expect(to).toBeGreaterThan(from)
    const loop = code(scene.slice(from, to))
    expect(loop).not.toMatch(/animationHandle/)
    expect(loop).not.toMatch(/vehicleHandle/)
    expect(loop).toMatch(/disasterHandle = requestAnimationFrame/)
    const dispose = code(controllerMethod('dispose'))
    expect(dispose).toMatch(/disasterHandle !== 0\) cancelAnimationFrame\(disasterHandle\)/)
  })

  /*
   * A city with nothing wrong with it must go fully idle.
   *
   * Most databases are not on fire, so the empty case is the common one — and a loop that scheduled
   * a frame every 16 ms to animate nothing would make the *healthy* city the one that never lets the
   * machine sleep. `reducedMotion` is refused at the door for the same reason: a reader who has asked
   * the system for no animation gets a still fire, not a still fire drawn sixty times a second.
   */
  it('stops the disaster loop when nothing is burning', () => {
    const from = scene.indexOf('const runDisasterLoop')
    const to = scene.indexOf('const stopDisasterLoop')
    expect(to).toBeGreaterThan(from)
    const loop = code(scene.slice(from, to))
    expect(loop).toMatch(/reducedMotion \|\| animatedDisasters === 0\) return/)
    expect(loop).toMatch(/if \(disposed \|\| animatedDisasters === 0\) \{\s*disasterHandle = 0/)
  })

  /*
   * And nothing a disaster draws casts into the shadow map.
   *
   * This is what makes the loop above safe at all. Flames, smoke and jets move every frame, so one
   * caster among them re-arms the whole pass on every frame by itself — no `needsUpdate` required,
   * because `autoUpdate = false` only stops the *automatic* regeneration and a moving caster still
   * leaves a stale map that something will eventually have to refresh. Asserted over the whole build
   * function so that adding a fifth disaster part cannot quietly opt back in.
   */
  it('never lets a disaster cast or receive a shadow', () => {
    const from = scene.indexOf('function buildDisasters()')
    const to = scene.indexOf('function placeDisasters()')
    expect(from, 'buildDisasters has been renamed and this guard now covers nothing')
      .toBeGreaterThan(-1)
    expect(to, 'placeDisasters has been renamed and this slice is unbounded').toBeGreaterThan(from)
    const build = code(scene.slice(from, to))
    expect(build).toMatch(/castShadow = false/)
    expect(build).toMatch(/receiveShadow = false/)
    expect(build).not.toMatch(/castShadow = true/)
    expect(build).not.toMatch(/receiveShadow = true/)
    expect(build).not.toMatch(/needsUpdate\s*=\s*true/)
    expect(build).not.toMatch(/requestRender\(\)/)
  })

  /*
   * Placing a disaster is a per-frame write and must schedule nothing.
   *
   * Same trap as `writeTrails`: this function sets `InstancedMesh.instanceMatrix.needsUpdate`, which
   * is how a rewritten instance buffer reaches the GPU and has nothing to do with the shadow map. The
   * guard therefore names the renderer's flag specifically rather than the word, so the legitimate
   * upload is allowed through and `renderer.shadowMap.needsUpdate` is not.
   */
  it('places disasters without scheduling a frame or a shadow pass', () => {
    const from = scene.indexOf('function placeDisasters()')
    const to = scene.indexOf('const runDisasterLoop')
    expect(from).toBeGreaterThan(-1)
    expect(to, 'runDisasterLoop has been renamed and this slice is unbounded').toBeGreaterThan(from)
    const place = code(scene.slice(from, to))
    expect(place).toMatch(/instanceMatrix\.needsUpdate = true/)
    expect(place).not.toMatch(/shadowMap/)
    expect(place).not.toMatch(/requestRender\(\)/)
    expect(place).not.toMatch(/scheduleFrame\(\)/)
  })
})

/**
 * That a disaster is still drawn at a size somebody can see.
 *
 * This layer's whole defect report was "I don't see any of the other issues showing up ever", and
 * the cause was not that the fires were missing — they were drawn, in the right places, from correct
 * evidence, at **15 pixels of 1,296,000** at the default framing. Every test in this repository
 * passed against that, because a fire that is present and invisible is indistinguishable from a fire
 * that is present and legible to anything reading source or state rather than pixels.
 *
 * What fixed it was `labelScreenScale`, the same magnification the vehicle shells use to escape
 * being "just blocks" — measured after, the same fire covers 600 pixels of flame under a visible
 * plume. That call is therefore the whole of the fix, and it is one tidy away from being deleted as
 * a redundant multiply by a number that is usually close to 1.
 *
 * Source text cannot prove a fire is legible; only `tools/measure-browser` can, and that is where
 * the numbers above come from. What these assertions can prove is that nobody removed the mechanism
 * that produced them, which is the failure this layer has already had once.
 */
describe('a disaster is magnified until it is large enough to notice', () => {
  const from = scene.indexOf('function placeDisasters()')
  const to = scene.indexOf('const runDisasterLoop')
  const place = (() => {
    expect(from, 'placeDisasters has been renamed and this guard now covers nothing')
      .toBeGreaterThan(-1)
    expect(to, 'runDisasterLoop has been renamed and this slice is unbounded').toBeGreaterThan(from)
    return code(scene.slice(from, to))
  })()

  /** Reads a plain-number constant out of the scene source. */
  const value = (name: string): number => {
    const match = new RegExp(`const ${name} = ([\\d.]+)\\b`).exec(scene)
    expect(match, `${name} has been renamed, removed, or is no longer a plain number`).not.toBeNull()
    return Number(match![1])
  }

  it('sizes every disaster against the viewport rather than against the world', () => {
    expect(place).toMatch(/labelScreenScale\(/)
    expect(place).toMatch(/DISASTER_MIN_PX/)
    expect(place).toMatch(/DISASTER_MAX_GROWTH/)
    // Measured from the live camera, not from a value captured when the fire started: the factor is
    // a function of the orbit distance, so a cached one is wrong the moment the reader zooms.
    expect(place).toMatch(/camera\.position\.distanceTo\(controls\.target\)/)
  })

  it('applies that magnification to every part, so the ratio between them survives it', () => {
    /*
     * Presence of the call is not enough, and neither is presence of the *word*.
     *
     * The first version of this guard asked whether each mesh's block mentioned `magnify` anywhere.
     * Mutation testing killed it: dropping `* magnify` from the flame's height leaves the flame's
     * *width* magnified, so the block still said the word while the flames grew sideways and stayed
     * short — and the wreck kept its magnified lift while the box itself shrank back to true scale.
     * Both mutations passed. Each dimension is therefore resolved and checked on its own.
     *
     * Arguments are usually local names rather than expressions, so a name is judged by what it was
     * assigned instead of by its spelling — and the lookup is scoped to the **mesh's own block**.
     * Collecting the declarations over the whole function instead is the retarget trap `ownRule()`
     * is documented for: `height` and `width` are declared in the flame block and again in the jet
     * block, a whole-function map keeps only the last of each, and both flame mutations were
     * therefore judged against the jet's still-magnified declaration and passed.
     */
    for (const mesh of ['flameMesh', 'smokeMesh', 'jetMesh', 'puddleMesh', 'wreckMesh']) {
      const start = place.indexOf(`if (${mesh}) {`)
      expect(start, `${mesh} should be written by placeDisasters`).toBeGreaterThan(-1)
      const block = place.slice(start, place.indexOf('instanceMatrix.needsUpdate', start))

      const locals = new Map<string, string>()
      for (const [, name, value] of block.matchAll(/const (\w+) = ([^\n]+)/g)) locals.set(name, value)
      const resolve = (argument: string) => {
        const trimmed = argument.trim()
        return locals.get(trimmed) ?? trimmed
      }

      const composed = /disasterScale\.copy\([^)]*\)\.multiplyScalar\((\w+)\)/.exec(block)
      if (composed) {
        expect(composed[1], `${mesh} is copied at true scale and will be invisible when zoomed out`)
          .toBe('magnify')
        continue
      }

      const set = /disasterScale\.set\(([^)]*)\)/.exec(block)
      expect(set, `${mesh} should write its scale through disasterScale`).not.toBeNull()
      const [x, y] = set![1].split(',')
      /*
       * Width and height only. A puddle's third component is the thickness of a flat disc lying on
       * the ground plane, and magnifying that would lift it off the plate it is deliberately sunk
       * into — so the depth of a two-dimensional part is exempt by design rather than by oversight.
       */
      expect(resolve(x), `${mesh} is drawn at true width and will be invisible when zoomed out`)
        .toMatch(/magnify/)
      expect(resolve(y), `${mesh} is drawn at true height and will be invisible when zoomed out`)
        .toMatch(/magnify/)
    }
  })

  it('demands more of a disaster than of a vehicle, because nobody is looking for it', () => {
    // A vehicle is found by a reader already scanning traffic; a fire has to interrupt one who is
    // not. If these ever invert, the fire has become the more easily missed of the two.
    const disaster = /const DISASTER_MIN_PX = (\d+)/.exec(scene)
    const vehicle = /const VEHICLE_MIN_PX = (\d+)/.exec(scene)
    expect(disaster, 'DISASTER_MIN_PX has been renamed or removed').not.toBeNull()
    expect(vehicle, 'VEHICLE_MIN_PX has been renamed or removed').not.toBeNull()
    expect(Number(disaster![1])).toBeGreaterThan(Number(vehicle![1]))
  })

  /*
   * The floor has to be measured against the height a part is actually drawn at.
   *
   * This is the defect that hid inside the fix for the original one. `DISASTER_REFERENCE_HEIGHT` was
   * a typed-in 10, described as "a water jet on the smallest lot" -- but that was the jet's height
   * at *full pulse*, and the jet's pulse floor was 0.24. So the shortest signal the shared factor
   * claimed to clear spent most of every cycle at a quarter of the height the claim was computed
   * from. Measured in a real browser at 1440x900 the jet occupied **7x16 pixels** while the
   * magnification code above it was working exactly as designed and every test here passed.
   *
   * So the check is arithmetic on the constants rather than a search for a mechanism: whatever the
   * aspects, floors and size band are, the reference may not exceed the shortest height they can
   * produce. A literal cannot satisfy this by accident for long, and a literal that does satisfy it
   * today would fail the moment an aspect or a floor moved -- which is the drift being prevented.
   */
  it('measures the floor against the shortest height a part is ever drawn at', () => {
    const sizeMin = value('DISASTER_SIZE_MIN')
    const shortest = Math.min(
      sizeMin * value('FLAME_ASPECT') * value('FLAME_PULSE_FLOOR'),
      sizeMin * value('JET_ASPECT') * value('JET_PULSE_FLOOR'),
    )

    const declaration = /const DISASTER_REFERENCE_HEIGHT = ([\s\S]*?\n\s*\)|[^\n]+)/.exec(scene)
    expect(declaration, 'DISASTER_REFERENCE_HEIGHT has been renamed or removed').not.toBeNull()
    const source = declaration![1]

    // A bare number is the shape the defect had. It cannot track the geometry, so it is refused
    // outright rather than checked -- the next edit to an aspect would silently invalidate it.
    expect(source.trim(), 'DISASTER_REFERENCE_HEIGHT is a literal again and will drift out of ' +
      'agreement with the geometry, which is how a jet came to be drawn 7 pixels wide')
      .not.toMatch(/^[\d.]+$/)

    for (const name of ['DISASTER_SIZE_MIN', 'FLAME_PULSE_FLOOR', 'JET_PULSE_FLOOR']) {
      expect(source, `DISASTER_REFERENCE_HEIGHT ignores ${name}`).toContain(name)
    }

    /*
     * And the value itself. `Function` over the extracted constants rather than importing the
     * module, because the scene is read here as source text and never executed -- the same reason
     * every other guard in this file slices strings.
     */
    const evaluated = Number(new Function(
      'DISASTER_SIZE_MIN', 'FLAME_ASPECT', 'JET_ASPECT', 'FLAME_PULSE_FLOOR', 'JET_PULSE_FLOOR',
      `return ${source}`,
    )(sizeMin, value('FLAME_ASPECT'), value('JET_ASPECT'), value('FLAME_PULSE_FLOOR'), value('JET_PULSE_FLOOR')))
    expect(evaluated).toBeGreaterThan(0)
    expect(evaluated, 'the magnification is measured against a height taller than the shortest part ' +
      'actually drawn, so the shortest part will not clear DISASTER_MIN_PX')
      .toBeLessThanOrEqual(shortest + 1e-9)
  })

  /*
   * ...and that the shortest part can actually *reach* the floor within the growth cap.
   *
   * Deriving the reference from the geometry is necessary and not sufficient, which mutation testing
   * showed rather than argument: dropping `JET_PULSE_FLOOR` back to its old 0.24 drops the derived
   * reference with it, so every assertion above still holds -- and the jet still ends up 12 pixels
   * tall, because clearing 34px from a reference that short needs ~40x and `DISASTER_MAX_GROWTH` is
   * 14. The floor is a promise about pixels, so it is checked in pixels, end to end, through the
   * same `labelScreenScale` the scene calls rather than a re-derivation of it.
   *
   * The framing is the one the city opens on, measured in a real browser at 1440x900: the camera
   * settles ~1495 units from its target with `camera.fov` 46 and a ~900px canvas. It is a fixed
   * reference point for the arithmetic, not an assertion about where the camera happens to be.
   */
  it('leaves enough growth for the shortest part to reach that floor', () => {
    const fov = Number(/new THREE\.PerspectiveCamera\((\d+)/.exec(scene)![1])
    const distance = 1495
    const viewport = 900

    const reference = Math.min(
      value('DISASTER_SIZE_MIN') * value('FLAME_ASPECT') * value('FLAME_PULSE_FLOOR'),
      value('DISASTER_SIZE_MIN') * value('JET_ASPECT') * value('JET_PULSE_FLOOR'),
    )
    const minPx = value('DISASTER_MIN_PX')
    const magnify = labelScreenScale(reference, distance, fov, viewport, minPx, value('DISASTER_MAX_GROWTH'))
    const drawn = labelPixelHeight(reference * magnify, distance, fov, viewport)

    expect(drawn, `the shortest disaster part reaches only ${drawn.toFixed(1)}px at the framing the ` +
      'city opens on, because DISASTER_MAX_GROWTH runs out before DISASTER_MIN_PX is reached')
      .toBeGreaterThanOrEqual(minPx - 0.5)
  })

  /*
   * The band is what makes one shared factor possible at all.
   *
   * Footprints across a real database span about 7:1, and a single magnification cannot serve that:
   * the factor that makes the smallest lot's jet legible turns the largest lot's fire into a wall.
   * Holding authored sizes inside a narrow band is what keeps the drawn spread near 2:1. Dropping
   * the lower end of the clamp is the mutation that matters -- it is invisible on a big table and
   * puts the small ones straight back under the floor -- and nothing above catches it, because
   * `DISASTER_SIZE_MIN` goes on existing as a declaration that nothing applies.
   */
  it('holds every authored disaster size inside the band, at both ends', () => {
    const helper = /const disasterSize = \(raw: number\): number =>\s*([^\n]+)/.exec(scene)
    expect(helper, 'disasterSize has been renamed or removed').not.toBeNull()
    const clamp = Function('DISASTER_SIZE_MIN', 'DISASTER_SIZE_MAX', `return (raw) => ${helper![1]}`)(
      value('DISASTER_SIZE_MIN'), value('DISASTER_SIZE_MAX'),
    )
    expect(clamp(0.01), 'a tiny footprint escapes below DISASTER_SIZE_MIN').toBe(value('DISASTER_SIZE_MIN'))
    expect(clamp(9999), 'a huge footprint escapes above DISASTER_SIZE_MAX').toBe(value('DISASTER_SIZE_MAX'))

    // And every disaster's authored size has to go through it, or the band protects nothing.
    const build = scene.slice(scene.indexOf('function buildDisasters('), scene.indexOf('function placeDisasters('))
    for (const [, expression] of build.matchAll(/const size = ([^\n]+)/g)) {
      expect(expression, 'a disaster size bypasses the band').toMatch(/disasterSize\(/)
    }
  })

  /*
   * A pulse floor is only a floor if the animation is written to respect it.
   *
   * `0.62 + Math.sin(t) * 0.38` and `FLAME_PULSE_FLOOR + (1 - FLAME_PULSE_FLOOR) * (...)` both read
   * as "a pulse", and the guard above would keep passing while the first quietly took a part to 24%
   * of its height again. So each pulse is required to be built from its own floor constant, which is
   * what ties the arithmetic above to the geometry below it.
   */
  it.each([
    ['flameMesh', 'FLAME_PULSE_FLOOR'],
    ['jetMesh', 'JET_PULSE_FLOOR'],
  ])('builds %s\'s pulse out of %s so it cannot dip below it', (mesh, floor) => {
    const start = place.indexOf(`if (${mesh}) {`)
    expect(start, `${mesh} should be written by placeDisasters`).toBeGreaterThan(-1)
    const block = place.slice(start, place.indexOf('instanceMatrix.needsUpdate', start))
    const pulse = /const pulse = ([^\n]+)/.exec(block)
    expect(pulse, `${mesh} no longer declares a pulse`).not.toBeNull()
    expect(pulse![1], `${mesh}'s pulse is not anchored to ${floor} and can shrink the part below ` +
      'the height the magnification was measured against').toContain(floor)
    // The oscillating term has to be scaled by the headroom, not added raw on top of the floor.
    expect(pulse![1]).toMatch(new RegExp(`\\(1 - ${floor}\\)`))
  })

  /*
   * A plume that rises straight up is a column in the city view and a dot in map mode, because map
   * mode looks straight down its axis. Leaning it is what gives the overhead view a smear with a
   * direction — measured, map-mode flame coverage went from 76 pixels to 499 when the lean was
   * added. A zero wind vector would restore the dot without failing anything else.
   */
  it('leans the plume, so it is not a dot when seen from directly above', () => {
    const wind = /const DISASTER_WIND = \{ x: (-?[\d.]+), z: (-?[\d.]+) \}/.exec(scene)
    expect(wind, 'DISASTER_WIND has been renamed or removed').not.toBeNull()
    expect(Math.hypot(Number(wind![1]), Number(wind![2]))).toBeGreaterThan(0.25)
    expect(place).toMatch(/DISASTER_WIND\.x/)
    expect(place).toMatch(/DISASTER_WIND\.z/)
  })

  /*
   * And the smoke has to contrast with whatever it is drawn over. The city view is a night sky and
   * the map is white paper, so one colour cannot serve both: the light plume that reads against the
   * sky is the invisible one on the map, and vice versa. Both were measured invisible in turn.
   */
  it('swaps the smoke colour between the night city and the paper map', () => {
    const colors = /const SMOKE_COLOR = \{ city: 0x([0-9a-f]{6}), map: 0x([0-9a-f]{6}) \}/.exec(scene)
    expect(colors, 'SMOKE_COLOR has been renamed or removed').not.toBeNull()
    const luminance = (hex: string) => {
      const value = Number.parseInt(hex, 16)
      return 0.2126 * ((value >> 16) & 0xff) + 0.7152 * ((value >> 8) & 0xff) + 0.0722 * (value & 0xff)
    }
    // Light on the dark city, dark on the light map — not merely two different colours.
    expect(luminance(colors![1])).toBeGreaterThan(luminance(colors![2]) + 60)
    const build = code(scene.slice(
      scene.indexOf('function buildDisasters()'),
      scene.indexOf('function placeDisasters()'),
    ))
    expect(build).toMatch(/smoke\.color\.setHex\(flat \? SMOKE_COLOR\.map : SMOKE_COLOR\.city\)/)
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
