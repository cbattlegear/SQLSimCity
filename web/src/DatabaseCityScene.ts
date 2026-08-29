import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { directActivityWidth } from './databaseCity'
import type { DatabaseCityObject, DatabaseCityQueryFamily } from './databaseCityContracts'
import { ARTERIAL_WIDTH, streetPitch, streetRoute, type CityLot, type CityPlan, type StreetClass } from './cityPlan'
import { buildBuildingGeometry, buildingColor, mapBuildingColor, mixColor, neighborhoodTint } from './cityBuildings'
import { assignQueryRoutes } from './cityQueryTraffic'
import { ROAD_WIDTH, type RoadTraffic } from './cityTraffic'
import type { WorkloadTraffic } from './cityWorkloadTraffic'
import {
  claimLane,
  corridorKeys,
  DASH_PATTERNS,
  laneOffset,
  MAX_LANE,
  offsetPolyline,
} from './cityRoads'
import { ribbonGeometry, ribbonPositions } from './mapRibbon'
import { type Facility, type FacilityKind, type FacilitySite } from './cityInfrastructure'
import { facilityShell, facilitySlots } from './cityFacilityShells'
import { LANDMARK_ASSETS, loadCityAssets, loadVehicleAssets, type AssetKit, type AssetRole, type CityAssets, type SceneryAsset, type VehicleAsset } from './cityAssets'
import {
  buildingLabelText,
  buildingLabelWorldHeight,
  createCityLabels,
  declutterLabels,
  elideMiddle,
  labelAnchor,
  labelPixelHeight,
  labelScreenScale,
  minimumLegibleWorldHeight,
  neighborhoodLabelHeight,
  neighborhoodLabelText,
  LABEL_MAX_CHARS,
  LABEL_WORLD_HEIGHT,
} from './cityLabels'
import type { LabelBox } from './cityLabels'
import type { CityRoute } from './cityRoute'
import {
  LANDUSE_CITY_COLORS,
  LANDUSE_MAP_COLORS,
  MAP_PALETTE,
  MAP_PIN,
  MAP_ROAD,
  MAP_STREET,
  type MapViewMode,
} from './mapStyle'
import {
  CITY_ATMOSPHERE,
  resolveTimeOfDay,
  watchTimeOfDay,
  type CityAtmosphere,
  type TimeOfDay,
} from './timeOfDay'
import type { LandUse, TerrainBlock } from './cityTerrain'
import { stopsTraffic } from './cityIncidents'
import type { IncidentMarker } from './cityIncidents'
import { placeIncident, type IncidentPlacement } from './cityIncidentPlacement'
import {
  buildVehicleRoster,
  pointAt,
  polylineLength,
  travelledFraction,
  VEHICLE_CAP,
  vehiclePaintHue,
  type Vehicle,
  type VehicleClass,
  type VehicleRoster,
} from './cityVehicles'
import type { LiveQueryEvent } from './liveQueryFeed'

export type CityLayerToggles = {
  traffic: boolean
  /**
   * The individual co-reference ribbons. Off by default: a map covered in one ribbon per pair of
   * tables is a picture of the workload's shape, not of its traffic, and the two read as noise
   * together. Turn it on to see which tables are named together; leave it off to read the streets.
   */
  paths: boolean
  infrastructure: boolean
  route: boolean
  /** Ground labels naming each building, facility and neighbourhood. */
  labels: boolean
}

/**
 * How strongly a neighbourhood's hue stains the ground it claims.
 *
 * The 3D city keeps it to a whisper: the buildings are already tinted, and land use — parks, water,
 * woodland — is drawn underneath and has to survive. The basemap can afford more, because it
 * flattens every building to one grey and the wash is then the only thing dividing the map into
 * places.
 *
 * Both are lower than they want to be. A wash strong enough to name a neighbourhood at a glance is
 * also strong enough to erase the land use beneath it, and at that point the map is a colouring book
 * with roads on top. The neighbourhood label carries the identity; the wash only has to group.
 */
const CITY_DISTRICT_OPACITY = 0.11
const MAP_DISTRICT_OPACITY = 0.17

/*
 * Which flat sheet wins where two of them cover the same ground.
 *
 * The basemap is a stack of wafer-thin sheets — the ground plate, land cover, the neighbourhood
 * wash, kerbs, carriageways, centre lines, then traffic over the top — pressed into about a world
 * unit of height. Their order used to be carried by that height alone, and that works only for as
 * long as the depth buffer can still tell a hundredth of a unit apart.
 *
 * It cannot on a large city. Depth resolution falls off with the square of the distance to the
 * fragment, and the camera has to stand back in proportion to the plan in order to frame it, so the
 * coarsest step the buffer can represent at ground level grows roughly linearly with the size of
 * the database. A 900-table instance plans an ~8,000-unit city, which frames from ~11,000 units
 * away, and at that range one representable step is about 0.13 units — wider than the whole stack
 * from kerb to centre line, and ten times the gap between two kinds of land cover. Every sheet then
 * wins and loses per pixel, and because the orbit damping keeps nudging the camera the winner
 * changes every frame: the map strobes. Map mode is worse again, because its 13° lens stands more
 * than three times further back still.
 *
 * Polygon offset settles the order in depth-buffer units instead of world units, so the sheets stay
 * the same distance apart in the only currency the depth test actually spends — whatever the size
 * of the city or the distance of the camera. Nothing moves: the offset applies to the depth a
 * fragment writes and tests against, never to where it draws.
 *
 * Rank 0 is the plane the buildings stand on, and every sheet is pushed *away* from the eye by its
 * rank. Pushing down rather than pulling up is deliberate: nothing here may ever be pulled in front
 * of a building, and map mode flattens buildings to about a hundredth of their height — so what is
 * left of them is thinner than the ambiguity this exists to correct.
 */
export const GROUND_RANK = {
  /** Shared wait lanes, drawn over the exclusive ones they overlap. */
  sharedLane: 1,
  /** Exclusive wait lanes, and the selected building's plate. */
  facilityLane: 2,
  /** Graded road ribbons. Lane order refines this — see `roadRank`. */
  road: 3,
  /** The casing under a road ribbon, and the halo around a selected one. */
  roadCasing: 4,
  /** Aggregate street load. */
  traffic: 5,
  laneMark: 6,
  streetFill: 7,
  streetCasing: 8,
  riverBank: 9,
  /** The neighbourhood wash and the facility pads, which tint land without hiding it. */
  districtWash: 10,
  riverWater: 11,
  landCover: 12,
  /** The countryside plate the whole city sits on. Nothing is under it. */
  plate: 13,
} as const

/**
 * Fixes a material's place in the flat stack.
 *
 * Both terms matter. `polygonOffsetUnits` buys a fixed number of representable depth steps, which is
 * what separates two sheets seen face on; `polygonOffsetFactor` scales with how much depth the
 * polygon covers within a single pixel, which is what separates them towards the horizon, where the
 * ground is so oblique that one pixel spans more depth than the whole stack is thick.
 */
export function sink<M extends THREE.Material>(material: M, rank: number): M {
  material.polygonOffset = true
  material.polygonOffsetFactor = rank
  material.polygonOffsetUnits = rank * 2
  return material
}

/**
 * Road ribbons already step apart by lane so two routes sharing a street stay legible. That step is
 * a fifth of the thinnest gap in the stack, so it needs the same treatment; the fractions stay
 * inside the road's own rank and never reach its neighbours'.
 */
export function roadRank(lane: number): number {
  return GROUND_RANK.road - Math.min(Math.max(lane, 0), 8) * 0.1
}

/*
 * ------------------------------------------------------------------------------------------------
 * The three things drawn on the street, and the order they have to be drawn in.
 * ------------------------------------------------------------------------------------------------
 *
 * `GROUND_RANK` above orders the flat sheets *under* the street by polygon offset, which works
 * because they are coplanar. These three are not coplanar and are not ordered that way: they are
 * separated in `y`, and depth testing decides which one a pixel belongs to. So the ordering is only
 * as good as the arithmetic, and getting it wrong makes something disappear rather than flicker.
 *
 * That is exactly what happened to the light trail. It was pinned at a hard-coded `0.05` under a
 * comment claiming it was "just above the road ribbon", while road ribbons are laid at
 * `ROAD_Y + lane * ROAD_LANE_STEP` and so reach {@link ROAD_TOP_Y} — nearly three times as high. A
 * trail is drawn along the route its vehicle is driving, which is precisely where that route's own
 * ribbon is, so the ribbon sat on top of the wake for its entire length and the trail was visible
 * only where it happened to be wider than the road under it. Measured in Chromium before the fix:
 * of ~906,400 pixels, between 28 and 76 trail-coloured pixels changed from frame to frame — the
 * fringes, and nothing else.
 *
 * Deriving all three from one expression is the point. Two independent literals is what let the
 * ribbon stack grow past the trail without anything saying so.
 */

/** The height of the lowest road ribbon. */
export const ROAD_Y = 0.06
/** How far each additional lane sharing a street is lifted, so coplanar ribbons never z-fight. */
export const ROAD_LANE_STEP = 0.014
/** The highest ribbon any lane can claim. Every lane from 0 to `MAX_LANE` is below this. */
export const ROAD_TOP_Y = ROAD_Y + MAX_LANE * ROAD_LANE_STEP
/**
 * The light trail, clear of the whole ribbon stack rather than of lane zero alone.
 *
 * The gap is small because the trail still has to read as painted *onto* the street rather than
 * floating over it; it only has to beat the depth buffer, not be seen to.
 */
export const TRAIL_Y = ROAD_TOP_Y + 0.006
/**
 * The vehicles, above their own wake.
 *
 * A vehicle is a solid model standing on this point and rising `height * magnify` above it, so this
 * is where it meets the road and not where it is seen. Keeping it over {@link TRAIL_Y} means a car
 * sits on its trail instead of inside it, and the brightest end of the ribbon — the flare, at the
 * bumper — is not swallowed by the shell it is supposed to be trailing from.
 */
export const VEHICLE_Y = TRAIL_Y + 0.01

export type CameraNudge =
  | 'panLeft'
  | 'panRight'
  | 'panUp'
  | 'panDown'
  | 'zoomIn'
  | 'zoomOut'
  | 'rotateLeft'
  | 'rotateRight'

export type DatabaseCitySceneController = {
  /**
   * Takes the plan the surrounding view already computed rather than planning again. `planCity` is
   * the expensive part of drawing a city, and the view needs the same plan for the address book,
   * the route, and the traffic map, so planning it here too did the whole layout twice per update.
   */
  setObjects(objects: readonly DatabaseCityObject[], cityPlan: CityPlan): void
  /** Roads are graded outside the scene so the map and the HUD read the same numbers. */
  setRoads(roads: readonly RoadTraffic[]): void
  /** The aggregate street-load layer built from the workload's executions and apportioned waits. */
  setTraffic(traffic: WorkloadTraffic): void
  setFacilities(facilities: readonly Facility[]): void
  setRoute(route: CityRoute | null): void
  setSelected(objectId: string | null): void
  /** Highlights one road and pins both of its endpoints. */
  setSelectedRoad(routeId: string | null): void
  /**
   * Weathers the buildings whose statistics are stale. Per object rather than a whole-city flag,
   * because a city-wide wash would weather buildings whose statistics are fresh.
   */
  setStaleStatsObjects(objectIds: readonly string[]): void
  setLayers(layers: Partial<CityLayerToggles>): void
  /** Live incident pins, placed on the road between the parties rather than on a roof. */
  setIncidents(markers: readonly IncidentMarker[]): void
  /**
   * The observed live executions and the page's query families, from which the vehicle roster is
   * built.
   *
   * Deliberately not a roster: the roster has to be joined against the roads *as this scene drew
   * them*, and only the scene has those polylines. The result comes back out through
   * `onVehicleRoster` so the legend can disclose what was dropped and why.
   */
  setVehicles(events: readonly LiveQueryEvent[] | null, families: readonly DatabaseCityQueryFamily[]): void
  /**
   * Where one incident pin ended up and which rung of the placement ladder put it there, or null
   * when it is not drawn. The popup states the rung, because a pin on the measured road between two
   * named objects and a pin at an object's kerb are different claims.
   */
  incidentPlacement(id: string): IncidentPlacement | null
  /**
   * Screen position of one incident pin, or null when it is not drawn or is behind the camera.
   * Used to anchor the HTML popup over the canvas.
   */
  incidentScreenPosition(id: string): { x: number; y: number } | null
  /**
   * Switches between the flat basemap drawing and the oblique 3D city.
   *
   * Both modes draw the same plan and the same measurements; only colour, massing, and camera
   * change. Nothing a mode shows is unavailable in the other.
   */
  setViewMode(mode: MapViewMode): void
  /** Frames the whole city. Only ever called on first load or from an explicit user action. */
  resetView(): void
  /** Frames the currently drawn GPS route. No-op when there is none. */
  frameRoute(): void
  /** Frames one road and both of the buildings it connects. */
  frameRoad(routeId: string): void
  /** Centres the camera on one building without changing zoom. */
  focusObject(objectId: string): void
  nudge(action: CameraNudge): void
  /** Compass heading in degrees; 0 means the camera looks north. */
  heading(): number
  getPlan(): CityPlan | null
  dispose(): void
}

type SceneOptions = {
  onSelect: (objectId: string) => void
  onCameraChange?: () => void
  /** Fired with a road's id when one is clicked, and with null when the click missed everything. */
  onSelectRoad?: (routeId: string | null) => void
  onHoverRoad?: (routeId: string | null) => void
  /** Fired with an incident marker id when its pin is clicked, and with null when a click misses. */
  onSelectIncident?: (incidentId: string | null) => void
  /**
   * Fired whenever the vehicle roster is rebuilt — on a new live sample, and also when the roads
   * underneath it are redrawn, because a vehicle is only ever placed on a road this scene drew.
   */
  onVehicleRoster?: (roster: VehicleRoster) => void
}

