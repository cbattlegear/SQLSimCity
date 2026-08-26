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
   * Object rebuilds, road/traffic/facility/lane/route/incident rebuilds, selection, layer
   * visibility and the map↔city swap all reach the renderer through these methods. Asset arrival
   * and the time-of-day change are not methods, so they are checked separately below.
   */
  it.each([
    ['setObjects', 'a re-plan moves every building'],
    ['setRoads', 'roads cast and receive'],
    ['setTraffic', 'traffic ribbons are geometry'],
    ['setFacilities', 'facility shells are casters'],
    ['setFacilityLanes', 'wait lanes are geometry'],
    ['setRoute', 'a drawn route adds geometry'],
    ['setSelected', 'selection changes what a building looks like'],
    ['setSelectedRoad', 'road highlight changes geometry'],
    ['setLayers', 'toggling a layer changes caster visibility'],
    ['setViewMode', 'map mode turns the shadow map off and city mode turns it back on'],
    ['setIncidents', 'incident markers are objects in the scene'],
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
    const loop = scene.slice(
      scene.indexOf('const runDampingLoop'),
      scene.indexOf("controls.addEventListener('change'"),
    )
    // The loop calls draw() straight, so an orbit renders many frames and invalidates on none.
    expect(loop).toMatch(/\n\s*draw\(\)/)
    expect(loop).not.toMatch(/requestRender\(\)/)
    expect(loop).not.toMatch(/needsUpdate/)
  })
})