export function createDatabaseCityScene(
  canvas: HTMLCanvasElement,
  options: SceneOptions,
): DatabaseCitySceneController {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  // Soft shadows are the whole point of a low sun: they are what turns a field of extruded boxes into
  // a city with depth. Enabled here and switched off per-frame in map mode, where a printed basemap
  // casts nothing.
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  /*
   * The shadow map is regenerated when something that casts into it changes, not every frame.
   *
   * A directional sun's shadow map is a function of the casters and the light, and of neither the
   * camera nor the canvas. Left on `autoUpdate`, three.js redraws all 948 casters into a 2048²
   * depth target on every frame — and a damped orbit is dozens of frames in a row in which nothing
   * casting has moved. Measured over a 4,200-object city that pass is 7.6 ms of a 138 ms frame and
   * 948 of 22,406 draw calls; see `tools/measure-browser`.
   *
   * The danger in this switch is a missed invalidation, which shows as shadows that quietly belong
   * to a city that is no longer on screen — worse than the cost it saves. So the default is
   * inverted: `requestRender()` invalidates unless a caller explicitly says the camera alone moved.
   * Every scene mutation already funnels through `requestRender()`, so a new one is covered by
   * construction, and the failure mode of forgetting is an extra shadow pass — exactly the
   * behaviour this replaces — rather than a stale one.
   */
  renderer.shadowMap.autoUpdate = false
  renderer.shadowMap.needsUpdate = true

  const reducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  /*
   * The hour the city is standing in.
   *
   * Read from the clock on the machine looking at it, and re-read on a timer further down so a tab
   * left open crosses into the next phase on its own. The light is decoration and encodes nothing —
   * the sun sits in the same place for a healthy instance and a failing one at the same hour. See
   * `timeOfDay.ts` for why the four looks are four *rigs* rather than four palettes.
   */
  let timeOfDay: TimeOfDay = resolveTimeOfDay(new Date())

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x070b11)
  const camera = new THREE.PerspectiveCamera(46, 1, 1, 8000)
  camera.position.set(240, 260, 340)

  const controls = new OrbitControls(camera, canvas)
  controls.enableDamping = !reducedMotion
  controls.dampingFactor = 0.08
  controls.screenSpacePanning = false
  /*
   * Placeholder clamps only. Both ends are recomputed by `applyZoomRange()` from the size of the
   * city and the field of view currently in effect — see the note there for why a fixed pair of
   * distances cannot work across the two view modes.
   */
  controls.minDistance = 24
  controls.maxDistance = 4000
  // Never let the camera drop below the horizon: a city viewed from underground is disorienting.
  controls.maxPolarAngle = Math.PI / 2 - 0.05

  /*
   * Depth range, set from the orbit distance rather than left wide open.
   *
   * The ground is half a dozen wafer-thin layers stacked inside a single world unit — land cover,
   * kerb, carriageway, centre line — and the depth buffer is the only thing keeping them in order.
   * A far/near ratio in the tens of thousands leaves so little precision at ground level that the
   * layers start trading places across the map, which is what turned the flat basemap into stripes.
   * Keeping the ratio near a thousand costs nothing visible: everything past the fog is haze anyway.
   */
  function setDepthRange(distance: number) {
    camera.near = Math.max(1, distance / 200)
    camera.far = distance * 8
    camera.updateProjectionMatrix()
  }
  controls.minPolarAngle = 0.05
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }

  /*
   * The lighting rig.
   *
   * The 3D city is lit as a real hour rather than as a neutral studio, because a directional sun is
   * the cheapest and most honest depth cue available: every building's own shadow states its height
   * a second time, and the ~47% of ground that carries no building finally has something on it. The
   * light is decoration and encodes nothing — the sun sits in the same place for a healthy instance
   * and a failing one at the same hour.
   *
   * Which hour is `timeOfDay`, and every colour and intensity below is overwritten by
   * `applyAtmosphere()` before the first frame. They are constructed at the evening values, which is
   * the golden hour the city has always been drawn in, so that a scene which somehow never reaches
   * that call still renders the historical look rather than black.
   *
   * Shadow fill is as deliberate as the key. A low sun paired with a weak sky turns every shadow
   * into a navy void, and since roughly half the ground is in shadow at that hour it erases half the
   * map. So the hemisphere is pitched bright with a warm bounce underneath at every phase, and at
   * night it is the *only* thing keeping the ground readable — see `timeOfDay.ts`.
   */
  const cityAtmosphere = () => CITY_ATMOSPHERE[timeOfDay]
  const hemiLight = new THREE.HemisphereLight(0xa8b6c9, 0x6a5a45, 1.75)
  scene.add(hemiLight)
  const keyLight = new THREE.DirectionalLight(0xffc286, 2.2)
  keyLight.position.set(560, 320, 250)
  keyLight.castShadow = true
  keyLight.shadow.mapSize.set(2048, 2048)
  keyLight.shadow.bias = -0.0012
  keyLight.shadow.normalBias = 0.6
  scene.add(keyLight)
  scene.add(keyLight.target)
  const fillLight = new THREE.DirectionalLight(0x8aa6d2, 0.5)
  fillLight.position.set(-300, 260, -280)
  scene.add(fillLight)

  /*
   * The sky.
   *
   * An inside-out sphere with the gradient baked into its vertex colours: no shader, no texture, no
   * extra request. It rides with the camera and is scaled off the far plane, so it never clips no
   * matter how far out the city is framed.
   *
   * The warm band is deliberately narrow. A golden hour is warm *at the horizon* and deep blue
   * overhead — spread the orange across the whole dome and it stops reading as a sunset and starts
   * reading as a wall. The same holds for the other three hours: the phase changes what the band is
   * *made of*, never how wide it is.
   *
   * Below the horizon the dome is not sky at all — it is the haze that distant ground dissolves
   * into, and at this camera angle it is most of what you see. It has to obey aerial perspective,
   * which means distance makes ground *lighter and warmer*, not darker: the band is brightest right
   * at the horizon and settles toward the colour of the land as it comes back down towards the
   * viewer. Painting it dark turned the whole background into a muddy wall.
   *
   * Baked rather than shaded, so a phase change has to re-bake. It is 24×20 vertices and happens at
   * most four times a day.
   */
  const skyGeometry = new THREE.SphereGeometry(1, 24, 20)
  function paintSkyDome(atmosphere: CityAtmosphere) {
    const zenith = new THREE.Color(atmosphere.skyZenith)
    const upper = new THREE.Color(atmosphere.skyUpper)
    const horizon = new THREE.Color(atmosphere.skyHorizon)
    const hazeNear = new THREE.Color(atmosphere.hazeNear)
    const hazeFar = new THREE.Color(atmosphere.hazeFar)
    const position = skyGeometry.getAttribute('position')
    const existing = skyGeometry.getAttribute('color') as THREE.BufferAttribute | undefined
    const colors = existing ? (existing.array as Float32Array) : new Float32Array(position.count * 3)
    const color = new THREE.Color()
    for (let index = 0; index < position.count; index += 1) {
      const y = position.getY(index)
      if (y >= 0) {
        // Two stops rather than one: warm to dusk-blue in the first few degrees, dusk-blue to
        // near-black over the rest of the dome.
        const low = Math.min(1, Math.pow(y, 0.28))
        color.copy(horizon).lerp(upper, low).lerp(zenith, Math.pow(y, 1.4))
      } else {
        color.copy(hazeNear).lerp(hazeFar, Math.min(1, Math.pow(-y, 0.5)))
      }
      colors[index * 3] = color.r
      colors[index * 3 + 1] = color.g
      colors[index * 3 + 2] = color.b
    }
    if (existing) existing.needsUpdate = true
    else skyGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  }
  paintSkyDome(cityAtmosphere())
  const skyDome = new THREE.Mesh(
    skyGeometry,
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false, fog: false }),
  )
  skyDome.renderOrder = -1
  scene.add(skyDome)

  /**
   * Haze at the edge of the city, so the ground fades into the horizon rather than ending at a hard
   * edge. Tinted to the band it is dissolving into, which is why it is a phase value and not a
   * constant: a warm fog under a night sky reads as a city on fire.
   */
  const cityFog = new THREE.Fog(cityAtmosphere().fogColor, 900, 3200)
  /*
   * City mode is the mode the scene opens in, and `applyViewMode` only runs on a *change* — so the
   * atmosphere has to be armed here or the first view of every city renders with no fog, which is
   * what left the ground plane sitting in the sky as a hard-edged slab.
   */
  scene.fog = cityFog
  scene.background = new THREE.Color(cityAtmosphere().background)
  /**
   * Map mode's only light.
   *
   * The intensity is π on purpose, not 1. Three.js resolves ambient light through the Lambert BRDF,
   * which divides by π, so an intensity of 1 renders every surface at about a third of its own
   * colour — that is what turned the paper basemap into wet asphalt. Cancelling the divide is what
   * makes a lit material draw as exactly its base colour, which is the unlit look a basemap needs
   * without swapping every material's class.
   */
  const ambientLight = new THREE.AmbientLight(0xffffff, Math.PI)
  ambientLight.visible = false
  scene.add(ambientLight)

  const materials = {
    unknown: new THREE.MeshBasicMaterial({ color: 0x6e7d88, wireframe: true }),
    window: new THREE.MeshStandardMaterial({
      color: 0xd8e8f4,
      emissive: 0x2f4f6a,
      emissiveIntensity: 1,
      roughness: 0.25,
    }),
    trim: new THREE.MeshStandardMaterial({ color: 0x93a1ae, roughness: 0.6 }),
    index: new THREE.MeshStandardMaterial({ color: 0x68d6c1, roughness: 0.5 }),
    unknownIndex: new THREE.MeshBasicMaterial({ color: 0x82919d, wireframe: true }),
    exposure: new THREE.MeshStandardMaterial({ color: 0xe2a957, emissive: 0x3a2400, roughness: 0.55 }),
    // Wireframe carries the same meaning here as on unknownIndex and facilityUnknown: the figure it
    // draws was never measured for this building. Shared exposure belongs to the queries that named
    // it alongside other tables, so it is outlined rather than solid.
    sharedExposure: new THREE.MeshBasicMaterial({ color: 0xe2a957, wireframe: true }),
    // The plane the city sits on runs past the fog in every direction, so it is doing the job of
    // countryside rather than of floor. Kept close in value to the built parcels it abuts: a big
    // value step at the plan boundary turns the city into a rug thrown on a floor.
    ground: sink(new THREE.MeshStandardMaterial({ color: 0x7e7c58, roughness: 0.98 }), GROUND_RANK.plate),
    asphalt: new THREE.MeshStandardMaterial({ color: 0x6a6a71, roughness: 0.95 }),
    laneMark: sink(
      new THREE.MeshStandardMaterial({ color: 0xc4c0b3, roughness: 0.85 }),
      GROUND_RANK.laneMark,
    ),
    sidewalk: new THREE.MeshStandardMaterial({ color: 0x8d8a81, roughness: 0.9 }),
    civicPad: sink(
      new THREE.MeshBasicMaterial({ color: 0x2b4a63, transparent: true, opacity: 0.15 }),
      GROUND_RANK.districtWash,
    ),
    facility: new THREE.MeshStandardMaterial({ color: 0x53707f, roughness: 0.62 }),
    facilityUnknown: new THREE.MeshBasicMaterial({ color: 0x7d8b96, wireframe: true }),
    facilityFill: new THREE.MeshStandardMaterial({ color: 0x63d8ff, emissive: 0x11455c, roughness: 0.35 }),
    facilityAlert: new THREE.MeshStandardMaterial({ color: 0xe4483c, emissive: 0x4a0f0a, roughness: 0.4 }),
    route: new THREE.MeshBasicMaterial({ color: 0x2fe0ff, transparent: true, opacity: 0.92 }),
    routePin: new THREE.MeshStandardMaterial({ color: 0x2fe0ff, emissive: 0x0d5f70, roughness: 0.3 }),
    roadHighlight: sink(
      new THREE.MeshBasicMaterial({ color: 0xf4f9ff, transparent: true, opacity: 0.5 }),
      GROUND_RANK.roadCasing,
    ),
    roadPin: new THREE.MeshStandardMaterial({ color: 0xf4f9ff, emissive: 0x5d7183, roughness: 0.3 }),
    roadPinOffMap: new THREE.MeshStandardMaterial({ color: 0xb0bcc7, emissive: 0x39434d, roughness: 0.45 }),
    selection: sink(
      new THREE.MeshBasicMaterial({ color: 0xffd479, transparent: true, opacity: 0.26 }),
      GROUND_RANK.facilityLane,
    ),
    selectionPin: new THREE.MeshStandardMaterial({ color: 0xffd479, emissive: 0x6b4a06, roughness: 0.35 }),

    /*
     * Materials for the authored `.glb` kits.
     *
     * `flatShading` is not a style choice here, it is the contract: the kits ship without a normal
     * attribute (see `cityAssets.ts`), so three.js has to derive face normals in the fragment shader.
     * They are separate from the materials above because the procedural fallback shells *do* carry
     * smooth normals, and faceting a cylinder that was authored round looks like a bug.
     */
    kitBody: new THREE.MeshStandardMaterial({ color: 0x5b7a8c, roughness: 0.66, flatShading: true }),
    kitTrim: new THREE.MeshStandardMaterial({ color: 0x93a1ae, roughness: 0.58, flatShading: true }),
    kitGlass: new THREE.MeshStandardMaterial({
      color: 0xd8e8f4,
      emissive: 0x2f4f6a,
      roughness: 0.22,
      flatShading: true,
    }),
    kitMetal: new THREE.MeshStandardMaterial({
      color: 0x8b98a4,
      roughness: 0.42,
      metalness: 0.5,
      flatShading: true,
    }),
    kitTrunk: new THREE.MeshStandardMaterial({ color: 0x5b4634, roughness: 0.92, flatShading: true }),
    kitLeaf: new THREE.MeshStandardMaterial({ color: 0x4f7f4a, roughness: 0.88, flatShading: true }),
    kitWater: new THREE.MeshStandardMaterial({
      color: 0x2f6d8c,
      roughness: 0.14,
      metalness: 0.3,
      flatShading: true,
    }),

    /*
     * Live vehicles.
     *
     * Deliberately *not* the kit materials the parked cars use, even though a driving car and a
     * parked one are the same silhouette. A parked car is decoration and a driving one is a sampled
     * running request, and the two must not be confusable — least of all under reduced motion, where
     * the vehicle stands still and motion can no longer tell them apart. So live vehicles are the
     * one bright, near-white thing on a street, and everything decorative around them is the cool
     * blue-grey of the kit.
     */
    vehicleBody: new THREE.MeshStandardMaterial({ color: 0xe8eef4, roughness: 0.45, flatShading: true }),
    vehicleTrim: new THREE.MeshStandardMaterial({ color: 0xb4c2cf, roughness: 0.5, flatShading: true }),
    vehicleGlass: new THREE.MeshStandardMaterial({
      color: 0x5f7f97,
      emissive: 0x16303f,
      roughness: 0.28,
      flatShading: true,
    }),
    vehicleMetal: new THREE.MeshStandardMaterial({
      color: 0x4c565f,
      roughness: 0.5,
      metalness: 0.4,
      flatShading: true,
    }),
    /*
     * The vehicle drawn when the retained plans did not state how much data one execution moves.
     *
     * Featureless and grey on purpose. Every authored vehicle carries a length that means something,
     * so an unknown drawn as any of them would be read as that band; a shape that is on none of the
     * rungs is the only honest way to say the ladder was never entered. It is not a bicycle: absent
     * means "the plans did not say", which is not "this query moves very little".
     */
    vehicleUnknown: new THREE.MeshStandardMaterial({ color: 0x99a3ab, roughness: 0.78 }),
  }

  /*
   * Ground cover.
   *
   * One material per land use rather than vertex colours baked into a single terrain mesh: the two
   * view modes need two entirely different palettes, and swapping a colour on ten materials is free
   * where rebuilding a vertex-colour buffer across thousands of blocks is not.
   *
   * None of this is measured. Land use is drawn from the database id's seed, exactly like block
   * placement, and the legend says so.
   */
  const LAND_USES = Object.keys(LANDUSE_CITY_COLORS) as LandUse[]
  const landMaterials = Object.fromEntries(
    LAND_USES.map(use => [
      use,
      sink(
        new THREE.MeshStandardMaterial({ color: LANDUSE_CITY_COLORS[use], roughness: 0.95, vertexColors: true }),
        GROUND_RANK.landCover,
      ),
    ]),
  ) as Record<LandUse, THREE.MeshStandardMaterial>
  // Water is the one cover that should catch the sun rather than absorb it.
  landMaterials.water.roughness = 0.16
  landMaterials.water.metalness = 0.35

  /*
   * The river carries the same two covers as the blocks it crosses — but it *crosses* them, and two
   * sheets that overlap cannot share a rank without fighting over the overlap. So it gets its own
   * pair, kept in step with the originals whenever the palette changes.
   */
  const riverMaterials = {
    water: sink(landMaterials.water.clone(), GROUND_RANK.riverWater),
    bank: sink(landMaterials.yard.clone(), GROUND_RANK.riverBank),
  }

  /*
   * Street hierarchy.
   *
   * A map without a road hierarchy is a diagram: every line the same weight, nothing to navigate by.
   * Each class gets a fill and a casing, and the casing table is what carries the difference in map
   * mode — white arterials over a dark casing, quieter greys for collectors, exactly the way a
   * printed basemap grades its roads.
   *
   * Street *class* is a plan property, not a measurement. What a road carries — executions, dash
   * confidence, congestion colour — is drawn in `roadGroup` and is untouched by any of this.
   */
  const STREET_CLASSES: readonly StreetClass[] = ['motorway', 'primary', 'secondary', 'tertiary', 'residential', 'service']
  /*
   * The ground layer is lit almost entirely by skylight.
   *
   * At golden hour the sun grazes the city, so vertical faces catch it and horizontal ones barely
   * do — which is correct, and which means every one of these colours renders far darker than it
   * reads here. They are pitched light on purpose so that paving, kerbs and land cover still
   * separate from each other once the low sun has taken most of their value away.
   */
  /*
   * Carriageways are warm mid-greys, not the blue-black they look like from a car at night.
   *
   * Seen from the air a road is a *light* line across darker ground — dry concrete and weathered
   * asphalt, closer to stone than to tar. Painting them dark makes the road network the figure and
   * the land the background, which is exactly backwards: on a map the land is the subject and the
   * roads are the lines you read it with. Casings are the kerb and pavement, so they run lighter
   * still, and the hierarchy stays legible through width rather than through value.
   */
  const CITY_STREET: Record<StreetClass, { fill: number; casing: number }> = {
    motorway: { fill: 0x78787c, casing: 0x9c988e },
    primary: { fill: 0x747479, casing: 0x979389 },
    secondary: { fill: 0x6f6f75, casing: 0x929086 },
    tertiary: { fill: 0x6b6b71, casing: 0x8e8b82 },
    residential: { fill: 0x66666d, casing: 0x89867e },
    service: { fill: 0x616168, casing: 0x84817a },
  }
  const streetFill = Object.fromEntries(
    STREET_CLASSES.map(klass => [
      klass,
      sink(new THREE.MeshStandardMaterial({ color: CITY_STREET[klass].fill, roughness: 0.94 }), GROUND_RANK.streetFill),
    ]),
  ) as Record<StreetClass, THREE.MeshStandardMaterial>
  const streetCasing = Object.fromEntries(
    STREET_CLASSES.map(klass => [
      klass,
      sink(new THREE.MeshStandardMaterial({ color: CITY_STREET[klass].casing, roughness: 0.92 }), GROUND_RANK.streetCasing),
    ]),
  ) as Record<StreetClass, THREE.MeshStandardMaterial>

  /**
   * One material per drawn body colour, carrying both looks.
   *
   * The city colour is the cache key; the basemap colour rides along in `userData` because it cannot
   * be recovered from the city colour once the neighbourhood hue has been mixed in. Materials are
   * created in whichever mode is current, so buildings that arrive after a mode switch are not left
   * painted for the mode the scene is no longer in.
   */
  const archetypeMaterials = new Map<number, THREE.MeshStandardMaterial>()
  const bodyMaterial = (color: number, mapColor: number) => {
    let material = archetypeMaterials.get(color)
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color: viewMode === 'map' ? mapColor : color,
        roughness: 0.78,
        metalness: 0.06,
      })
      material.userData.mapColor = mapColor
      archetypeMaterials.set(color, material)
    }
    return material
  }
  const roadMaterials = new Map<number, THREE.MeshBasicMaterial>()
  /**
   * Ribbon materials, cached by colour, fade *and* depth rank.
   *
   * Rank is part of the key rather than a property set at draw time because traffic, roads and the
   * two kinds of wait lane are four sheets stacked within a quarter of a world unit that all draw
   * from this one factory. Sharing a material across them would share a rank, and they would be back
   * to settling their order in world units the depth buffer cannot resolve.
   */
  const roadMaterial = (color: number, faded: boolean, rank: number) => {
    const cacheKey = (color * 2 + (faded ? 1 : 0)) * 1000 + Math.round(rank * 10)
    let material = roadMaterials.get(cacheKey)
    if (!material) {
      material = sink(
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: faded ? 0.6 : 0.92 }),
        rank,
      )
      roadMaterials.set(cacheKey, material)
    }
    return material
  }
  /**
   * One wash material per neighbourhood hue.
   *
   * Basic rather than standard: this is a stain on the ground, and a stain that took the sun would
   * turn into a slab lit differently from the land it sits on.
   */
  const districtMaterials = new Map<number, THREE.MeshBasicMaterial>()
  const districtMaterial = (color: number) => {
    let material = districtMaterials.get(color)
    if (!material) {
      material = sink(new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: viewMode === 'map' ? MAP_DISTRICT_OPACITY : CITY_DISTRICT_OPACITY,
        depthWrite: false,
      }), GROUND_RANK.districtWash)
      districtMaterials.set(color, material)
    }
    return material
  }

  /**
   * The two looks.
   *
   * Map mode is not the 3D city seen from above — it is a different drawing of the same plan:
   * paper-grey land, white carriageways over grey casings, flattened footprint plates, and POI pins.
   * The switch changes colour, massing, and camera. It never changes a measurement: footprints,
   * road widths, congestion colours, and wait-lane widths are computed once, outside this file, and
   * both modes draw exactly those numbers.
   */
  const CITY_COLORS: Record<string, number> = {    unknown: 0x6e7d88, window: 0xd8e8f4, trim: 0x93a1ae, index: 0x68d6c1, unknownIndex: 0x82919d,
    exposure: 0xe2a957, ground: 0x7e7c58, asphalt: 0x6a6a71, laneMark: 0xc4c0b3, sidewalk: 0x8d8a81,
    sharedExposure: 0xe2a957,
    civicPad: 0x2b4a63, facility: 0x53707f, facilityUnknown: 0x7d8b96, facilityFill: 0x63d8ff,
    facilityAlert: 0xe4483c, route: 0x2fe0ff, routePin: 0x2fe0ff, roadHighlight: 0xf4f9ff,
    roadPin: 0xf4f9ff, roadPinOffMap: 0xb0bcc7, selection: 0xffd479, selectionPin: 0xffd479,
    kitBody: 0x5b7a8c, kitTrim: 0x93a1ae, kitGlass: 0xd8e8f4, kitMetal: 0x8b98a4,
    kitTrunk: 0x5b4634, kitLeaf: 0x4f7f4a, kitWater: 0x2f6d8c,
    vehicleBody: 0xe8eef4, vehicleTrim: 0xb4c2cf, vehicleGlass: 0x5f7f97, vehicleMetal: 0x4c565f,
    vehicleUnknown: 0x99a3ab,
  }
  const MAP_COLORS: Record<string, number> = {
    unknown: 0x9aa4ac, window: 0xdfe6ec, trim: 0xb9bdc2, index: 0x63b9a6, unknownIndex: 0xa8b0b6,
    exposure: 0xd99a3f, ground: MAP_PALETTE.ground, asphalt: MAP_PALETTE.roadFill,
    sharedExposure: 0xd99a3f,
    laneMark: 0xdcd9d2, sidewalk: MAP_PALETTE.roadCasing, civicPad: MAP_PALETTE.park,
    facility: MAP_PALETTE.facility, facilityUnknown: 0x9fb0c0, facilityFill: 0x4a90d9,
    facilityAlert: MAP_PALETTE.pinIncident, route: 0x1a73e8, routePin: 0x1a73e8,
    roadHighlight: 0x202124, roadPin: 0x202124, roadPinOffMap: 0x8a8f94,
    selection: 0xffb300, selectionPin: 0xffb300,
    // Landmarks flatten to a civic plate in map mode, so the whole kit resolves to the two greys a
    // basemap uses for a building and its outline rather than to six separate materials.
    kitBody: MAP_PALETTE.facility, kitTrim: MAP_PALETTE.facilityEdge, kitGlass: 0xdfe6ec,
    kitMetal: MAP_PALETTE.facilityEdge, kitTrunk: 0x9aa892, kitLeaf: MAP_PALETTE.park,
    kitWater: MAP_PALETTE.water,
    // A near-white vehicle disappears on a printed basemap, so the whole ladder inverts to the dark
    // ink a basemap uses for a moving thing. The unknown stays a mid grey in both modes.
    vehicleBody: 0x263238, vehicleTrim: 0x546069, vehicleGlass: 0x7d8b95, vehicleMetal: 0x39424a,
    vehicleUnknown: 0x8a8f94,
  }
  /** Emissive glow is a night-city effect. Map mode has no light source to glow against. */
  const CITY_EMISSIVE: Record<string, number> = {
    window: 0x2f4f6a, exposure: 0x3a2400, facilityFill: 0x11455c, facilityAlert: 0x4a0f0a,
    routePin: 0x0d5f70, roadPin: 0x5d7183, roadPinOffMap: 0x39434d, selectionPin: 0x6b4a06,
    kitGlass: 0x2f4f6a, vehicleGlass: 0x16303f,
  }

  let viewMode: MapViewMode = 'city'

  /**
   * The oblique angle the 3D city is viewed from, and the heading carried across a mode switch.
   * Kept as angles rather than a direction vector so map mode — which has no readable azimuth of its
   * own — can hand the heading back when you return to the city.
   */
  const DEFAULT_POLAR = 0.848
  const DEFAULT_AZIMUTH = 0.595
  let cityAzimuth = DEFAULT_AZIMUTH

  /**
   * How much further out than a whole-city framing you may pull the camera.
   *
   * Enough to get clear air around the city and see its outline against the ground, without letting
   * it shrink to a smudge in the middle of an empty viewport.
   */
  const ZOOM_OUT_HEADROOM = 2.4
  /**
   * Ground span, in world units, still visible when zoomed all the way in.
   *
   * About one lot: close enough to read a single building's facade and its address label, and short
   * of the point where the camera slips inside the massing and the city turns into wallpaper.
   */
  const MIN_VISIBLE_SPAN = 26

  /** POI pins, drawn in map mode only. A flat plate needs a marker to be findable. */
  const poiGroup = new THREE.Group()
  poiGroup.visible = false
  scene.add(poiGroup)

  /**
   * Live incident pins. Unlike POI pins these are drawn in *both* modes: a blocked waiter is the
   * one thing on this map worth interrupting you for, and hiding it behind a mode switch would be a
   * way of not telling you.
   *
   * They sit on the **road** rather than on a roof — see {@link ./cityIncidentPlacement} for why and
   * for the fallback ladder — and they are sprites, so they face the camera from every angle and
   * stay the same shape whether the city is drawn flat or in 3D.
   */
  const incidentGroup = new THREE.Group()
  scene.add(incidentGroup)
  const incidentPickable: THREE.Object3D[] = []
  const incidentAnchors = new Map<string, THREE.Vector3>()
  const incidentPlacements = new Map<string, IncidentPlacement>()

  /**
   * Two pins, not four.
   *
   * Blocking of any kind — a plain blocked waiter or a cycle in the live wait graph — is a yellow
   * warning, because it is happening now and may clear on its own. A deadlock the engine already
   * recorded is a red crash, because a transaction was killed and it is not going to clear. Grading
   * live blocking into several reds would put the loudest colour on the least certain claim.
   */
  const INCIDENT_PIN_STYLE: Record<IncidentMarker['severity'], { glyph: string; color: string; ink: string }> = {
    blocked: { glyph: '⚠', color: '#e8b13a', ink: '#231704' },
    waiting: { glyph: '⚠', color: '#e8b13a', ink: '#231704' },
    cycle: { glyph: '⚠', color: '#e8b13a', ink: '#231704' },
    deadlock: { glyph: '💥', color: '#e4483c', ink: '#f7e9e7' },
  }

  const INCIDENT_PIN_PX = 96
  const incidentPinMaterials = new Map<string, THREE.SpriteMaterial | null>()

  /** Rasterizes one pin face, cached per severity. Null when the browser refuses a 2D context. */
  function incidentPinMaterial(severity: IncidentMarker['severity']): THREE.SpriteMaterial | null {
    const cached = incidentPinMaterials.get(severity)
    if (cached !== undefined) return cached

    const style = INCIDENT_PIN_STYLE[severity]
    const canvas = document.createElement('canvas')
    canvas.width = INCIDENT_PIN_PX
    canvas.height = INCIDENT_PIN_PX
    const context = canvas.getContext('2d')
    if (!context) {
      incidentPinMaterials.set(severity, null)
      return null
    }

    const centre = INCIDENT_PIN_PX / 2
    context.beginPath()
    context.arc(centre, centre, centre - 6, 0, Math.PI * 2)
    context.fillStyle = style.color
    context.fill()
    // A dark ring so the pin survives being drawn over its own road, which is the same colour family.
    context.lineWidth = 6
    context.strokeStyle = 'rgba(7, 11, 17, 0.9)'
    context.stroke()

    context.font = `700 ${Math.round(INCIDENT_PIN_PX * 0.56)}px "Segoe UI Symbol", "Segoe UI", system-ui, sans-serif`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillStyle = style.ink
    context.fillText(style.glyph, centre, centre + 2)

    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.generateMipmaps = false
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      // An incident that a building hides is an incident you were not told about, so the pin ignores
      // the depth buffer for the same reason a label does.
      depthTest: false,
    })
    material.toneMapped = false
    incidentPinMaterials.set(severity, material)
    return material
  }

  /** World size of one pin face. Big enough to find from the default framing, small enough to sit on a road. */
  const INCIDENT_PIN_WORLD = 13

  function buildIncidents(markers: readonly IncidentMarker[]) {
    clearGroup(incidentGroup)
    incidentPickable.length = 0
    incidentAnchors.clear()
    incidentPlacements.clear()
    blockedPlacements.clear()
    if (!plan) return

    // The roads as they were actually drawn, so a pin lands on the ribbon a reader can see rather
    // than on the straight line between two lots that nothing draws.
    const placementRoads = [...roadPaths.values()].map(entry => ({
      routeId: entry.road.routeId,
      fromObjectId: entry.road.fromObjectId,
      toId: entry.road.toId,
      executions: entry.road.executions,
      polyline: entry.polyline,
    }))

    for (const marker of markers) {
      const lot = plan.lots.get(marker.objectId)
      if (!lot) continue
      const placement = placeIncident(
        marker.objectId,
        marker.counterpartObjectIds,
        { x: lot.accessX, z: lot.accessZ },
        placementRoads,
      )
      if (!placement) continue
      const material = incidentPinMaterial(marker.severity)
      if (!material) continue

      // Map mode flattens the buildings, so the pin comes down with them; in 3D it clears a low
      // building without floating so high that it stops looking like it is on the road.
      const y = viewMode === 'map' ? 7 : 17
      const pin = new THREE.Sprite(material)
      pin.position.set(placement.x, y, placement.z)
      pin.scale.set(INCIDENT_PIN_WORLD, INCIDENT_PIN_WORLD, 1)
      pin.renderOrder = 6
      pin.userData.incidentId = marker.id
      incidentGroup.add(pin)
      incidentPickable.push(pin)
      incidentAnchors.set(marker.id, new THREE.Vector3(placement.x, y + INCIDENT_PIN_WORLD * 0.5, placement.z))
      incidentPlacements.set(marker.id, placement)
      /*
       * Remember where each *live* block was pinned, so a blocked request's vehicle can stop at the
       * same point rather than computing its own answer from the same inputs and drifting from it.
       *
       * Which markers qualify is `stopsTraffic`'s rule, not this loop's — see `cityIncidents.ts`
       * for why a recorded deadlock graph is excluded and a live wait cycle is not. It lives there
       * so all four severities can be covered by a test; a conditional here could only be pinned by
       * asserting on source text.
       */
      if (stopsTraffic(marker)) {
        for (const sessionId of marker.sessionIds) blockedPlacements.set(sessionId, placement)
      }
    }
  }

  function addPoiPin(x: number, z: number, color: number, radius: number, height: number) {
    const material = poiMaterial(color)
    const stem = new THREE.Mesh(track(new THREE.ConeGeometry(radius * 0.62, height * 0.62, 12)), material)
    stem.position.set(x, height * 0.31, z)
    stem.rotation.x = Math.PI
    const head = new THREE.Mesh(track(new THREE.SphereGeometry(radius, 14, 12)), material)
    head.position.set(x, height * 0.62 + radius * 0.5, z)
    poiGroup.add(stem, head)
  }

  const poiMaterials = new Map<number, THREE.MeshBasicMaterial>()
  const casingMaterial = sink(
    new THREE.MeshBasicMaterial({ color: MAP_PALETTE.roadCasing }),
    GROUND_RANK.roadCasing,
  )
  function poiMaterial(color: number): THREE.MeshBasicMaterial {
    let material = poiMaterials.get(color)
    if (!material) {
      material = new THREE.MeshBasicMaterial({ color })
      poiMaterials.set(color, material)
    }
    return material
  }

  /**
   * Which materials are lit from the *inside* rather than by the sun.
   *
   * These are the only colours the hour is allowed to move, and they move opposite to the sky: a
   * window is brightest against a dark one. Everything else in the drawing keeps a single albedo
   * across all four phases and is re-graded by the lighting rig, which is what keeps one palette in
   * one place instead of four that drift apart.
   */
  const LIT_FROM_WITHIN = ['window', 'kitGlass'] as const

  /**
   * Pushes the current hour into the lights, the sky, the haze, and the lit windows.
   *
   * Deliberately does *not* touch geometry, framing, or any measured colour, so a phase change is a
   * handful of `setHex` calls and a re-bake of a 24×20 dome — never a rebuild.
   */
  function applyAtmosphere() {
    const atmosphere = cityAtmosphere()
    paintSkyDome(atmosphere)
    hemiLight.color.setHex(atmosphere.hemiSky)
    hemiLight.groundColor.setHex(atmosphere.hemiGround)
    hemiLight.intensity = atmosphere.hemiIntensity
    keyLight.color.setHex(atmosphere.keyColor)
    keyLight.intensity = atmosphere.keyIntensity
    fillLight.color.setHex(atmosphere.fillColor)
    fillLight.intensity = atmosphere.fillIntensity
    cityFog.color.setHex(atmosphere.fogColor)
    // The sun moves with the hour, so the shadow frustum has to be re-aimed at the plan it was
    // fitted to. Skipped before the first plan arrives; `setPlan` aims it then.
    if (plan) aimSunAt(plan)
    // Map mode owns the background and the emissives while it is on screen — a printed basemap has
    // no sky and no lit windows. `applyViewMode` reads the atmosphere back when the city returns.
    if (flatMode) return
    scene.background = new THREE.Color(atmosphere.background)
    for (const name of LIT_FROM_WITHIN) {
      const material = materials[name]
      material.emissive.setHex(atmosphere.windowEmissive)
      material.emissiveIntensity = atmosphere.windowEmissiveIntensity
    }
  }

  function applyViewMode() {
    const flat = viewMode === 'map'
    const table = flat ? MAP_COLORS : CITY_COLORS
    const atmosphere = cityAtmosphere()

    scene.background = new THREE.Color(flat ? MAP_PALETTE.ground : atmosphere.background)
    // A printed basemap has no atmosphere and no sun. Both are switched off wholesale rather than
    // tuned, so map mode stays a flat drawing of the same plan.
    scene.fog = flat ? null : cityFog
    skyDome.visible = !flat
    renderer.shadowMap.enabled = !flat

    for (const [name, material] of Object.entries(materials)) {
      const hex = table[name]
      if (hex !== undefined) (material as THREE.Material & { color: THREE.Color }).color.setHex(hex)
      const lit = material as THREE.Material & { emissive?: THREE.Color; emissiveIntensity?: number }
      if (!lit.emissive) continue
      // Windows follow the hour; everything else that glows carries a fixed city value.
      const litFromWithin = (LIT_FROM_WITHIN as readonly string[]).includes(name)
      lit.emissive.setHex(
        flat ? 0x000000 : litFromWithin ? atmosphere.windowEmissive : CITY_EMISSIVE[name] ?? 0x000000,
      )
      if (litFromWithin) lit.emissiveIntensity = flat ? 1 : atmosphere.windowEmissiveIntensity
    }
    for (const use of LAND_USES) {
      landMaterials[use].color.setHex((flat ? LANDUSE_MAP_COLORS : LANDUSE_CITY_COLORS)[use])
    }
    // The river's clones carry the palette of the covers they were cloned from, never their rank.
    riverMaterials.water.color.copy(landMaterials.water.color)
    riverMaterials.bank.color.copy(landMaterials.yard.color)
    for (const klass of STREET_CLASSES) {
      streetFill[klass].color.setHex(flat ? MAP_STREET[klass].fill : CITY_STREET[klass].fill)
      streetCasing[klass].color.setHex(flat ? MAP_STREET[klass].casing : CITY_STREET[klass].casing)
    }
    // Archetype colours are the cache key, so restoring them needs no separate table. The basemap
    // colour is the one that carries the neighbourhood on paper, so it is remembered per material.
    for (const [color, material] of archetypeMaterials) {
      material.color.setHex(flat ? (material.userData.mapColor as number) : color)
    }
    /*
     * The neighbourhood wash carries more weight on the basemap.
     *
     * In the 3D city the buildings themselves are tinted, so the ground only has to agree with them.
     * Map mode already tints the plates too, but it also draws far more competing land cover per
     * block, so the wash has to push harder to hold a quarter together underneath it.
     */
    for (const material of districtMaterials.values()) {
      material.opacity = flat ? MAP_DISTRICT_OPACITY : CITY_DISTRICT_OPACITY
    }
    materials.civicPad.opacity = flat ? 0.34 : 0.15
    // Paint is a city-mode idea and `instanceColor` multiplies the ink map mode inverts to, so the
    // tints are rewritten here rather than only when the roster is rebuilt — a mode toggle changes
    // no vehicle, and would otherwise leave the previous mode's paint multiplying the new palette.
    writeVehicleColors()

    // Under ambient light alone a standard material renders as its flat base colour, which is the
    // unlit look a basemap needs — without swapping every material's class.
    hemiLight.visible = !flat
    keyLight.visible = !flat
    fillLight.visible = !flat
    ambientLight.visible = flat

    // Height is a 3D-mode claim. Flattening the same geometry keeps footprint, roof-cap tint, and
    // index annexes readable as a plan drawing instead of building a second scene graph.
    const massing = flat ? 0.012 : 1
    buildingGroup.scale.y = massing
    infrastructureGroup.scale.y = massing
    poiGroup.visible = flat
    // Trees and street furniture are a golden-hour effect. A printed basemap draws land cover, not
    // individual shrubs, and instancing thousands of them under a flat camera buys nothing.
    sceneryGroup.visible = !flat
    roadCasingGroup.visible = flat && layers.paths
    flatMode = flat

    // A very narrow field of view from far away is parallel projection for every practical purpose,
    // and it keeps one camera, one raycaster, and one set of controls for both modes.
    const previousFov = THREE.MathUtils.degToRad(camera.fov)
    camera.fov = flat ? 13 : 46
    controls.enableRotate = !flat
    controls.minPolarAngle = flat ? 0 : 0.05
    controls.maxPolarAngle = flat ? 0 : Math.PI / 2 - 0.05
    controls.touches = flat
      ? { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN }
      : { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }
    controls.mouseButtons = flat
      ? { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
      : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
    camera.updateProjectionMatrix()
    // Incident pins are anchored to the massing, which just changed.
    buildIncidents(currentIncidents)

    /*
     * Keep looking at what you were looking at.
     *
     * Re-framing the whole city on every toggle would throw away your position, which is exactly the
     * wrong behaviour when the point of the toggle is to compare the same place two ways. So the
     * orbit target is left alone and only the camera moves: the distance is rescaled by the ratio of
     * the two fields of view, which keeps the apparent size of what you are looking at unchanged
     * across a 46° → 13° swap.
     *
     * The heading is carried across explicitly rather than read back off the camera, because a
     * camera placed exactly overhead has no azimuth to read — the round trip through map mode would
     * silently reset you to north.
     */
    const offset = camera.position.clone().sub(controls.target)
    if (!flat && (offset.x !== 0 || offset.z !== 0)) cityAzimuth = Math.atan2(offset.x, offset.z)
    const distance = Math.max(offset.length(), 1)
    const scaled = distance * (Math.tan(previousFov / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2))
    // Not exactly straight down: a camera looking along its own up vector has no defined orientation,
    // and a hair of tilt also lets the orbit controls keep hold of the heading.
    const polar = flat ? 0.0005 : DEFAULT_POLAR
    // Map mode is north-up, the way every basemap is. The oblique heading is remembered rather than
    // carried over, so leaving map mode puts the city back on the bearing you left it on.
    const azimuth = flat ? 0 : cityAzimuth
    const direction = new THREE.Vector3(
      Math.sin(polar) * Math.sin(azimuth),
      Math.cos(polar),
      Math.sin(polar) * Math.cos(azimuth))
    camera.position.copy(controls.target).addScaledVector(direction, scaled)
    setDepthRange(scaled)
    // The lens just changed, so every distance limit expressed through it changed with it. Widen
    // the clamps before update() runs, or the freshly-scaled distance is clamped back to the old
    // lens's ceiling — which is exactly what pinned map mode at a fixed, far-too-close zoom.
    applyZoomRange()
    controls.update()
    // Only the camera and the lens moved; the sun and every caster stayed put.
    requestCameraRender()
  }

  // One group per layer keeps toggling a layer O(1) and avoids rebuilding the scene graph.
  const groundGroup = new THREE.Group()
  /** Trees, furniture and parked cars. Pure decoration, so it is a layer of its own and 3D only. */
  const sceneryGroup = new THREE.Group()
  const districtGroup = new THREE.Group()
  const buildingGroup = new THREE.Group()
  const roadGroup = new THREE.Group()
  /** Streets carrying workload traffic, drawn once per street rather than once per query pair. */
  const trafficGroup = new THREE.Group()
  /** Wider ribbons drawn beneath the road fill. Map mode only — casings are a basemap idiom. */
  const roadCasingGroup = new THREE.Group()
  roadCasingGroup.visible = false
  const roadHighlightGroup = new THREE.Group()
  const infrastructureGroup = new THREE.Group()
  /**
   * Live vehicles. Drawn in both view modes, because a running query is a measurement and hiding a
   * measurement behind a mode switch is a way of not reporting it.
   */
  const vehicleGroup = new THREE.Group()
  /**
   * The fading light trails behind moving vehicles.
   *
   * Its own group rather than a child of {@link vehicleGroup}, because `buildVehicles()` clears that
   * group wholesale on every live sample and the trail mesh is allocated once for the life of the
   * scene. Drawn after the roads and before the vehicles.
   */
  const vehicleTrailGroup = new THREE.Group()
  const routeGroup = new THREE.Group()
  const selectionGroup = new THREE.Group()
  // Labels are their own layer, but facility labels nest so they disappear with the facilities they
  // name rather than hovering over empty ground.
  const labelGroup = new THREE.Group()
  const buildingLabelGroup = new THREE.Group()
  const facilityLabelGroup = new THREE.Group()
  const neighborhoodLabelGroup = new THREE.Group()
  labelGroup.add(buildingLabelGroup, facilityLabelGroup, neighborhoodLabelGroup)
  const labelFactory = createCityLabels()
  scene.add(
    groundGroup,
    sceneryGroup,
    districtGroup,
    roadCasingGroup,
    trafficGroup,
    roadGroup,
    roadHighlightGroup,
    buildingGroup,
    infrastructureGroup,
    vehicleTrailGroup,
    vehicleGroup,
    routeGroup,
    selectionGroup,
    labelGroup,
  )

  const pickable: THREE.Object3D[] = []
  const roadPickable: THREE.Object3D[] = []
  const roadPaths = new Map<string, { road: RoadTraffic; polyline: Array<{ x: number; z: number }>; endsOffMap: boolean }>()
  const disposables = new Set<THREE.BufferGeometry>()
  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()

  let plan: CityPlan | null = null
  let facilitySites: ReadonlyMap<FacilityKind, FacilitySite> = new Map<FacilityKind, FacilitySite>()
  let currentRoads: readonly RoadTraffic[] = []
  let currentObjects: readonly DatabaseCityObject[] = []
  let currentTraffic: WorkloadTraffic | null = null
  let currentRoute: CityRoute | null = null
  let currentFacilities: readonly Facility[] = []
  let currentIncidents: readonly IncidentMarker[] = []
  let selectedId: string | null = null
  let selectedRoadId: string | null = null
  let hoveredRoadId: string | null = null
  let framedOnce = false
  let flatMode = false
  let disposed = false
  let assets: CityAssets | null = null
  let animationHandle = 0
  let renderRequested = false
  /*
   * Vehicle state.
   *
   * `vehicleHandle` is deliberately *not* `animationHandle`. The damping loop zeroes that handle the
   * moment the camera settles, so a vehicle loop sharing it would either refuse to start (the guard
   * sees a non-zero handle) or leave a second, never-terminating rAF chain running behind it. Two
   * loops, two handles, each responsible for stopping itself.
   */
  let vehicleHandle = 0
  /** Animated time consumed so far, in ms. Only ever advanced by the vehicle loop. */
  let vehicleClock = 0
  /**
   * The value {@link vehicleClock} held when the roster was last rebuilt.
   *
   * A vehicle's {@link Vehicle.elapsedSeconds} is measured from the wall clock at that rebuild, so
   * the animation adds only the time since. Recomputing the offset from wall-clock age on every
   * rebuild is what keeps the traffic correct under `prefers-reduced-motion`, where the loop never
   * runs and `vehicleClock` never moves: the cars still advance, one step per live sample.
   */
  let vehicleClockAtBuild = 0
  let vehicleKit: AssetKit | null = null
  let currentEvents: readonly LiveQueryEvent[] | null = null
  let currentFamilies: readonly DatabaseCityQueryFamily[] = []
  let vehicleRoster: VehicleRoster | null = null
  let vehicleBatches: VehicleBatch[] = []
  /** Vehicles that are not stopped. Zero means there is nothing to animate and the loop must end. */
  let movingVehicles = 0
  let staleStatsObjectIds = new Set<string>()
  /** Placements keyed by the session they were pinned for, so a blocked vehicle stops at its pin. */
  const blockedPlacements = new Map<number, IncidentPlacement>()
  const layers: CityLayerToggles = {
    traffic: true,
    paths: false,
    infrastructure: true,
    route: true,
    labels: true,
  }

  const track = <T extends THREE.BufferGeometry>(geometry: T): T => {
    disposables.add(geometry)
    return geometry
  }

  const clearGroup = (group: THREE.Group) => {
    for (const child of [...group.children]) {
      group.remove(child)
      child.traverse(node => {
        // An instanced mesh owns a per-instance matrix buffer even when its geometry is shared kit
        // geometry that must outlive the rebuild, so it is disposed on its own terms.
        if (node instanceof THREE.InstancedMesh) node.dispose()
        if (node instanceof THREE.Mesh && disposables.has(node.geometry)) {
          disposables.delete(node.geometry)
          node.geometry.dispose()
        }
      })
    }
  }

  /**
   * Applies the layer toggles to group visibility. Facility labels nest inside the label group, so
   * they need both their own layer and the infrastructure layer to be on.
   *
   * Individual names are additionally hidden when they would be too small to read; that is
   * per-sprite and lives in {@link applyLabelLegibility}.
   */
  const applyLayers = () => {
    roadGroup.visible = layers.paths
    roadCasingGroup.visible = layers.paths && flatMode
    trafficGroup.visible = layers.traffic
    roadHighlightGroup.visible = layers.traffic || layers.paths
    infrastructureGroup.visible = layers.infrastructure
    routeGroup.visible = layers.route
    labelGroup.visible = layers.labels
    facilityLabelGroup.visible = layers.infrastructure
  }
  applyLayers()

  /**
   * Hides building and facility names that would project too small to read, and grows neighbourhood
   * names that would.
   *
   * Names are dropped rather than drawn tiny, which is ordinary cartographic practice: a basemap
   * sheds street names as you zoom out instead of shrinking them into illegibility. Because larger
   * tables are lettered larger, they survive to a wider zoom than small ones, so zooming in reveals
   * names roughly in order of size instead of switching all seventy-five on at once.
   *
   * Neighbourhood names are the tier that holds the wide view, so they cannot be dropped for being
   * small — there is nothing above them to fall back on. They are grown to a legible size instead
   * (see {@link labelScreenScale}), and because growing a name does not give it more ground to sit
   * on, whatever then collides is resolved by {@link declutterLabels} in territory order. On a
   * 390-point phone this is the difference between a map with no readable text and a map with the
   * three or four names that actually fit.
   */
  const applyLabelLegibility = (viewportHeightPx: number, viewportWidthPx: number) => {
    const distance = camera.position.distanceTo(controls.target)
    // Every label shares a camera, so the projection factor is computed once and each sprite only
    // has to compare its own height against it. Rendering is on demand, so this runs when the
    // camera moves rather than continuously.
    const minimumWorldHeight = minimumLegibleWorldHeight(distance, camera.fov, viewportHeightPx)
    for (const sprite of buildingLabelGroup.children) {
      const height = (sprite.userData.labelWorldHeight as number | undefined) ?? LABEL_WORLD_HEIGHT
      sprite.visible = height >= minimumWorldHeight
    }
    for (const sprite of facilityLabelGroup.children) {
      sprite.visible = LABEL_WORLD_HEIGHT >= minimumWorldHeight
    }
    applyNeighborhoodLabelScale(distance, viewportHeightPx, viewportWidthPx)
  }

  const projected = new THREE.Vector3()

  /** Grows neighbourhood names to the legibility floor, then drops whichever ones then collide. */
  const applyNeighborhoodLabelScale = (
    distance: number,
    viewportHeightPx: number,
    viewportWidthPx: number,
  ) => {
    const boxes: LabelBox[] = []
    for (const sprite of neighborhoodLabelGroup.children) {
      if (!(sprite instanceof THREE.Sprite)) continue
      const baseScaleX = (sprite.userData.baseScaleX as number | undefined) ?? sprite.scale.x
      const baseScaleY = (sprite.userData.baseScaleY as number | undefined) ?? sprite.scale.y
      const baseY = (sprite.userData.baseY as number | undefined) ?? sprite.position.y
      const worldHeight = (sprite.userData.labelWorldHeight as number | undefined) ?? baseScaleY
      const scale = labelScreenScale(worldHeight, distance, camera.fov, viewportHeightPx)
      sprite.scale.set(baseScaleX * scale, baseScaleY * scale, 1)
      // Lifting with the type keeps the name clear of the rooftops it grew past.
      sprite.position.y = baseY + (baseScaleY * (scale - 1)) / 2
      projected.set(sprite.position.x, sprite.position.y, sprite.position.z).project(camera)
      const onScreen = projected.z < 1 && Math.abs(projected.x) < 1.6 && Math.abs(projected.y) < 1.6
      boxes.push({
        id: (sprite.userData.labelId as string | undefined) ?? String(boxes.length),
        x: (projected.x * 0.5 + 0.5) * viewportWidthPx,
        y: (-projected.y * 0.5 + 0.5) * viewportHeightPx,
        width: labelPixelHeight(baseScaleX * scale, distance, camera.fov, viewportHeightPx),
        height: labelPixelHeight(baseScaleY * scale, distance, camera.fov, viewportHeightPx),
        // Territory order: the name of the larger neighbourhood is the one that survives.
        priority: worldHeight,
        visible: onScreen,
      })
    }
    const keep = declutterLabels(boxes)
    let index = 0
    for (const sprite of neighborhoodLabelGroup.children) {
      if (!(sprite instanceof THREE.Sprite)) continue
      sprite.visible = keep.has(boxes[index]?.id ?? '')
      index += 1
    }
  }

  const draw = () => {
    const width = Math.max(canvas.clientWidth, 1)
    const height = Math.max(canvas.clientHeight, 1)
    const ratio = renderer.getPixelRatio()
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    applyLabelLegibility(height, width)
    // Vehicles are positioned here rather than in their own loop so that every frame — including a
    // camera-only one — leaves them where the current clock says they are, at a size the current
    // zoom can read. See the vehicle block for why the clock is not the wall clock.
    placeVehicles()
    // The sky follows the camera across the plan but stays pinned to the ground plane in height, so
    // its horizon is the city's horizon. Centring it on the camera instead puts the horizon at eye
    // level, which from an aerial view means the whole background is the *under* side of the dome.
    if (skyDome.visible) {
      skyDome.position.set(camera.position.x, 0, camera.position.z)
      skyDome.scale.setScalar(camera.far * 0.4)
      /*
       * Haze is keyed to how far away you are standing, not to how big the database is.
       *
       * A fixed distance derived from the plan looks right at one zoom and wrong at every other:
       * pulled back it swallows the city, pushed in it disappears. Anchoring both planes to the
       * orbit distance keeps whatever you are actually looking at clear, and always puts the
       * dissolve just beyond it.
       */
      const orbit = camera.position.distanceTo(controls.target)
      cityFog.near = orbit * 0.95
      cityFog.far = orbit * 3.1
    }
    renderer.render(scene, camera)
  }

  // Rendering is on demand; a frame loop runs only while damping is still settling the camera.
  const scheduleFrame = () => {
    if (disposed || renderRequested) return
    renderRequested = true
    requestAnimationFrame(() => {
      renderRequested = false
      if (!disposed) draw()
    })
  }

  const requestRender = () => {
    // Anything that asks for a frame through this path may have changed what casts, so the shadow
    // map is marked stale. Camera-only movement uses `requestCameraRender()` and skips it.
    renderer.shadowMap.needsUpdate = true
    scheduleFrame()
  }

  /**
   * A frame in which only the camera moved.
   *
   * A directional light's shadow map is drawn from the light, so panning, orbiting, zooming,
   * framing and resizing cannot change a single texel of it. These are the only call sites allowed
   * to skip invalidation, and they are allowed to because the sun did not move and neither did
   * anything under it.
   */
  const requestCameraRender = () => {
    scheduleFrame()
  }

  const runDampingLoop = () => {
    if (animationHandle !== 0 || disposed) return
    const step = () => {
      if (disposed) return
      const moving = controls.update()
      draw()
      animationHandle = moving ? requestAnimationFrame(step) : 0
    }
    animationHandle = requestAnimationFrame(step)
  }

  /**
   * The one continuous frame loop in this scene, and the reason it is safe.
   *
   * Rendering here is on demand: `scheduleFrame` coalesces to a single frame and then stops, and the
   * only other loop — {@link runDampingLoop} — ends as soon as the camera settles. A loop that runs
   * while vehicles are moving is a genuine exception to that, so it is bounded three ways.
   *
   * - **It has its own handle.** `animationHandle` is zeroed by the damping loop the instant damping
   *   settles, so a vehicle loop sharing it would either refuse to start (the `!== 0` guard sees the
   *   damping loop's handle) or, worse, be silently orphaned when damping zeroed the handle out from
   *   under it — leaving a second rAF chain that nothing can ever cancel, including `dispose()`.
   * - **It stops itself.** The guard is re-tested every frame, so the loop ends on the frame after
   *   the last moving vehicle goes away, whether that is because the roster emptied, because every
   *   remaining request is blocked, or because the scene was disposed.
   * - **It calls `draw()` directly.** Not `requestRender()`, which would set
   *   `renderer.shadowMap.needsUpdate` on every single frame and re-arm the 948-draw-call shadow
   *   pass issue #90 removed. Nothing under this loop casts a shadow, so nothing it does can
   *   invalidate a shadow map, and it must not claim otherwise.
   *
   * Under `prefers-reduced-motion` it never starts at all. The vehicles are still drawn, still sized
   * by class, and still stopped where they are blocked — they simply stand at their phase offsets.
   * The roster's own disclosure is what carries the information; motion is a garnish on it.
   */
  const runVehicleLoop = () => {
    if (vehicleHandle !== 0 || disposed || reducedMotion || movingVehicles === 0) return
    let previous = performance.now()
    const step = (now: number) => {
      if (disposed || movingVehicles === 0) {
        vehicleHandle = 0
        return
      }
      /*
       * Clamped, because a backgrounded tab stops servicing rAF and hands back the whole gap on the
       * frame it resumes. Without the clamp every vehicle would jump a random distance down its road
       * the moment you switched back, which looks like a measurement changing when nothing was
       * re-sampled.
       */
      vehicleClock += Math.min(now - previous, 100)
      previous = now
      draw()
      vehicleHandle = requestAnimationFrame(step)
    }
    vehicleHandle = requestAnimationFrame(step)
  }

  const stopVehicleLoop = () => {
    if (vehicleHandle === 0) return
    cancelAnimationFrame(vehicleHandle)
    vehicleHandle = 0
  }

  controls.addEventListener('change', () => {
    options.onCameraChange?.()
    if (controls.enableDamping) runDampingLoop()
    else requestCameraRender()
  })

  /*
   * The ground.
   *
   * Rebuilt as merged geometry rather than one mesh per quad: a large instance has thousands of
   * street legs, and the previous four-meshes-per-street layout put the draw call count in the tens
   * of thousands. Everything here is decoration — land cover, water, kerbs, lane markings — so it can
   * be batched freely. The measured layer (buildings, road traffic, wait lanes) is drawn elsewhere
   * and stays individually addressable for picking.
   */
  function buildGround(cityPlan: CityPlan) {
    clearGroup(groundGroup)
    /*
     * Deliberately enormous. The ground is the only thing between the city and the haze, and the
     * moment its edge comes into frame the whole illusion collapses into a slab floating in fog.
     * Sized so the edge always sits past the far fog plane at any orbit distance the controls allow.
     */
    const span = Math.max(cityPlan.bounds.width, cityPlan.bounds.depth) * 30 + 4000
    const ground = new THREE.Mesh(track(new THREE.PlaneGeometry(span, span)), materials.ground)
    ground.rotation.x = -Math.PI / 2
    ground.position.set(cityPlan.bounds.centerX, -0.75, cityPlan.bounds.centerZ)
    ground.receiveShadow = true
    groundGroup.add(ground)

    buildLandCover(cityPlan)
    buildCarriageways(cityPlan)
    buildScenery(cityPlan)
    aimSunAt(cityPlan)
  }

  /*
   * Street furniture, trees and parked cars.
   *
   * Every placement is a pure function of the block's own seed, which is itself a pure function of
   * the database id — so the same database always grows the same trees in the same places. None of
   * it is measured, and the legend says as much. Parked cars are parked and never move: a moving
   * vehicle would imply flow, and flow on this map is evidence.
   *
   * Drawn with one `InstancedMesh` per (asset, role) so a few thousand props cost a few dozen draw
   * calls, and capped so a ten-thousand-table instance does not spend its frame budget on shrubbery.
   */
  const MAX_SCENERY = 2600
  /** How many buildings may cast into the shadow map before the frame cost outgrows the depth cue. */
  const MAX_SHADOW_CASTERS = 900

  function buildScenery(cityPlan: CityPlan) {
    clearGroup(sceneryGroup)
    const kit = assets?.scenery
    if (!kit) return

    const placements = new Map<SceneryAsset, THREE.Matrix4[]>()
    let budget = MAX_SCENERY
    const place = (asset: SceneryAsset, x: number, z: number, spin: number, scale: number | THREE.Vector3, y = 0) => {
      if (budget <= 0 || !kit.has(asset)) return
      budget -= 1
      const matrix = new THREE.Matrix4()
      const size = typeof scale === 'number' ? new THREE.Vector3(scale, scale, scale) : scale
      matrix.compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromAxisAngle(UP, spin),
        size,
      )
      const list = placements.get(asset)
      if (list) list.push(matrix)
      else placements.set(asset, [matrix])
    }

    // Blocks are visited in key order so the cap always truncates the same tail.
    const blocks = [...cityPlan.terrain.blocks.values()].sort((left, right) => left.key.localeCompare(right.key))
    for (const block of blocks) {
      if (budget <= 0) break
      dressBlock(block, place)
    }

    for (const street of cityPlan.streets) {
      if (!street.bridge || budget <= 0) continue
      dressBridge(street.path, street.width, place)
    }

    for (const [asset, matrices] of placements) {
      for (const role of kit.roles(asset)) {
        const geometry = kit.geometry(asset, role)
        if (!geometry) continue
        const mesh = new THREE.InstancedMesh(geometry, KIT_MATERIALS[role], matrices.length)
        for (let i = 0; i < matrices.length; i += 1) mesh.setMatrixAt(i, matrices[i])
        mesh.instanceMatrix.needsUpdate = true
        mesh.castShadow = true
        mesh.receiveShadow = true
        // Props are small and scattered; letting three.js cull them per instance costs more than it
        // saves, and a wrong bounding sphere would pop whole blocks in and out.
        mesh.frustumCulled = false
        sceneryGroup.add(mesh)
      }
    }
  }

  /*
   * ----------------------------------------------------------------------------------------------
   * Live vehicles.
   *
   * One vehicle is one execution the engine reported — a row of `sys.dm_exec_requests` caught running,
   * or an advance in a `sys.dm_exec_query_stats` execution counter.
   * Which of the five shells it gets comes from the estimated bytes its plan moves; `cityVehicles.ts`
   * owns that decision and the join behind it, and everything below is drawing.
   *
   * Three properties of this block are load-bearing and all three fail silently:
   *
   * 1. Vehicles **never cast or receive shadows**, and nothing here ever sets
   *    `renderer.shadowMap.needsUpdate`. Issue #90 removed a 948-draw-call, 7.6 ms shadow pass that
   *    was being re-armed on every frame; a moving caster would re-arm it once per frame forever,
   *    which is strictly worse than what #90 fixed. A vehicle is roughly two metres tall on a city
   *    that is hundreds of metres across, so the shadow it would cast is not worth one draw call,
   *    let alone the whole pass.
   * 2. The loop below uses **its own handle**, `vehicleHandle`, and stops itself the moment the
   *    roster empties. See {@link runVehicleLoop}.
   * 3. Positions are recomputed inside {@link draw}, from `vehicleClock` rather than from the wall
   *    clock. A camera-only frame therefore redraws the vehicles exactly where they already were,
   *    instead of skipping the update (which would leave them lagging the camera) or advancing them
   *    (which would make an idle city drift whenever you panned it).
   * ----------------------------------------------------------------------------------------------
   */

  /** Which authored shell each class is drawn with. `unknown` deliberately has none — see below. */
  const VEHICLE_ASSET_BY_CLASS: Record<VehicleClass, VehicleAsset | null> = {
    bike: 'vehicle_bike',
    car: 'vehicle_car',
    van: 'vehicle_van',
    semiTruck: 'vehicle_semi_truck',
    unknown: null,
  }

  const VEHICLE_MATERIALS: Record<AssetRole, THREE.Material> = {
    body: materials.vehicleBody,
    trim: materials.vehicleTrim,
    glass: materials.vehicleGlass,
    metal: materials.vehicleMetal,
    // The vehicle kit carries no organic roles; these exist only to satisfy the role contract.
    trunk: materials.vehicleTrim,
    leaf: materials.vehicleTrim,
    water: materials.vehicleGlass,
  }

  /**
   * The world size of each shell, in metres, measured off the exported `vehicles.glb`.
   *
   * Length is the channel that survives at map scale — the four are 1.8 m, 4.2 m, 6.0 m and 12.2 m,
   * so each is roughly twice the one below it and the ladder stays legible when a vehicle is a few
   * pixels long. These numbers are duplicated here rather than derived from the geometry's bounding
   * box because the procedural fallback has to reproduce them when the kit fails to load, and a
   * fallback that silently changed the ladder would be worse than no fallback at all.
   */
  const VEHICLE_SIZE: Record<VehicleClass, { width: number; height: number; length: number }> = {
    bike: { width: 0.52, height: 1.0, length: 1.77 },
    car: { width: 1.87, height: 1.48, length: 4.2 },
    van: { width: 2.3, height: 2.45, length: 6.02 },
    semiTruck: { width: 2.62, height: 3.23, length: 12.24 },
    /*
     * A cube, and on purpose.
     *
     * Every one of the four above says something with its length. An unknown has no length to say —
     * `planDataVolume` is absent, which means the retained plans never stated both a row count and a
     * row size, and that is not the same claim as "this query moves very little". Drawing it as any
     * of the four would put it on a rung it was never measured onto, and drawing it at some size
     * between two rungs would invite a reader to interpolate. A shape whose length, width and height
     * are all equal has no length channel to read, which is the only honest shape available.
     */
    unknown: { width: 2.6, height: 2.6, length: 2.6 },
  }

  /*
   * How fast a vehicle travels, in world units per second.
   *
   * Speed *is* a channel, which reverses what this comment said until recently. What it encodes is
   * the family's mean duration per execution — a Query Store aggregate — scaled to ±15% around the
   * base speed, so a historically quick query drives a quick car.
   *
   * The distinction that keeps this honest is between a *duration aggregate* and *progress*. SQL
   * Server still reports nothing about how far through a running statement is, so a vehicle's pace is
   * never a claim about the execution it represents; it is a claim about what executions of that
   * query have typically cost, which is measured. It is also why the scale comes off the family and
   * not off the live request's elapsed time: the live figure grows between samples, and a car whose
   * speed changed under it would jump down the road on every tick.
   *
   * Size still carries the larger claim, and the ±15% band is deliberately too narrow to compete
   * with it — see `VEHICLE_SPEED_VARIATION`.
   *
   * The numbers themselves live in `cityVehicles.ts` beside {@link travelledFraction}, because the
   * roster has to know them too: they are what decide when a finished car has reached the end of its
   * road and can leave the map. Two copies would drift, and the symptom would be cars vanishing early
   * or lingering — neither of which looks like a bug in a constant.
   */

  /**
   * The shortest a bicycle may be allowed to get on screen, in CSS pixels.
   *
   * Framed on a whole city, 1.77 m projects to well under a pixel and the smallest class simply
   * vanishes — and an empty street is *already* meaningful here (nothing was sampled on it), so a
   * vehicle that disappears through being small tells the reader something false.
   *
   * 16 rather than the 7 this started at, because "does not vanish" turned out to be a much weaker
   * requirement than "can be recognised". Measured against a 60-object database at whole-city
   * framing (1032x900 canvas, fov 46, ~1495 units out), 7 px put a bicycle at 5.7 px and a car at
   * 13.4 px on screen — a smudge two or three pixels wide, which is why the authored shells were
   * reported as "just blocks" even though the kit had loaded and every model was drawing correctly.
   * The same framing at 16 px puts the bicycle at 12.9 px and the car at 30.7 px, which is the
   * point at which a windscreen and a wheelbase resolve.
   */
  const VEHICLE_MIN_PX = 16

  /**
   * Growth is capped so a bicycle never inflates into something that reads as a truck.
   *
   * **This number and {@link VEHICLE_MIN_PX} have to move together.** {@link labelScreenScale}
   * returns `min(maxGrowth, minimumPx / projected)`, so whichever term is smaller is the only one
   * that has any effect and raising the other alone changes nothing at all. Which term binds depends
   * on how far out the camera is, so both framings have to be checked: on a small database the
   * camera is close, `minimumPx / projected` is small, and the floor binds; on a large one the
   * camera pulls back until that ratio exceeds the cap, and from there the cap alone sets the size.
   * A change that raised only the floor would therefore be invisible on exactly the big cities where
   * vehicles are smallest, and one that raised only the cap would be invisible on the small ones.
   *
   * 18 is a ceiling, not a preference. Magnification is shared by all five classes (see
   * {@link placeVehicles}), so the semi-trailer sets how far this can go: 12.24 m at 18x occupies
   * about 220 world units, which is just inside the ~234-unit light trail already accepted behind a
   * moving vehicle. Past that a single truck is longer than the street it is driving down, and the
   * city stops reading as a city.
   *
   * What this distorts is the vehicle-to-building ratio, and only that. Because every class shares
   * one factor, the ladder between the five — the thing that actually carries a measurement — is
   * exactly as true at 18x as at 1x. A vehicle and a building are different units that this map
   * never invites comparing, so inflating one against the other costs a reading nobody was making.
   */
  const VEHICLE_MAX_GROWTH = 18

  type VehicleBatch = {
    readonly klass: VehicleClass
    /** Moving vehicles first, then stopped ones; `moving` is where the second run begins. */
    readonly vehicles: readonly Vehicle[]
    readonly moving: number
    readonly meshes: readonly THREE.InstancedMesh[]
    /** Arc length of each vehicle's route, precomputed so the loop does no O(points) work per frame. */
    readonly routeLengths: readonly number[]
    /** Fixed heading for the stopped tail, computed once because a stopped vehicle does not turn. */
    readonly stoppedYaw: readonly number[]
  }

  function buildVehicles() {
    clearGroup(vehicleGroup)
    vehicleBatches = []
    movingVehicles = 0

    const roster = vehicleRoster
    if (!roster || roster.vehicles.length === 0) {
      // Nothing to animate. The loop must not be left running over an empty roster.
      stopVehicleLoop()
      return
    }

    const byClass = new Map<VehicleClass, Vehicle[]>()
    for (const vehicle of roster.vehicles) {
      const list = byClass.get(vehicle.class)
      if (list) list.push(vehicle)
      else byClass.set(vehicle.class, [vehicle])
    }

    for (const [klass, unordered] of byClass) {
      // Moving first so the animation loop can walk a prefix and leave the stopped tail alone.
      const vehicles = [...unordered].sort(
        (left, right) => Number(left.blockedAt !== null) - Number(right.blockedAt !== null)
          || left.id.localeCompare(right.id),
      )
      const moving = vehicles.filter(vehicle => vehicle.blockedAt === null).length
      movingVehicles += moving

      const meshes: THREE.InstancedMesh[] = []
      const asset = VEHICLE_ASSET_BY_CLASS[klass]
      const kit = vehicleKit
      if (asset && kit?.has(asset)) {
        for (const role of kit.roles(asset)) {
          const geometry = kit.geometry(asset, role)
          if (!geometry) continue
          // Kit geometry is shared across every rebuild, so it is deliberately not tracked for disposal.
          meshes.push(new THREE.InstancedMesh(geometry, VEHICLE_MATERIALS[role], vehicles.length))
        }
      }
      if (meshes.length === 0) {
        /*
         * The kit did not load, or this is the unknown class, which has no authored shell.
         *
         * Either way a box at the class's real dimensions keeps the ladder intact, which matters far
         * more than the silhouette: the reader is being told how much data a query moves, and a
         * plain box of the right length says that as well as a modelled truck does.
         */
        const size = VEHICLE_SIZE[klass]
        const geometry = track(new THREE.BoxGeometry(size.width, size.height, size.length))
        // Authored shells sit on y=0; a box is centred on its origin, so it is lifted to match.
        geometry.translate(0, size.height / 2, 0)
        const material = klass === 'unknown' ? materials.vehicleUnknown : materials.vehicleBody
        meshes.push(new THREE.InstancedMesh(geometry, material, vehicles.length))
      }

      for (const mesh of meshes) {
        // See the block comment above: this is the line that keeps the #90 shadow pass disarmed.
        mesh.castShadow = false
        mesh.receiveShadow = false
        // A vehicle's bounding sphere is computed from geometry sitting at the origin, so three.js
        // would cull the whole batch the moment the origin left frame.
        mesh.frustumCulled = false
        mesh.renderOrder = 5
        vehicleGroup.add(mesh)
      }

      vehicleBatches.push({
        klass,
        vehicles,
        moving,
        meshes,
        routeLengths: vehicles.map(vehicle => polylineLength(vehicle.points)),
        stoppedYaw: vehicles.map(vehicle =>
          vehicle.blockedAt ? headingNear(vehicle.points, vehicle.blockedAt) : 0),
      })
    }

    placeVehicles()
    writeVehicleColors()
    if (movingVehicles > 0) runVehicleLoop()
    else stopVehicleLoop()
  }

  const vehicleMatrix = new THREE.Matrix4()
  const vehiclePosition = new THREE.Vector3()
  const vehicleQuaternion = new THREE.Quaternion()
  const vehicleScale = new THREE.Vector3()

  /*
   * ----------------------------------------------------------------------------------------------
   * Paint.
   *
   * Each live vehicle's body is tinted from a hash of its id, so half a dozen requests on one street
   * read as half a dozen vehicles rather than one shell drawn six times. `vehiclePaintHue` in
   * `cityVehicles.ts` owns the hash and explains why it is a hash; the two constants below are the
   * whole of the appearance decision.
   *
   * Saturation and lightness are fixed for every vehicle, and that is the point. Length is the only
   * measured channel on this map, and a colour that also varied in depth or brightness would read as
   * a second one. Holding both flat leaves hue saying exactly one thing — *which* request this is —
   * and nothing about how big it is. It also keeps every vehicle equally bright, so paint can never
   * be the reason one of them is harder to see than its neighbour.
   *
   * Three things about how this reaches the GPU, each of which fails silently:
   *
   * 1. **`vertexColors` is deliberately not set on the material**, despite being the flag usually
   *    named in the same breath as `setColorAt`. In three 0.185 the *vertex* prefix defines
   *    `USE_COLOR` from `material.vertexColors` alone, while `USE_INSTANCING_COLOR` comes from
   *    `instanceColor` being present — so instance colours already work without it. Turning it on
   *    would additionally make the shader multiply in a `color` *geometry attribute* that the kit
   *    geometry does not have; an unbound attribute reads as zero, and the vehicles would render
   *    black. The flag is the trap here, not the fix.
   * 2. **The body role only.** Glass, trim and metal keep their authored materials, so a painted car
   *    still reads as a car with windows rather than a solid lozenge. `unknown` is left alone
   *    entirely — it draws with `materials.vehicleUnknown`, which this never touches — because
   *    "the retained plans never stated a volume" has to stay visibly off the ladder, and a painted
   *    unknown is just one more car.
   * 3. **White in map mode.** `instanceColor` *multiplies* the material colour, and map mode inverts
   *    the vehicle ladder to a dark ink so it survives on a light basemap. A hue multiplied into
   *    that ink is near-black, not colour. White is the identity, so a printed basemap comes out
   *    exactly as it did before paint existed. Paint is a city-mode idea: a basemap draws a moving
   *    thing in one ink, and colouring it in would be inventing a legend.
   * ----------------------------------------------------------------------------------------------
   */
  const VEHICLE_PAINT_SATURATION = 0.68
  const VEHICLE_PAINT_LIGHTNESS = 0.6
  const vehiclePaint = new THREE.Color()

  function writeVehicleColors() {
    const flat = viewMode === 'map'
    for (const batch of vehicleBatches) {
      for (const mesh of batch.meshes) {
        // Identity, not role: the body role and the non-unknown box fallback are exactly the meshes
        // drawn with this material, and asking the mesh avoids keeping a second list in step.
        if (mesh.material !== materials.vehicleBody) continue
        for (let index = 0; index < batch.vehicles.length; index += 1) {
          if (flat) vehiclePaint.setRGB(1, 1, 1)
          else {
            vehiclePaint.setHSL(
              vehiclePaintHue(batch.vehicles[index].id),
              VEHICLE_PAINT_SATURATION,
              VEHICLE_PAINT_LIGHTNESS,
              THREE.SRGBColorSpace,
            )
          }
          mesh.setColorAt(index, vehiclePaint)
        }
        const instanceColor = mesh.instanceColor
        if (instanceColor) instanceColor.needsUpdate = true
      }
    }
  }

  /*
   * The light trail behind a moving vehicle.
   *
   * A car appearing in the live list is the one moment on this map that is worth catching out of the
   * corner of an eye, and a 4 m shell a few pixels long on a whole-city framing does not catch one.
   * The trail is what makes the arrival legible: a short ribbon along the road the car has just
   * covered, brightest at the bumper and fading to nothing behind it, plus a brief flare over the
   * first few seconds after it pulls away so a new arrival reads as *new* and then settles.
   *
   * What it is, precisely: **the last stretch of road that vehicle covered**, drawn at the same
   * magnification as the shell in front of it and so about six car-lengths long at any zoom. That is
   * a statement about the drawing, not about the query. It is not exhaust, not throughput, not
   * progress; a longer trail means the car has been on screen long enough to have one, and nothing
   * else. The length is fixed for every class for the same reason the speed is — see `VEHICLE_SPEED`
   * — so the ribbon never becomes a second, contradictory size channel.
   *
   * Three constraints shape the implementation, and all three are load-bearing:
   *
   * - **It must not touch the shadow map.** The vehicle loop runs for as long as anything is
   *   executing on the instance, so anything it dirties per frame is dirtied indefinitely. The mesh
   *   neither casts nor receives, exactly like the vehicles it follows, and nothing here sets
   *   `needsUpdate`. See `shadowInvalidation.test.ts`.
   * - **It is one mesh, allocated once.** A mesh per vehicle would add up to 120 draw calls and 120
   *   allocations to every live sample. This is a single pre-allocated buffer sized for the cap,
   *   rewritten in place each frame and bounded with `setDrawRange`, so the trail costs one draw call
   *   whether there is one car or the full 120.
   * - **It is normal-blended, not additive.** Map mode draws a printed basemap on near-white paper,
   *   where an additive ribbon is exactly invisible. Alpha rides in a four-component vertex colour
   *   and the colour itself inverts with the view mode, the same way the vehicle ladder does.
   *
   * Under `prefers-reduced-motion` the group is hidden outright. A trail is a claim about the last
   * two seconds of motion, and where there is no motion there is nothing for it to be about.
   */
  const TRAIL_SEGMENTS = 12
  /**
   * How far back along the road the ribbon reaches, in **unmagnified** world units.
   *
   * Multiplied by the same `magnify` the shells are drawn at, and that is the whole fix for a trail
   * nobody could see. The width was already magnified and the span was not, so the two came apart at
   * exactly the framing this map is usually read at: with the shells scaled 9x to clear
   * `VEHICLE_MIN_PX`, a 26-unit span projects to about 11 CSS px behind a bumper drawn 7 px wide --
   * a smudge wider than it is long, at a third of full alpha, over a road of similar colour.
   *
   * Magnified, the ribbon stays roughly six car-lengths long at every zoom, which is what makes it
   * read as a wake rather than as a blob. It costs nothing extra: the vertex count is fixed by
   * {@link TRAIL_SEGMENTS}, not by how much road each segment spans.
   *
   * It is still bounded by the road actually covered -- `tail` floors at zero -- so a car that has
   * just pulled away has a short trail and grows one, rather than starting with a full-length ribbon
   * over road it was never on.
   */
  const TRAIL_SPAN = 26
  /**
   * How wide the ribbon is at the bumper, **as a fraction of the width of the vehicle leaving it**.
   *
   * This was a flat 1.9 world units for every class, which is roughly a car's width (1.87) — so the
   * ribbon was sized for exactly one of the five rungs and wrong for the other four in both
   * directions. It read worst at the bottom, which is also where most of the traffic is: a bicycle is
   * 0.52 m wide and 1.77 m long, so its wake was **3.6x wider than the bike** and half again wider
   * than the bike was *long*. Measured at whole-city framing on a 60-object database (magnify 12.7),
   * that is a 15.4 px-wide ribbon trailing a 4.2 px-wide, 14.3 px-long shell — which is not a wake,
   * it is a smudge with a speck at the front of it. And 71% of the vehicles on that database are
   * bicycles, so it was the common case rather than an edge one.
   *
   * Deriving it from {@link VEHICLE_SIZE} rather than restating a number is the same lesson the trail
   * *height* taught one screen up: two independent literals is what lets a ribbon and the thing it
   * belongs to drift apart with nothing saying so. A new class, or a re-export of `vehicles.glb` at
   * different proportions, now moves both together.
   *
   * Below one, so the streak sits inside the silhouette and reads as light coming off the vehicle
   * rather than as a tyre mark the full width of it. The resulting ladder at that same framing is
   * 2.6 px / 9.4 px / 11.6 px / 13.2 px for bike, car, van and semi-trailer — narrower than the old
   * flat ribbon at every rung, which is the other half of what was asked for.
   *
   * Deliberately *not* floored at a minimum width. A floor is what {@link VEHICLE_MIN_PX} does for
   * the shells, and it is right there because a vehicle that vanishes tells the reader something
   * false — an empty street already means "nothing was sampled here". A trail carries no such
   * meaning on its own, and a floor would flatten the bottom of exactly the ladder this restores. The
   * narrowest case stays legible anyway because the ribbon is long: at the cap, a bicycle's wake is
   * about a pixel across and some 330 world units back, and a one-pixel streak that long is not
   * something the eye loses.
   */
  const TRAIL_WIDTH_RATIO = 0.62
  /**
   * Opacity at the bumper once a vehicle has settled.
   *
   * Still a garnish, but 0.62 rather than the 0.32 this started at. Alpha is only half of why the
   * first number was invisible -- the span was the other half -- but 0.32 against a lit road at a
   * whole-city framing is below what survives the tone map and the ground texture under it.
   */
  const TRAIL_ALPHA = 0.62
  /** How long a newly released vehicle's trail stays brightened, in seconds. */
  const TRAIL_FLARE_SECONDS = 2.6
  /** How much brighter, at the instant of release. */
  const TRAIL_FLARE_GAIN = 2.4
  const TRAIL_CITY_COLOR = new THREE.Color(0x86e2ff)
  /** A printed basemap has no glow, so the trail inverts to ink the way the vehicle ladder does. */
  const TRAIL_MAP_COLOR = new THREE.Color(0x2b7f9e)
  /** What the bumper end of a city-mode trail is tinted toward, so the leading edge reads as bright. */
  const TRAIL_HIGHLIGHT = new THREE.Color(0xffffff)
  const TRAIL_VERTICES = VEHICLE_CAP * TRAIL_SEGMENTS * 6

  const trailPositions = new Float32Array(TRAIL_VERTICES * 3)
  const trailColors = new Float32Array(TRAIL_VERTICES * 4)
  const trailGeometry = new THREE.BufferGeometry()
  trailGeometry.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3))
  // Four components, so alpha is per-vertex. three reads the itemSize and compiles the shader with
  // USE_COLOR_ALPHA; a three-component attribute would drop the fade silently and leave a flat slab.
  trailGeometry.setAttribute('color', new THREE.BufferAttribute(trailColors, 4))
  trailGeometry.setDrawRange(0, 0)
  const trailMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    // Written into the colour buffer but not the depth buffer: overlapping trails blend instead of
    // punching holes in one another, and nothing behind them is occluded by a garnish.
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  })
  const trailMesh = new THREE.Mesh(trailGeometry, trailMaterial)
  trailMesh.castShadow = false
  trailMesh.receiveShadow = false
  // The ribbon is rewritten every frame and spans the whole plan, so a bounding sphere would have to
  // be recomputed as often as the vertices are. Culling one draw call is not worth that.
  trailMesh.frustumCulled = false
  trailMesh.renderOrder = 2
  trailMesh.visible = false
  vehicleTrailGroup.add(trailMesh)
  disposables.add(trailGeometry)

  const trailSampleX = new Float64Array(TRAIL_SEGMENTS + 1)
  const trailSampleZ = new Float64Array(TRAIL_SEGMENTS + 1)
  const trailNormalX = new Float64Array(TRAIL_SEGMENTS + 1)
  const trailNormalZ = new Float64Array(TRAIL_SEGMENTS + 1)
  const trailPoint = { x: 0, z: 0 }
  const trailColor = new THREE.Color()

  /** The point a given **distance** along a polyline. Distance rather than 0–1, so no length recompute. */
  function pointAtDistance(points: readonly { x: number; z: number }[], distance: number): void {
    if (points.length === 0) {
      trailPoint.x = 0
      trailPoint.z = 0
      return
    }
    let walked = 0
    for (let index = 1; index < points.length; index += 1) {
      const from = points[index - 1]
      const to = points[index]
      const segment = Math.hypot(to.x - from.x, to.z - from.z)
      if (walked + segment >= distance) {
        const along = segment === 0 ? 0 : (distance - walked) / segment
        trailPoint.x = from.x + (to.x - from.x) * along
        trailPoint.z = from.z + (to.z - from.z) * along
        return
      }
      walked += segment
    }
    const last = points[points.length - 1]
    trailPoint.x = last.x
    trailPoint.z = last.z
  }

  /**
   * Rewrites the trail ribbon for every moving vehicle.
   *
   * Returns the number of vertices written, which bounds the draw. Stopped vehicles get nothing: a
   * blocked request is not moving, so there is no recent road behind it to draw and a trail there
   * would read as motion that is not happening.
   */
  function writeTrails(seconds: number, magnify: number): number {
    let vertex = 0
    const flat = viewMode === 'map'
    const base = flat ? TRAIL_MAP_COLOR : TRAIL_CITY_COLOR
    // Magnified with the shells, so the ribbon keeps its proportion to the car at every zoom. See
    // TRAIL_SPAN: magnifying one and not the other is what made this invisible.
    const span = TRAIL_SPAN * magnify

    for (const batch of vehicleBatches) {
      // Per class, not per frame: the batches are already grouped by class, so the wake of every
      // vehicle in one costs a single multiply rather than a lookup per vehicle. See
      // TRAIL_WIDTH_RATIO for why this is no longer one width shared by all five rungs.
      const halfWidth = (VEHICLE_SIZE[batch.klass].width * TRAIL_WIDTH_RATIO * magnify) / 2
      for (let index = 0; index < batch.moving; index += 1) {
        const vehicle = batch.vehicles[index]
        const length = batch.routeLengths[index]
        if (length <= 0) continue
        if (vertex + TRAIL_SEGMENTS * 6 > TRAIL_VERTICES) return vertex

        const elapsed = vehicle.elapsedSeconds + seconds
        // A vehicle still waiting out its launch stagger has covered no road, so it has no wake.
        if (elapsed <= 0) continue
        const head = travelledFraction(
          vehicle.points,
          elapsed,
          vehicle.finishedAfterSeconds,
          vehicle.speedScale,
        ) * length
        const tail = Math.max(0, head - span)
        if (head - tail < 0.01) continue

        for (let step = 0; step <= TRAIL_SEGMENTS; step += 1) {
          pointAtDistance(vehicle.points, tail + ((head - tail) * step) / TRAIL_SEGMENTS)
          trailSampleX[step] = trailPoint.x
          trailSampleZ[step] = trailPoint.z
        }
        for (let step = 0; step <= TRAIL_SEGMENTS; step += 1) {
          const before = Math.max(0, step - 1)
          const after = Math.min(TRAIL_SEGMENTS, step + 1)
          const dx = trailSampleX[after] - trailSampleX[before]
          const dz = trailSampleZ[after] - trailSampleZ[before]
          const span = Math.hypot(dx, dz)
          // A degenerate step collapses to zero width rather than picking an arbitrary normal, so a
          // doubled-back polyline produces nothing visible instead of a stray triangle.
          trailNormalX[step] = span === 0 ? 0 : (-dz / span) * halfWidth
          trailNormalZ[step] = span === 0 ? 0 : (dx / span) * halfWidth
        }

        const flare = elapsed < TRAIL_FLARE_SECONDS
          ? 1 + (TRAIL_FLARE_GAIN - 1) * (1 - elapsed / TRAIL_FLARE_SECONDS)
          : 1
        const headAlpha = TRAIL_ALPHA * flare

        for (let step = 0; step < TRAIL_SEGMENTS; step += 1) {
          const near = step
          const far = step + 1
          // Quad corners: two rows of two, wound as two triangles.
          const corners = [near, near, far, near, far, far] as const
          const sides = [-1, 1, 1, -1, 1, -1] as const
          for (let corner = 0; corner < 6; corner += 1) {
            const at = corners[corner]
            const side = sides[corner]
            const offset = vertex * 3
            trailPositions[offset] = trailSampleX[at] + trailNormalX[at] * side
            trailPositions[offset + 1] = TRAIL_Y
            trailPositions[offset + 2] = trailSampleZ[at] + trailNormalZ[at] * side
            const ramp = at / TRAIL_SEGMENTS
            trailColor.copy(base)
            // Whiter at the bumper, so the leading edge reads as the bright end even where the
            // alpha ramp alone would not separate it from the road under it.
            if (!flat) trailColor.lerp(TRAIL_HIGHLIGHT, ramp * 0.45)
            const colorOffset = vertex * 4
            trailColors[colorOffset] = trailColor.r
            trailColors[colorOffset + 1] = trailColor.g
            trailColors[colorOffset + 2] = trailColor.b
            trailColors[colorOffset + 3] = headAlpha * ramp * ramp
            vertex += 1
          }
        }
      }
    }
    return vertex
  }

  /**
   * Writes every vehicle's instance matrix for the current `vehicleClock` and camera.
   *
   * Called from {@link draw}, not from the animation loop, so that a frame caused by anything at all
   * — a camera nudge, a resize, a live tick — leaves the vehicles correctly placed and correctly
   * sized. At the 120-vehicle cap this is at most a few hundred matrix composes, which is far below
   * the cost of the draw calls it is preparing.
   */
  function placeVehicles() {
    if (vehicleBatches.length === 0) {
      // The roster drained. The ribbon holds the last frame's vertices, so it has to be hidden here
      // or the trails of vehicles that have left the map keep being drawn.
      trailMesh.visible = false
      trailGeometry.setDrawRange(0, 0)
      return
    }

    /*
     * One shared magnification for every vehicle, deliberately.
     *
     * The whole point of the four shells is the ratio between their lengths, so the minimum size is
     * enforced by scaling them all by the same factor rather than by clamping each one. Clamping per
     * class would flatten the ladder at exactly the zoom levels where the reader most needs it: the
     * bicycle would grow to the floor while the truck stayed put, and at a wide enough framing every
     * class would end up the same length.
     */
    const distance = camera.position.distanceTo(controls.target)
    const magnify = labelScreenScale(
      VEHICLE_SIZE.bike.length,
      distance,
      camera.fov,
      Math.max(canvas.clientHeight, 1),
      VEHICLE_MIN_PX,
      VEHICLE_MAX_GROWTH,
    )
    vehicleScale.setScalar(magnify)
    // Time since the roster was built, not since the scene started: the roster already carries each
    // vehicle's age in wall-clock seconds, recomputed from the feed on every rebuild.
    const seconds = (vehicleClock - vehicleClockAtBuild) / 1000

    for (const batch of vehicleBatches) {
      for (let index = 0; index < batch.vehicles.length; index += 1) {
        const vehicle = batch.vehicles[index]
        const stop = vehicle.blockedAt
        let x: number
        let z: number
        let yaw: number
        if (stop) {
          x = stop.x
          z = stop.z
          yaw = batch.stoppedYaw[index]
        } else {
          const length = batch.routeLengths[index]
          const travelled = travelledFraction(
            vehicle.points,
            vehicle.elapsedSeconds + seconds,
            vehicle.finishedAfterSeconds,
            vehicle.speedScale,
          )
          const at = pointAt(vehicle.points, travelled)
          x = at.x
          z = at.z
          yaw = headingAt(vehicle.points, travelled, length)
        }
        vehiclePosition.set(x, VEHICLE_Y, z)
        vehicleQuaternion.setFromAxisAngle(UP, yaw)
        vehicleMatrix.compose(vehiclePosition, vehicleQuaternion, vehicleScale)
        for (const mesh of batch.meshes) mesh.setMatrixAt(index, vehicleMatrix)
      }
      for (const mesh of batch.meshes) mesh.instanceMatrix.needsUpdate = true
    }

    /*
     * Trails last, so they are written from the same clock the vehicles were placed from.
     *
     * Skipped wholesale under `prefers-reduced-motion`: the vehicle loop never starts there, so
     * every car stands still between samples and a wake behind a stationary shell would be drawing
     * motion that is not happening.
     */
    if (reducedMotion) {
      trailMesh.visible = false
      return
    }
    const written = writeTrails(seconds, magnify)
    trailGeometry.setDrawRange(0, written)
    trailGeometry.attributes.position.needsUpdate = true
    trailGeometry.attributes.color.needsUpdate = true
    trailMesh.visible = written > 0
  }

  /**
   * The yaw that points a shell down its route at `t`.
   *
   * The kit is authored nose-first along **+Z** (Blender's +Y forward, turned by the exporter's
   * y-up conversion), so a yaw of `atan2(dx, dz)` about the up axis aims it along the segment. A
   * vehicle facing backwards is the visible symptom of getting that convention wrong.
   */
  function headingAt(points: readonly { x: number; z: number }[], t: number, length: number): number {
    if (points.length < 2 || length <= 0) return 0
    // A metre of lookahead: long enough not to be swamped by floating-point noise on a short
    // segment, short enough to follow a bend rather than cutting across it.
    const step = Math.min(0.5, 1 / length)
    const behind = pointAt(points, Math.max(0, t - step))
    const ahead = pointAt(points, Math.min(1, t + step))
    const dx = ahead.x - behind.x
    const dz = ahead.z - behind.z
    if (dx === 0 && dz === 0) return 0
    return Math.atan2(dx, dz)
  }

  /** The heading of whichever segment passes closest to a stopped vehicle's halt point. */
  function headingNear(points: readonly { x: number; z: number }[], at: { x: number; z: number }): number {
    if (points.length < 2) return 0
    let best = 0
    let bestDistance = Number.POSITIVE_INFINITY
    for (let index = 1; index < points.length; index += 1) {
      const from = points[index - 1]
      const to = points[index]
      const dx = to.x - from.x
      const dz = to.z - from.z
      const lengthSquared = dx * dx + dz * dz
      const along = lengthSquared === 0
        ? 0
        : Math.min(1, Math.max(0, ((at.x - from.x) * dx + (at.z - from.z) * dz) / lengthSquared))
      const measured = Math.hypot(from.x + dx * along - at.x, from.z + dz * along - at.z)
      if (measured < bestDistance) {
        bestDistance = measured
        best = dx === 0 && dz === 0 ? best : Math.atan2(dx, dz)
      }
    }
    return best
  }

  /**
   * Rebuilds the roster from whatever has most recently been measured, and redraws it.
   *
   * Called both when a new live sample arrives and when the **roads** change, because a vehicle is
   * only ever placed on a road this scene drew: a re-plan that moves a street has to move the
   * traffic on it, and a road that stops being drawn has to lose its vehicles rather than leave them
   * driving over open ground.
   */
  function refreshVehicles() {
    const roads = [...roadPaths.values()].map(entry => ({
      routeId: entry.road.routeId,
      familyIds: entry.road.familyIds,
      executions: entry.road.executions,
      polyline: entry.polyline,
    }))
    vehicleRoster = buildVehicleRoster({
      events: currentEvents,
      families: currentFamilies,
      roads,
      blocked: blockedPlacements,
      now: Date.now(),
    })
    vehicleClockAtBuild = vehicleClock
    buildVehicles()
    options.onVehicleRoster?.(vehicleRoster)
  }

  type Placer = (
    asset: SceneryAsset,
    x: number,
    z: number,
    spin: number,
    scale: number | THREE.Vector3,
    y?: number,
  ) => void
  /** What grows on each kind of ground. One recipe per land use, all seeded from the block. */
  function dressBlock(block: TerrainBlock, place: Placer) {
    const random = seededStream(block.seed)
    const reach = block.size / 2 - 2.5
    if (reach <= 0) return
    const spot = () => ({ x: block.x + (random() * 2 - 1) * reach, z: block.z + (random() * 2 - 1) * reach })
    const spin = () => random() * Math.PI * 2
    const scatter = (asset: SceneryAsset, count: number, low: number, high: number) => {
      for (let i = 0; i < count; i += 1) {
        const point = spot()
        place(asset, point.x, point.z, spin(), low + random() * (high - low))
      }
    }

    switch (block.use) {
      case 'park': {
        // Denser tree cover further from the built core, which is what `relief` is for: it is a
        // decorative distance-from-centre field and drives nothing that is measured.
        scatter('tree_broadleaf', 3 + Math.round(block.relief * 3), 0.85, 1.35)
        scatter('tree_ornamental', 2, 0.8, 1.1)
        scatter('shrub', 3, 0.8, 1.3)
        const bench = spot()
        place('bench', bench.x, bench.z, spin(), 1)
        if (random() < 0.32) place('fountain', block.x, block.z, 0, 1)
        else if (random() < 0.3) place('pavilion', block.x, block.z, spin(), 1)
        break
      }
      case 'woodland':
        scatter('tree_conifer', 6 + Math.round(block.relief * 5), 0.9, 1.5)
        scatter('tree_broadleaf', 3, 0.9, 1.25)
        scatter('shrub', 2, 0.7, 1.1)
        break
      case 'greenway': {
        // A greenway is a strip, so its trees line up rather than scatter.
        const rows = 4
        for (let i = 0; i < rows; i += 1) {
          const t = (i + 0.5) / rows
          const x = block.x - reach + t * reach * 2
          place('tree_ornamental', x, block.z - reach * 0.4, spin(), 0.8 + random() * 0.3)
          place('hedge', x, block.z + reach * 0.5, 0, new THREE.Vector3(reach * 2 / rows, 1, 1))
        }
        break
      }
      case 'orchard': {
        // Planted, so it is drawn planted: a regular grid is the whole visual signature.
        const rows = 3
        for (let row = 0; row < rows; row += 1) {
          for (let col = 0; col < rows; col += 1) {
            const x = block.x + (col / (rows - 1) - 0.5) * reach * 1.9
            const z = block.z + (row / (rows - 1) - 0.5) * reach * 1.9
            place('tree_ornamental', x, z, spin(), 0.85 + random() * 0.2)
          }
        }
        break
      }
      case 'plaza': {
        place('fountain', block.x, block.z, 0, 1.15)
        for (let i = 0; i < 4; i += 1) {
          const angle = (i / 4) * Math.PI * 2 + Math.PI / 4
          place('bench', block.x + Math.cos(angle) * reach * 0.55, block.z + Math.sin(angle) * reach * 0.55, angle, 1)
        }
        place('kiosk', block.x + reach * 0.7, block.z - reach * 0.7, spin(), 1)
        scatter('tree_ornamental', 2, 0.8, 1)
        break
      }
      case 'parking': {
        // Two rows either side of a centre aisle, which is what makes a car park read as a car park.
        const bays = 4
        for (let row = 0; row < 2; row += 1) {
          for (let bay = 0; bay < bays; bay += 1) {
            const x = block.x + ((bay + 0.5) / bays - 0.5) * reach * 1.9
            const z = block.z + (row === 0 ? -1 : 1) * reach * 0.52
            place('parked_car', x, z, row === 0 ? 0 : Math.PI, 1)
          }
        }
        place('streetlight', block.x - reach * 0.9, block.z, 0, 1)
        break
      }
      case 'yard':
        place('bus_shelter', block.x, block.z + reach * 0.6, Math.PI, 1)
        place('streetlight', block.x + reach * 0.8, block.z - reach * 0.5, 0, 1)
        scatter('shrub', 3, 0.7, 1.1)
        break
      case 'built':
        // Occupied blocks get furniture only, never planting: the building is the measurement, and
        // nothing decorative may crowd it.
        place('streetlight', block.x - block.size / 2 - 2.2, block.z - block.size / 2 - 2.2, 0, 1)
        if (block.seed % 5 === 0) place('signal', block.x + block.size / 2 + 2.2, block.z + block.size / 2 + 2.2, Math.PI, 1)
        break
      default:
        break
    }
  }

  /** Repeats the authored one-metre bridge tile along a crossing, stretched to the street's width. */
  function dressBridge(path: readonly { x: number; z: number }[], width: number, place: Placer) {
    for (let i = 1; i < path.length; i += 1) {
      const ax = path[i - 1].x
      const az = path[i - 1].z
      const length = Math.hypot(path[i].x - ax, path[i].z - az)
      if (length < 0.5) continue
      const heading = Math.atan2(path[i].x - ax, path[i].z - az) - Math.PI / 2
      place(
        'bridge_deck',
        (ax + path[i].x) / 2,
        (az + path[i].z) / 2,
        heading,
        new THREE.Vector3(length, 1, width + 3.6),
        -0.12,
      )
    }
  }

  const UP = new THREE.Vector3(0, 1, 0)

  /** The same small deterministic stream the plan uses, so scenery inherits the plan's determinism. */
  function seededStream(seed: number) {
    let state = (seed >>> 0) || 1
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state / 4294967296
    }
  }

  /** Land cover and water: the ~47% of the plan that carries no building. */
  function buildLandCover(cityPlan: CityPlan) {
    const terrain = cityPlan.terrain
    const tiles = new Map<LandUse, { position: number[]; color: number[] }>()
    const tileFor = (use: LandUse) => {
      let bucket = tiles.get(use)
      if (!bucket) {
        bucket = { position: [], color: [] }
        tiles.set(use, bucket)
      }
      return bucket
    }

    for (const block of terrain.blocks.values()) {
      /*
       * Facility blocks are skipped because the landmark draws its own plate there. Built blocks are
       * not: a parcel is a surface on a real map, and without one every occupied plot fell through to
       * the bare terrain underneath and the city read as buildings standing in a field.
       */
      if (block.use === 'facility') continue
      const bucket = tileFor(block.use)
      // The parcel is the block's own polygon, pulled in off the kerb line so the carriageway
      // stays on top of ground rather than of another parcel.
      const vertices = pushPolygon(
        bucket.position,
        cityPlan.warp.blockCorners(block.col, block.row),
        LAND_LAYER[block.use] ?? -0.55,
        cityPlan.streetWidth / 2 - 1.2,
      )
      /*
       * A whisper of per-block shade.
       *
       * Vertex colour *multiplies* the material colour, so one seeded value near 1.0 breaks up a
       * large expanse of parkland in both palettes without needing a second material or a texture.
       * Kept inside ±12% so it never reads as a category of its own. One colour per vertex the fan
       * emitted, however many sides the block has, or the colour buffer falls short of the positions.
       */
      const shade = 0.88 + ((block.seed % 97) / 97) * 0.24
      for (let i = 0; i < vertices; i += 1) bucket.color.push(shade, shade, shade)
    }

    for (const [use, bucket] of tiles) {
      if (bucket.position.length === 0) continue
      const geometry = track(new THREE.BufferGeometry())
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(bucket.position, 3))
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(bucket.color, 3))
      geometry.computeVertexNormals()
      const mesh = new THREE.Mesh(geometry, landMaterials[use])
      mesh.receiveShadow = true
      groundGroup.add(mesh)
    }

    if (terrain.river.length > 1) {
      const banks = riverPositions(terrain.river, 3.4, -0.46)
      const water = riverPositions(terrain.river, 0, -0.5)
      addMerged(groundGroup, banks, riverMaterials.bank, 1)
      addMerged(groundGroup, water, riverMaterials.water, 1)
    }
  }

  /** Kerbs, carriageways, centre lines and bridge decks, merged per street class. */
  function buildCarriageways(cityPlan: CityPlan) {
    const fill = new Map<StreetClass, number[]>()
    const casing = new Map<StreetClass, number[]>()
    const laneMark: number[] = []
    const deck: number[] = []
    const bucket = (map: Map<StreetClass, number[]>, key: StreetClass) => {
      let list = map.get(key)
      if (!list) {
        list = []
        map.set(key, list)
      }
      return list
    }

    for (const street of cityPlan.streets) {
      const path = street.path
      if (path.length < 2) continue
      const klass = street.streetClass
      if (street.bridge) {
        // A bridge is drawn as a deck sitting over the water rather than as ground painted on it,
        // so the crossing reads as a crossing from the oblique view.
        ribbonPositions(path, street.width + 4.4, null, 0, deck, -0.16)
        ribbonPositions(path, street.width, null, 0, bucket(fill, klass), -0.1)
        ribbonPositions(path, 0.5, DASH_PATTERNS.dashed, 0, laneMark, -0.06)
        continue
      }
      // One casing ribbon rather than two offset kerb strips: on a curve, two independently offset
      // polylines drift apart on the outside of the bend and cross on the inside. A single wider
      // ribbon under the carriageway follows the same centre line, so it can never come adrift.
      ribbonPositions(path, street.width + 6.4, null, 0, bucket(casing, klass), -0.3)
      ribbonPositions(path, street.width, null, 0, bucket(fill, klass), -0.25)
      ribbonPositions(path, 0.5, null, 0, laneMark, -0.2)
    }

    // Casings first, so the wider ribbon of a minor street can never paint over a wider street's fill.
    for (const [klass, positions] of casing) addMerged(groundGroup, positions, streetCasing[klass])
    for (const [klass, positions] of fill) addMerged(groundGroup, positions, streetFill[klass])
    addMerged(groundGroup, laneMark, materials.laneMark)
    addMerged(groundGroup, deck, streetCasing.motorway)
  }

  /**
   * Point the sun at the city and size its shadow frustum to fit.
   *
   * A directional light's shadow camera is orthographic and has no idea how big the scene is, so it
   * has to be told. Sized off the plan's own diagonal, one city gets crisp shadows and another gets
   * shadows at all, rather than one hard-coded box that suits neither.
   */
  function aimSunAt(cityPlan: CityPlan) {
    const { centerX, centerZ, width, depth } = cityPlan.bounds
    const reach = Math.max(width, depth) * 0.62 + ARTERIAL_WIDTH * 6
    const atmosphere = cityAtmosphere()
    keyLight.target.position.set(centerX, 0, centerZ)
    keyLight.target.updateMatrixWorld()
    /*
     * Elevation and heading both come from the hour. A low sun is the whole of a golden hour and a
     * high one is the whole of midday, so leaving the sun where evening put it and only recolouring
     * it renders morning as evening in different paint — the shadows are the tell, and they are the
     * drawing's cheapest depth cue.
     */
    keyLight.position.set(
      centerX + reach * atmosphere.sunEast,
      reach * atmosphere.sunHeight,
      centerZ + reach * atmosphere.sunSouth,
    )
    const shadow = keyLight.shadow.camera
    shadow.left = -reach
    shadow.right = reach
    shadow.top = reach
    shadow.bottom = -reach
    shadow.near = 1
    // A high sun stands further from the city than a low one, so the far plane has to clear wherever
    // this hour actually put it, or midday clips its own shadow frustum and loses every shadow at
    // once. The `reach * 5` floor is the historical value and still wins at every low sun.
    shadow.far = Math.max(reach * 5, keyLight.position.distanceTo(keyLight.target.position) * 2)
    shadow.updateProjectionMatrix()
    fillLight.position.set(centerX - reach, reach * 1.1, centerZ - reach)
  }

  /** Layer heights for land cover, so parkland never z-fights the plate it sits on. */
  const LAND_LAYER: Partial<Record<LandUse, number>> = {
    // Built parcels sit lowest so every other cover type reads as laid on top of the city fabric.
    built: -0.6,
    water: -0.58,
    park: -0.55,
    greenway: -0.54,
    woodland: -0.55,
    orchard: -0.54,
    plaza: -0.53,
    parking: -0.53,
    yard: -0.52,
  }

  /*
   * Wound counter-clockwise seen from above, so the face normal points at the sky.
   *
   * Worth stating because getting it backwards is silent: a downward-facing quad is simply a back
   * face to an aerial camera, so the whole land cover disappears without an error, a warning, or a
   * missing draw call to notice.
   */
  function pushPolygon(
    out: number[],
    corners: readonly { x: number; z: number }[],
    y: number,
    inset: number,
  ): number {
    if (corners.length < 3) return 0
    let cx = 0
    let cz = 0
    for (const corner of corners) {
      cx += corner.x / corners.length
      cz += corner.z / corners.length
    }
    const pulled = corners.map(corner => {
      const dx = cx - corner.x
      const dz = cz - corner.z
      const length = Math.hypot(dx, dz) || 1
      // Never past the centre, or a thin block turns inside out and renders as a bow tie.
      const step = Math.min(inset, length * 0.45)
      return { x: corner.x + (dx / length) * step, z: corner.z + (dz / length) * step }
    })
    /*
     * A block is a face of the street graph now, a polygon of any number of sides, so it is tiled as
     * a fan from its centroid rather than split as a fixed quad. The block builder guarantees the
     * centroid lies inside the polygon, so every fan triangle stays within the block. The fan is wound
     * clockwise in the ground plane — the reverse of the polygon's own counter-clockwise order —
     * because that is the winding whose normal faces an overhead camera, and a back-facing parcel
     * vanishes silently just as a back-facing quad would.
     */
    for (let i = 0; i < pulled.length; i += 1) {
      const a = pulled[i]
      const b = pulled[(i + 1) % pulled.length]
      out.push(cx, y, cz, b.x, y, b.z, a.x, y, a.z)
    }
    return pulled.length * 3
  }

  /** A river is a ribbon whose half-width changes along its length, so it cannot reuse the road path. */
  function riverPositions(nodes: readonly { x: number; z: number; halfWidth: number }[], grow: number, y: number) {
    const out: number[] = []
    const edge = (index: number, side: number) => {
      const node = nodes[index]
      const before = nodes[index - 1] ?? node
      const after = nodes[index + 1] ?? node
      const dx = after.x - before.x
      const dz = after.z - before.z
      const length = Math.hypot(dx, dz) || 1
      const half = node.halfWidth + grow
      return { x: node.x + (-dz / length) * half * side, z: node.z + (dx / length) * half * side }
    }
    for (let i = 1; i < nodes.length; i += 1) {
      const al = edge(i - 1, 1)
      const ar = edge(i - 1, -1)
      const bl = edge(i, 1)
      const br = edge(i, -1)
      out.push(al.x, y, al.z, bl.x, y, bl.z, br.x, y, br.z, al.x, y, al.z, br.x, y, br.z, ar.x, y, ar.z)
    }
    return out
  }

  function addMerged(group: THREE.Group, positions: number[], material: THREE.Material, shade?: number) {
    if (positions.length === 0) return
    const geometry = track(new THREE.BufferGeometry())
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    // Land-cover materials multiply by vertex colour; a ribbon that carries no per-block shade still
    // has to supply the attribute or the shader reads garbage.
    if (shade !== undefined) {
      const colors = new Float32Array(positions.length).fill(shade)
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    }
    geometry.computeVertexNormals()
    const mesh = new THREE.Mesh(geometry, material)
    mesh.receiveShadow = true
    group.add(mesh)
  }

  function addQuad(
    group: THREE.Group,
    width: number,
    depth: number,
    x: number,
    z: number,
    y: number,
    material: THREE.Material,
  ) {
    const geometry = track(new THREE.PlaneGeometry(width, depth))
    geometry.rotateX(-Math.PI / 2)
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(x, y, z)
    group.add(mesh)
  }

  /**
   * Washes each schema's neighbourhood over the ground it claimed.
   *
   * One quad per claimed block rather than one bounding rectangle: territories are grown, so their
   * real shape is ragged, and a bounding box would paint over the neighbours either side of an
   * L-shaped one. Drawn at low opacity under the roads, so it tints the land without hiding what is
   * on it — the same way a basemap shades a district behind its streets rather than in front of them.
   *
   * Facilities are not washed. They belong to the whole city rather than to any schema, and a tinted
   * plate under one would say it belonged to the neighbourhood that happens to surround it.
   */
  function buildDistricts(cityPlan: CityPlan) {
    clearGroup(districtGroup)
    for (const district of cityPlan.districts) {
      if (district.blocks.length === 0) continue
      const material = districtMaterial(neighborhoodTint(district.neighborhoodOrdinal))
      const positions: number[] = []
      for (const block of district.blocks) {
        // Negative inset: the wash runs a little past the kerb so adjacent blocks of one
        // neighbourhood join into a single field of colour instead of a run of separate plates.
        pushPolygon(positions, cityPlan.warp.blockCorners(block.col, block.row), -0.5, -0.5)
      }
      addMerged(districtGroup, positions, material)
    }
  }

  /** Places a neighbourhood's name over the middle of the ground it owns. */
  function buildNeighborhoodLabels(cityPlan: CityPlan) {
    clearGroup(neighborhoodLabelGroup)
    const pitch = streetPitch(cityPlan)
    for (const district of cityPlan.districts) {
      const text = neighborhoodLabelText(district.name)
      if (text.length === 0 || district.blocks.length === 0) continue
      const worldHeight = neighborhoodLabelHeight(district.blocks.length, (pitch.x + pitch.z) / 2)
      const sprite = labelFactory.make(text, {
        variant: 'neighborhood',
        tint: neighborhoodTint(district.neighborhoodOrdinal),
        worldHeight,
      })
      if (!sprite) continue
      // Above the rooftops of an ordinary street, and above its own type size, so the name floats
      // over its neighbourhood instead of being lost among the buildings it names.
      sprite.position.set(district.labelX, worldHeight / 2 + 34, district.labelZ)
      // The authored size is kept so the screen-space floor can scale from it each frame rather
      // than compounding on whatever it set last time.
      sprite.userData.baseScaleX = sprite.scale.x
      sprite.userData.baseScaleY = sprite.scale.y
      sprite.userData.baseY = sprite.position.y
      sprite.userData.labelWorldHeight = worldHeight
      sprite.userData.labelId = district.name
      neighborhoodLabelGroup.add(sprite)
    }
  }

  /** Places a label on the pavement in front of a building, in world space so it never rotates with the lot. */
  function addBuildingLabel(object: DatabaseCityObject, lot: CityLot) {
    // Larger tables are lettered larger, so their names survive to a wider zoom than a small
    // table's. The height is kept on the sprite because that is what the legibility test reads.
    const worldHeight = buildingLabelWorldHeight(lot.height)
    const sprite = labelFactory.make(buildingLabelText(object.name), {
      variant: 'building',
      worldHeight,
    })
    if (!sprite) return
    const anchor = labelAnchor(lot.x, lot.z, lot.accessX, lot.accessZ, (lot.footprint ?? 11) / 2 + 3)
    sprite.position.set(anchor.x, worldHeight / 2 + 0.7, anchor.z)
    sprite.userData.labelWorldHeight = worldHeight
    buildingLabelGroup.add(sprite)
  }

  function buildBuildings(objects: readonly DatabaseCityObject[], cityPlan: CityPlan) {
    clearGroup(buildingGroup)
    clearGroup(buildingLabelGroup)
    pickable.length = 0
    // Every building in a schema takes the same hue, which is what makes a neighbourhood read as one
    // place from the air rather than as a run of unrelated blocks that happen to be adjacent.
    const tints = new Map<string, number>(
      cityPlan.districts.map(district => [district.districtId, neighborhoodTint(district.neighborhoodOrdinal)]),
    )
    /*
     * Weathering is per object, not a city-wide wash.
     *
     * Staleness is measured per object, so a single flag would weather buildings whose statistics
     * were rebuilt an hour ago just because some other table's were not — which reads as a claim
     * about those buildings that the evidence does not make.
     */
    const weatheredBuildingColor = (color: number, objectId: string): number =>
      staleStatsObjectIds.has(objectId) ? mixColor(color, 0x4f4a45, 0.35) : color
    /*
     * Shadow casting is capped rather than universal.
     *
     * Every caster is another draw of the whole building into the depth map, so a ten-thousand-table
     * instance would spend its entire frame budget rendering the scene twice. Casters are taken from
     * the front of the object list, which the planner has already ordered deterministically, so the
     * same database always casts the same shadows. Everything still *receives* shadow, which is where
     * most of the depth cue actually comes from.
     */
    const casters = Math.min(objects.length, MAX_SHADOW_CASTERS)
    let drawn = 0
    for (const object of objects) {
      const lot = cityPlan.lots.get(object.objectId)
      if (!lot) continue
      addBuildingLabel(object, lot)
      const known = lot.footprint !== null && lot.height !== null
      const casts = drawn < casters
      drawn += 1
      const group = new THREE.Group()
      group.position.set(lot.x, 0, lot.z)
      group.rotation.y = lot.rotationY
      group.userData.objectId = object.objectId

      const character = cityPlan.terrain.characters.get(lot.districtId)
      const geometry = buildBuildingGeometry(lot, character)
      const tint = tints.get(lot.districtId)
      const bodyColor = weatheredBuildingColor(buildingColor(lot.archetype, character, tint), object.objectId)
      const mapColor = weatheredBuildingColor(mapBuildingColor(lot.archetype, MAP_PALETTE.building, tint), object.objectId)
      const body = new THREE.Mesh(
        track(geometry.body),
        known
          ? bodyMaterial(
              bodyColor,
              mapColor,
            )
          : materials.unknown,
      )
      body.userData.objectId = object.objectId
      body.castShadow = casts
      body.receiveShadow = true
      group.add(body)
      pickable.push(body)

      if (known && geometry.windows) {
        const windows = new THREE.Mesh(track(geometry.windows), materials.window)
        windows.userData.objectId = object.objectId
        group.add(windows)
      } else if (geometry.windows) {
        geometry.windows.dispose()
      }
      if (known && geometry.trim) {
        const trim = new THREE.Mesh(track(geometry.trim), materials.trim)
        trim.userData.objectId = object.objectId
        group.add(trim)
      } else if (geometry.trim) {
        geometry.trim.dispose()
      }

      // Index annexes: width still maps direct DMV operations, exactly as before.
      const footprint = lot.footprint ?? 11
      object.indexes.forEach((index, ordinal) => {
        const width = directActivityWidth(index.directActivity.totalOperations)
        const annex = new THREE.Mesh(
          track(new THREE.BoxGeometry(width ?? 4, 1.7, Math.max(4, footprint * 0.5))),
          width === null ? materials.unknownIndex : materials.index,
        )
        annex.position.set(footprint / 2 + (width ?? 4) / 2 + 1.4, 0.85 + ordinal * 2, -footprint * 0.14)
        annex.userData.objectId = object.objectId
        group.add(annex)
        pickable.push(annex)
      })

      // Amber roof cap: attributed Query Store CPU. A solid cap is a total measured for this object
      // alone; an outlined one is a query total shared with the other tables the same query named,
      // which is the only figure a join-heavy workload can honestly produce.
      const attributedCpu = object.attributedExposure.totalCpuMicroseconds
      const sharedCpu = object.attributedExposure.shared?.totalCpuMicroseconds ?? null
      const capCpu = attributedCpu ?? sharedCpu
      if (known && capCpu !== null) {
        const cpu = Number(BigInt(capCpu))
        const capHeight = 0.5 + Math.log2(1 + Math.max(0, cpu)) * 0.05
        const cap = new THREE.Mesh(
          track(new THREE.BoxGeometry(footprint * 0.55, capHeight, footprint * 0.55)),
          attributedCpu === null ? materials.sharedExposure : materials.exposure,
        )
        cap.position.set(0, geometry.height + capHeight / 2 + 0.4, 0)
        cap.userData.objectId = object.objectId
        group.add(cap)
        pickable.push(cap)
      }

      buildingGroup.add(group)
    }
  }

  /**
   * Draws the workload's traffic on the streets that carry it.
   *
   * One ribbon per street, not one per query, all at the same {@link ROAD_WIDTH}. Colour is the
   * whole story: it comes from the waiting those executions carried, so a dark-red street is one the
   * workload waits on — which is the thing you want to see standing back from a city. Executions no
   * longer change the width; they are still reported on the street and in the evidence tables.
   */
  function buildTraffic(traffic: WorkloadTraffic) {
    clearGroup(trafficGroup)
    if (traffic.streets.size === 0) return

    // Busiest first so a heavy street keeps the top of the stack where two overlap at a junction.
    const ordered = [...traffic.streets.values()].sort(
      (left, right) => right.executions - left.executions || left.edgeId - right.edgeId,
    )
    for (const street of ordered) {
      if (street.points.length < 2) continue
      const ribbon = ribbonGeometry(street.points, ROAD_WIDTH, null)
      if (!ribbon) continue
      const mesh = new THREE.Mesh(track(ribbon), roadMaterial(street.color, false, GROUND_RANK.traffic))
      mesh.position.y = 0.045
      mesh.renderOrder = 1
      trafficGroup.add(mesh)
    }
  }

  /**
   * Draws every graded road. Roads that share a street leg are pushed into their own lane so a
   * busy corridor reads as several distinct routes instead of one stack of overlapping ribbons.
   */
  function buildRoads(roads: readonly RoadTraffic[], cityPlan: CityPlan) {
    clearGroup(roadGroup)
    clearGroup(roadCasingGroup)
    roadPickable.length = 0
    roadPaths.clear()

    // Busiest first, so the heaviest traffic keeps the centre line and the light roads move aside.
    // Every ribbon is the same width now, so executions do the ordering they used to do by proxy.
    const ordered = [...roads].sort(
      (left, right) => (right.executions ?? -1) - (left.executions ?? -1) || left.routeId.localeCompare(right.routeId),
    )
    const corridorLanes = new Map<string, Set<number>>()

    // Every on-map ribbon's path, spread across the network by loading the measured executions as
    // demand. This only chooses the way each ribbon takes; its width, colour and pattern are the
    // measured quantities set by `gradeRoads` and are applied unchanged below.
    const assigned = assignQueryRoutes(cityPlan, roads)

    for (const road of ordered) {
      const from = cityPlan.lots.get(road.fromObjectId)
      if (!from) continue
      const to = cityPlan.lots.get(road.toId)
      // A cross-database reference leaves the city on a ramp through the nearest boundary.
      const target = to ? { x: to.accessX, z: to.accessZ } : rampPoint(cityPlan, from)
      const spread = to ? assigned.get(road.routeId) : undefined
      const route = spread ?? streetRoute(cityPlan, { x: from.accessX, z: from.accessZ }, target)
      const points = route.points
      const corridors = corridorKeys(route.nodeIds)
      const lane = claimLane(corridorLanes, corridors)
      const offset = laneOffset(lane)
      const centreline = offsetPolyline(points, offset)
      const ribbon = ribbonGeometry(points, road.width, DASH_PATTERNS[road.pattern], offset)
      if (!ribbon) continue
      const mesh = new THREE.Mesh(track(ribbon), roadMaterial(road.color, road.pattern !== 'solid', roadRank(lane)))
      // Lane order also stacks the ribbons a hair apart so coplanar roads never z-fight. The trail
      // and the vehicles are laid above the top of this stack -- see ROAD_TOP_Y.
      mesh.position.y = ROAD_Y + lane * ROAD_LANE_STEP
      mesh.userData.routeId = road.routeId
      mesh.renderOrder = 1
      roadGroup.add(mesh)
      roadPickable.push(mesh)
      roadPaths.set(road.routeId, { road, polyline: centreline, endsOffMap: !to })

      // The casing is the same ribbon, wider and beneath. On a light basemap it is what separates a
      // route from the land it crosses; in 3D mode the dark ground already does that, so it hides.
      const casing = ribbonGeometry(
        points,
        Math.max(road.width, MAP_ROAD.minFill) + MAP_ROAD.casingPad * 2,
        DASH_PATTERNS[road.pattern],
        offset,
      )
      if (casing) {
        const shadow = new THREE.Mesh(track(casing), casingMaterial)
        shadow.position.y = mesh.position.y - 0.008
        roadCasingGroup.add(shadow)
      }

      if (!to) {
        const marker = new THREE.Mesh(track(new THREE.ConeGeometry(3.4, 9, 4)), roadMaterial(road.color, false, GROUND_RANK.road))
        const exit = centreline[centreline.length - 1]
        marker.position.set(exit.x, 4.5, exit.z)
        marker.userData.routeId = road.routeId
        roadGroup.add(marker)
        roadPickable.push(marker)
      }
    }
    applyRoadHighlight()
  }

  /**
   * Traces the selected road in white and drops a pin on each endpoint, so a road that is named in
   * the HUD can be found on the map and its two endpoints identified without guessing.
   */
  function applyRoadHighlight() {
    clearGroup(roadHighlightGroup)
    if (!plan) return
    const entry = selectedRoadId === null ? undefined : roadPaths.get(selectedRoadId)
    if (!entry) return

    const trace = ribbonGeometry(entry.polyline, entry.road.width + 3.4, null)
    if (trace) {
      const halo = new THREE.Mesh(track(trace), materials.roadHighlight)
      halo.position.y = 0.05
      halo.renderOrder = 2
      roadHighlightGroup.add(halo)
    }

    const ends = [entry.polyline[0], entry.polyline[entry.polyline.length - 1]]
    ends.forEach((end, index) => {
      const offMap = entry.endsOffMap && index === 1
      const pin = new THREE.Mesh(
        track(new THREE.ConeGeometry(3.1, 11, 4)),
        offMap ? materials.roadPinOffMap : materials.roadPin,
      )
      pin.position.set(end.x, 12.5, end.z)
      pin.rotation.x = Math.PI
      roadHighlightGroup.add(pin)
    })
  }

  function buildInfrastructure(facilities: readonly Facility[]) {
    clearGroup(infrastructureGroup)
    clearGroup(facilityLabelGroup)
    clearGroup(poiGroup)
    if (!plan) return

    for (const facility of facilities) {
      const site = facilitySites.get(facility.kind)
      if (!site) continue

      // Flattened to a plate in map mode, a facility needs a marker to stay findable. The pin is
      // pure wayfinding: it says "a facility is here", never how loaded it is.
      addPoiPin(
        site.x,
        site.z,
        facility.known ? MAP_PALETTE.pinFacility : 0x8a8f94,
        MAP_PIN.facilityRadius,
        MAP_PIN.facilityHeight,
      )

      // Facilities are scattered across the grid now, so there is no civic rectangle to tint. Each
      // one carries its own pad instead, which keeps it legible as a place of its own rather than
      // part of whichever schema's neighbourhood happens to surround it.
      addQuad(
        infrastructureGroup,
        site.radius * 2,
        site.radius * 2,
        site.x,
        site.z,
        -0.5,
        materials.civicPad,
      )

      addFacilityLabel(facility, site)
      const group = new THREE.Group()
      group.position.set(site.x, 0, site.z)

      // The architecture is always drawn, so a facility's location stays learnable even with no
      // evidence. It is fixed decoration and never varies with a measurement.
      group.add(buildFacilityArchitecture(facility.kind, site.radius, facility.known))

      if (!facility.known) {
        infrastructureGroup.add(group)
        continue
      }

      const units = facility.units.slice(0, 24)
      const slots = facilitySlots(facility.kind, site.radius, units.length)
      units.forEach((unit, index) => {
        const slot = slots[index]
        if (!slot) return
        // Only the height is measured: minHeight at fill 0, maxHeight at fill 1. An unmeasured unit
        // stays at minHeight in the wireframe material and claims no quantity.
        const height = unit.fill === null
          ? slot.minHeight
          : slot.minHeight + (slot.maxHeight - slot.minHeight) * unit.fill
        const material = unit.fill === null
          ? materials.facilityUnknown
          : unit.alert
            ? materials.facilityAlert
            : materials.facilityFill
        const geometry = slot.form === 'cylinder'
          ? new THREE.CylinderGeometry(slot.radius, slot.radius, height, 14)
          : new THREE.BoxGeometry(slot.width, height, slot.depth)
        const mesh = new THREE.Mesh(track(geometry), material)
        // A panel hangs from its lintel; a column and a cylinder grow from their base.
        mesh.position.set(
          slot.x,
          slot.form === 'panel' ? slot.y + slot.maxHeight - height / 2 : slot.y + height / 2,
          slot.z,
        )
        group.add(mesh)
      })
      infrastructureGroup.add(group)
    }
  }

  const KIT_MATERIALS: Record<AssetRole, THREE.Material> = {
    body: materials.kitBody,
    trim: materials.kitTrim,
    glass: materials.kitGlass,
    metal: materials.kitMetal,
    trunk: materials.kitTrunk,
    leaf: materials.kitLeaf,
    water: materials.kitWater,
  }

  /**
   * Draws a facility's building.
   *
   * Prefers the authored landmark from `landmarks.glb`, which is modelled to a plot radius of 1 and
   * therefore scaled rather than rebuilt. Falls back to the procedural shell when the kit has not
   * arrived — or never arrives. Either way the architecture is decoration: it is identical for a
   * facility carrying a terabyte of evidence and one carrying none, and only the units inside it move.
   * An unmeasured facility is drawn in the wireframe material for exactly that reason.
   */
  function buildFacilityArchitecture(kind: FacilityKind, radius: number, known: boolean): THREE.Group {
    const group = new THREE.Group()
    const kit = assets?.landmarks
    const asset = LANDMARK_ASSETS[kind]
    if (kit && kit.has(asset)) {
      group.scale.setScalar(radius)
      for (const role of kit.roles(asset)) {
        const geometry = kit.geometry(asset, role)
        if (!geometry) continue
        // Kit geometry is shared across every rebuild, so it is deliberately not tracked for disposal.
        const mesh = new THREE.Mesh(geometry, known ? KIT_MATERIALS[role] : materials.facilityUnknown)
        // Landmarks always cast: there are six of them, and they are what you navigate by.
        mesh.castShadow = true
        mesh.receiveShadow = true
        group.add(mesh)
      }
      return group
    }

    const shell = facilityShell(kind, radius)
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material) => {
      const mesh = new THREE.Mesh(track(geometry), material)
      mesh.castShadow = true
      mesh.receiveShadow = true
      group.add(mesh)
    }
    add(shell.body, known ? materials.facility : materials.facilityUnknown)
    if (shell.trim) add(shell.trim, known ? materials.trim : materials.facilityUnknown)
    if (shell.glass) add(shell.glass, known ? materials.window : materials.facilityUnknown)
    return group
  }

  /** Names a facility on the pavement at the front of its plot, matching how buildings are labelled. */
  function addFacilityLabel(facility: Facility, site: FacilitySite) {
    const sprite = labelFactory.make(elideMiddle(facility.label, LABEL_MAX_CHARS))
    if (!sprite) return
    sprite.position.set(site.x, LABEL_WORLD_HEIGHT / 2 + 0.7, site.z + site.radius + 3)
    facilityLabelGroup.add(sprite)
  }

  function buildRoute(route: CityRoute | null) {
    clearGroup(routeGroup)
    if (!route || route.polyline.length < 2) return
    const ribbon = ribbonGeometry(route.polyline, 4.6, null)
    if (ribbon) {
      const mesh = new THREE.Mesh(track(ribbon), materials.route)
      mesh.position.y = 1.5
      routeGroup.add(mesh)
    }
    for (const stop of route.stops) {
      if (stop.x === null || stop.z === null) continue
      const marker = new THREE.Mesh(track(new THREE.ConeGeometry(2.5, 9, 8)), materials.routePin)
      marker.position.set(stop.x, 7, stop.z)
      marker.rotation.x = Math.PI
      routeGroup.add(marker)
    }
  }

  function applySelection() {
    clearGroup(selectionGroup)
    if (!plan || selectedId === null) return
    const lot = plan.lots.get(selectedId)
    if (!lot) return
    const size = (lot.footprint ?? 11) * 1.6
    addQuad(selectionGroup, size, size, lot.x, lot.z, 0.2, materials.selection)
    // A map pin hovering just above the roof, rather than a beam to the sky: it marks the building
    // without adding a spike that could be mistaken for geometry.
    const roof = (lot.height ?? 0) + 6
    const pin = new THREE.Mesh(track(new THREE.ConeGeometry(size * 0.16, size * 0.34, 4)), materials.selectionPin)
    pin.rotation.x = Math.PI
    pin.position.set(lot.x, roof + size * 0.17, lot.z)
    selectionGroup.add(pin)
    const knob = new THREE.Mesh(track(new THREE.SphereGeometry(size * 0.13, 10, 8)), materials.selectionPin)
    knob.position.set(lot.x, roof + size * 0.4, lot.z)
    selectionGroup.add(knob)
  }

  /**
   * Camera distance that fits `box` across the viewport at the field of view currently in effect.
   *
   * Framing and the zoom clamps both read from this, so "as far out as you can go" is always
   * expressed in the same units as "framed". That matters because the two view modes look through
   * very different lenses: the flat basemap fakes a parallel projection with a 13° field of view,
   * which needs roughly 3.7x the distance of the 46° oblique lens to cover the same ground.
   */
  function fitDistance(box: THREE.Box3): number {
    const aspect = Math.max(canvas.clientWidth, 1) / Math.max(canvas.clientHeight, 1)
    const vFov = THREE.MathUtils.degToRad(camera.fov)
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect)
    const size = box.getSize(new THREE.Vector3())
    // Distance that fits `span` in the smaller of the two view angles, plus a margin for the
    // oblique view and the floating HUD panels along the edges.
    const span = Math.max(size.x, size.z, 90)
    return Math.max(
      span / (2 * Math.tan(hFov / 2)),
      span / (2 * Math.tan(vFov / 2)),
      size.y / (2 * Math.tan(vFov / 2)),
    ) * 1.16
  }

  /*
   * Zoom limits, derived rather than fixed.
   *
   * These used to be two constants — 24 and 4000 world units — and both ends were wrong for the
   * same reason: a distance means nothing on its own, only a distance *through a given lens* does.
   * Switching to map mode multiplies the orbit distance by the ratio of the two fields of view to
   * hold the apparent size steady, so a city framed at 2,400 units obliquely needs ~8,800 flat. A
   * 4,000-unit ceiling clamped that on arrival: the map snapped to roughly twice the intended
   * magnification and then refused to zoom back out, because it was already sitting on the stop.
   * The same fixed ceiling also meant a large database could never be framed at all.
   *
   * So both ends are expressed as things you can see instead. The far stop is a whole-city framing
   * plus headroom; the near stop is the distance at which about one lot fills the view. Both are
   * recomputed whenever the city, the lens or the viewport changes.
   */
  function applyZoomRange() {
    const box = cityBox()
    if (box.isEmpty()) return
    const out = fitDistance(box) * ZOOM_OUT_HEADROOM
    const span = plan ? Math.max(plan.cell, MIN_VISIBLE_SPAN) : MIN_VISIBLE_SPAN
    const near = span / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2))
    // A city smaller than one lot is not a thing, but guard the ordering anyway: OrbitControls
    // behaves badly if the near stop ever crosses the far one.
    controls.minDistance = Math.min(near, out)
    controls.maxDistance = out
  }

  function frame(box: THREE.Box3) {
    if (box.isEmpty()) return
    // Sync the aspect first: frame() can run before the first draw(), and framing against a stale
    // aspect is what crops the city off the bottom of the viewport.
    const width = Math.max(canvas.clientWidth, 1)
    const height = Math.max(canvas.clientHeight, 1)
    camera.aspect = width / height
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const distance = fitDistance(box)
    // The clamps are what the framing has to live inside, so widen them to the new lens and city
    // before placing the camera — otherwise controls.update() below drags it straight back in.
    applyZoomRange()
    controls.target.set(center.x, size.y * 0.12, center.z)
    // Framing has to respect the mode: dropping the camera to an oblique angle while the controls are
    // locked flat would snap back on the next update and reset your heading on the way.
    const flat = viewMode === 'map'
    const polar = flat ? 0.0005 : DEFAULT_POLAR
    const azimuth = flat ? 0 : cityAzimuth
    const direction = new THREE.Vector3(
      Math.sin(polar) * Math.sin(azimuth),
      Math.cos(polar),
      Math.sin(polar) * Math.cos(azimuth))
    camera.position.copy(controls.target).addScaledVector(direction, distance)
    setDepthRange(distance)
    controls.update()
    // Framing moves the camera only. Callers that also rebuilt the scene ask for their own frame.
    requestCameraRender()
  }

  const cityBox = () => {
    if (!plan) return new THREE.Box3()
    const pad = ARTERIAL_WIDTH
    return new THREE.Box3(
      new THREE.Vector3(plan.bounds.minX - pad, 0, plan.bounds.minZ - pad),
      new THREE.Vector3(plan.bounds.maxX + pad, 70, plan.bounds.maxZ + pad),
    )
  }

  const setPointer = (event: PointerEvent) => {
    const bounds = canvas.getBoundingClientRect()
    pointer.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    )
    raycaster.setFromCamera(pointer, camera)
  }

  const pickRoadAt = (event: PointerEvent): string | null => {
    if (!layers.traffic || roadPickable.length === 0) return null
    setPointer(event)
    const hit = raycaster.intersectObjects(roadPickable, false)[0]
    const routeId = hit?.object.userData.routeId
    return typeof routeId === 'string' ? routeId : null
  }

  const select = (event: PointerEvent) => {
    setPointer(event)
    // Incident pins sit on top of everything and are checked first: a pin exists to be clicked, and
    // it always marks a building that a plain click would select anyway.
    const pin = raycaster.intersectObjects(incidentPickable, false)[0]
    const incidentId = pin?.object.userData.incidentId
    if (typeof incidentId === 'string') {
      options.onSelectIncident?.(incidentId)
      return
    }
    const hit = raycaster.intersectObjects(pickable, false)[0]
    const objectId = hit?.object.userData.objectId
    if (typeof objectId === 'string') {
      options.onSelectIncident?.(null)
      options.onSelect(objectId)
      return
    }
    options.onSelectIncident?.(null)
    // Only a click that missed every building can be a road click, so a road drawn under an
    // overhanging building never steals the building's selection.
    options.onSelectRoad?.(pickRoadAt(event))
  }

  // A pointer-up that follows an orbit drag must not also select a building.
  let pointerDownAt: { x: number; y: number; button: number } | null = null
  const rememberPointer = (event: PointerEvent) => {
    pointerDownAt = { x: event.clientX, y: event.clientY, button: event.button }
  }
  const maybeSelect = (event: PointerEvent) => {
    // Cleared for every button, so a right-drag to pan cannot leave the gesture latched open.
    const down = pointerDownAt
    pointerDownAt = null
    if (down === null || down.button !== 0 || event.button !== 0) return
    const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y)
    if (moved < 5) select(event)
  }
  const cancelPointer = () => {
    pointerDownAt = null
  }

  // Hover is sampled at most once per frame; raycasting on every pointermove is wasteful.
  let hoverEvent: PointerEvent | null = null
  let hoverHandle = 0
  const sampleHover = () => {
    hoverHandle = 0
    if (disposed || hoverEvent === null) return
    const routeId = pickRoadAt(hoverEvent)
    hoverEvent = null
    if (routeId === hoveredRoadId) return
    hoveredRoadId = routeId
    canvas.style.cursor = routeId === null ? '' : 'pointer'
    options.onHoverRoad?.(routeId)
  }
  const trackHover = (event: PointerEvent) => {
    if (!options.onHoverRoad || pointerDownAt !== null) return
    hoverEvent = event
    if (hoverHandle === 0) hoverHandle = requestAnimationFrame(sampleHover)
  }
  const clearHover = () => {
    hoverEvent = null
    if (hoveredRoadId === null) return
    hoveredRoadId = null
    canvas.style.cursor = ''
    options.onHoverRoad?.(null)
  }

  canvas.addEventListener('pointerdown', rememberPointer)
  canvas.addEventListener('pointerup', maybeSelect)
  canvas.addEventListener('pointercancel', cancelPointer)
  canvas.addEventListener('pointermove', trackHover)
  canvas.addEventListener('pointerleave', clearHover)
  // A narrower viewport needs more distance to hold the same city, so the far stop moves with it.
  const resize = new ResizeObserver(() => {
    applyZoomRange()
    // The shadow map is drawn from the sun into its own 2048² target, so the canvas resizing
    // cannot change a texel of it.
    requestCameraRender()
  })
  resize.observe(canvas)
  /*
   * Arm the current hour before the first frame.
   *
   * The lights, the fog and the window emissives are all constructed at evening values, because
   * evening is what the constants above have always said. This is the call that moves them to
   * whatever hour the viewer is actually in — without it the city renders one frame of dusk at
   * nine in the morning.
   */
  applyAtmosphere()
  draw()

  /*
   * Follow the clock while the tab stays open.
   *
   * A phase change is lights, fog and a dome re-bake — never a rebuild — so it is safe to do
   * underneath a city that is already on screen.
   */
  const stopWatchingClock = watchTimeOfDay(phase => {
    if (disposed || phase === timeOfDay) return
    timeOfDay = phase
    applyAtmosphere()
    requestRender()
  })

  /*
   * Fetch the authored kits in the background.
   *
   * The city draws immediately with procedural shells, and swaps in the landmarks and scenery when
   * they arrive — usually within the same second, since they are ~290 KiB and requested alongside the
   * three.js chunk. Nothing waits on them: a kit that never loads costs the map some decoration, and
   * every measurement is drawn either way.
   */
  void loadCityAssets().then(loaded => {
    if (disposed || !loaded) return
    assets = loaded
    if (plan) {
      buildGround(plan)
      buildInfrastructure(currentFacilities)
      requestRender()
    }
  })

  /*
   * The vehicle kit is fetched on its own promise, and that separation is the whole point.
   *
   * `loadCityAssets` resolves a single `Promise.all` over the landmark and scenery kits, so any one
   * of them rejecting resolves the lot to null. Scenery is decoration — losing it costs the map some
   * trees. Vehicles are a measurement of what is running right now, and a failure to fetch a bush
   * must not be able to delete it. Keeping this on its own promise means the two failure modes stay
   * independent in the direction that matters.
   */
  void loadVehicleAssets().then(loaded => {
    if (disposed || !loaded) return
    vehicleKit = loaded
    // Rebuild rather than return early on an empty roster: an empty roster is exactly the state the
    // procedural fallback was drawn in, and it must be replaced when the shells arrive.
    buildVehicles()
    requestRender()
  })

  return {
    setObjects(objects, cityPlan) {
      currentObjects = objects
      plan = cityPlan
      facilitySites = plan.facilities
      buildGround(plan)
      buildDistricts(plan)
      buildNeighborhoodLabels(plan)
      buildBuildings(objects, plan)
      buildRoads(currentRoads, plan)
      if (currentTraffic) buildTraffic(currentTraffic)
      buildInfrastructure(currentFacilities)
      buildRoute(currentRoute)
      buildIncidents(currentIncidents)
      applySelection()
      // A re-plan can resize the city, and the zoom stops are measured against its bounds. Refresh
      // them on every update, not just the first, so a city that grows stays reachable.
      applyZoomRange()
      // Fit-to-bounds runs once. Re-framing on every update would yank the viewpoint on each live
      // tick. It is not latched until the canvas has a real size, so the first frame is never
      // computed against a zero-height layout.
      if (!framedOnce && objects.length > 0 && canvas.clientHeight > 0) {
        framedOnce = true
        frame(cityBox())
      }
      requestRender()
    },
    setRoads(roads) {
      currentRoads = roads
      if (plan) buildRoads(roads, plan)
      // Vehicles drive the roads as drawn, so a re-graded network re-homes the traffic on it.
      refreshVehicles()
      requestRender()
    },
    setTraffic(traffic) {
      currentTraffic = traffic
      buildTraffic(traffic)
      requestRender()
    },
    setFacilities(facilities) {
      currentFacilities = facilities
      buildInfrastructure(facilities)
      requestRender()
    },
    setRoute(route) {
      currentRoute = route
      buildRoute(route)
      requestRender()
    },
    setSelected(objectId) {
      selectedId = objectId
      applySelection()
      requestRender()
    },
    setSelectedRoad(routeId) {
      selectedRoadId = routeId
      applyRoadHighlight()
      requestRender()
    },
    setStaleStatsObjects(objectIds) {
      // Rebuilding every building is the expensive part, so an unchanged set returns before it.
      // Compared by content rather than identity: the projection allocates a fresh array each
      // render, so an identity check would rebuild the whole city on every unrelated state change.
      if (staleStatsObjectIds.size === objectIds.length &&
          objectIds.every(objectId => staleStatsObjectIds.has(objectId))) {
        return
      }
      staleStatsObjectIds = new Set(objectIds)
      if (plan) buildBuildings(currentObjects, plan)
      requestRender()
    },
    setLayers(next) {
      Object.assign(layers, next)
      applyLayers()
      if (!layers.traffic) clearHover()
      requestRender()
    },
    setViewMode(mode) {
      if (mode === viewMode) return
      viewMode = mode
      applyViewMode()
      requestRender()
    },
    setIncidents(markers) {
      currentIncidents = markers
      buildIncidents(markers)
      // The pins just moved, and a blocked vehicle stops at its pin. Rebuilding the roster here is
      // what keeps the two the same measurement rather than two that happen to agree.
      refreshVehicles()
      requestRender()
    },
    setVehicles(events, families) {
      currentEvents = events
      currentFamilies = families
      refreshVehicles()
      requestRender()
    },
    incidentPlacement(id) {
      return incidentPlacements.get(id) ?? null
    },
    incidentScreenPosition(id) {
      const anchor = incidentAnchors.get(id)
      if (!anchor) return null
      const projected = anchor.clone().project(camera)
      if (projected.z > 1) return null
      return {
        x: (projected.x * 0.5 + 0.5) * canvas.clientWidth,
        y: (-projected.y * 0.5 + 0.5) * canvas.clientHeight,
      }
    },
    resetView() {
      frame(cityBox())
    },
    frameRoute() {
      if (!currentRoute || currentRoute.polyline.length === 0) return
      const box = new THREE.Box3()
      for (const point of currentRoute.polyline) {
        box.expandByPoint(new THREE.Vector3(point.x - 24, 0, point.z - 24))
        box.expandByPoint(new THREE.Vector3(point.x + 24, 55, point.z + 24))
      }
      frame(box)
    },
    frameRoad(routeId) {
      const entry = roadPaths.get(routeId)
      if (!entry || entry.polyline.length === 0) return
      const box = new THREE.Box3()
      for (const point of entry.polyline) {
        box.expandByPoint(new THREE.Vector3(point.x - 26, 0, point.z - 26))
        box.expandByPoint(new THREE.Vector3(point.x + 26, 55, point.z + 26))
      }
      frame(box)
    },
    focusObject(objectId) {
      const lot = plan?.lots.get(objectId)
      if (!lot) return
      const offset = camera.position.clone().sub(controls.target)
      controls.target.set(lot.x, 0, lot.z)
      camera.position.copy(controls.target).add(offset)
      controls.update()
      requestCameraRender()
    },
    nudge(action) {
      const forward = new THREE.Vector3()
      camera.getWorldDirection(forward)
      forward.y = 0
      forward.normalize()
      const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize()
      const step = Math.max(8, camera.position.distanceTo(controls.target) * 0.09)
      const move = new THREE.Vector3()
      switch (action) {
        case 'panLeft':
          move.copy(right).multiplyScalar(-step)
          break
        case 'panRight':
          move.copy(right).multiplyScalar(step)
          break
        case 'panUp':
          move.copy(forward).multiplyScalar(step)
          break
        case 'panDown':
          move.copy(forward).multiplyScalar(-step)
          break
        case 'zoomIn':
        case 'zoomOut': {
          const offset = camera.position.clone().sub(controls.target)
          const length = THREE.MathUtils.clamp(
            offset.length() * (action === 'zoomIn' ? 0.82 : 1.22),
            controls.minDistance,
            controls.maxDistance,
          )
          camera.position.copy(controls.target).add(offset.setLength(length))
          controls.update()
          requestCameraRender()
          return
        }
        case 'rotateLeft':
        case 'rotateRight': {
          const offset = camera.position.clone().sub(controls.target)
          offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), (action === 'rotateLeft' ? 1 : -1) * (Math.PI / 12))
          camera.position.copy(controls.target).add(offset)
          controls.update()
          requestCameraRender()
          return
        }
      }
      camera.position.add(move)
      controls.target.add(move)
      controls.update()
      // Every arm of `nudge` moves the camera and nothing else.
      requestCameraRender()
    },
    heading() {
      const forward = new THREE.Vector3()
      camera.getWorldDirection(forward)
      return (THREE.MathUtils.radToDeg(Math.atan2(forward.x, -forward.z)) + 360) % 360
    },
    getPlan: () => plan,
    dispose() {
      disposed = true
      if (animationHandle !== 0) cancelAnimationFrame(animationHandle)
      if (vehicleHandle !== 0) cancelAnimationFrame(vehicleHandle)
      if (hoverHandle !== 0) cancelAnimationFrame(hoverHandle)
      resize.disconnect()
      stopWatchingClock()
      canvas.removeEventListener('pointerdown', rememberPointer)
      canvas.removeEventListener('pointerup', maybeSelect)
      canvas.removeEventListener('pointercancel', cancelPointer)
      canvas.removeEventListener('pointermove', trackHover)
      canvas.removeEventListener('pointerleave', clearHover)
      controls.dispose()
      for (const geometry of disposables) geometry.dispose()
      disposables.clear()
      trailMaterial.dispose()
      for (const material of Object.values(materials)) material.dispose()
      for (const material of archetypeMaterials.values()) material.dispose()
      for (const material of roadMaterials.values()) material.dispose()
      for (const material of poiMaterials.values()) material.dispose()
      for (const material of incidentPinMaterials.values()) {
        material?.map?.dispose()
        material?.dispose()
      }
      riverMaterials.water.dispose()
      riverMaterials.bank.dispose()
      casingMaterial.dispose()
      labelFactory.dispose()
      renderer.dispose()
    },
  }
}


/** Where a cross-database reference leaves the map: straight out through the nearest city edge. */
function rampPoint(plan: CityPlan, from: CityLot): { x: number; z: number } {
  const { bounds } = plan
  const ramp = ARTERIAL_WIDTH * 1.5
  const candidates = [
    { key: 'minX', distance: from.x - bounds.minX },
    { key: 'maxX', distance: bounds.maxX - from.x },
    { key: 'minZ', distance: from.z - bounds.minZ },
    { key: 'maxZ', distance: bounds.maxZ - from.z },
  ].sort((left, right) => left.distance - right.distance || left.key.localeCompare(right.key))
  switch (candidates[0].key) {
    case 'minX':
      return { x: bounds.minX - ramp, z: from.accessZ }
    case 'maxX':
      return { x: bounds.maxX + ramp, z: from.accessZ }
    case 'minZ':
      return { x: from.accessX, z: bounds.minZ - ramp }
    default:
      return { x: from.accessX, z: bounds.maxZ + ramp }
  }
}
