import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { directActivityWidth } from './databaseCity'
import type { DatabaseCityObject } from './databaseCityContracts'
import { ARTERIAL_WIDTH, planCity, streetPolyline, type CityLot, type CityPlan } from './cityPlan'
import { ARCHETYPE_COLORS, buildBuildingGeometry } from './cityBuildings'
import { type RoadTraffic } from './cityTraffic'
import {
  claimLane,
  corridorKeys,
  dashSpans,
  DASH_PATTERNS,
  laneOffset,
  offsetPolyline,
  type DashPattern,
} from './cityRoads'
import { layoutFacilities, type Facility, type FacilityKind, type FacilitySite } from './cityInfrastructure'
import type { FacilityLane } from './cityFacilityTraffic'
import { facilityShell, facilitySlots } from './cityFacilityShells'
import {
  buildingLabelText,
  createCityLabels,
  elideMiddle,
  labelAnchor,
  LABEL_MAX_CHARS,
  LABEL_WORLD_HEIGHT,
} from './cityLabels'
import type { CityRoute } from './cityRoute'

export type CityLayerToggles = {
  traffic: boolean
  waitLanes: boolean
  infrastructure: boolean
  route: boolean
  /** Schema neighborhood tints. Off by default: the tint crowds the map and names nothing on its own. */
  districts: boolean
  /** Ground labels naming each building and facility. */
  labels: boolean
}

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
  setObjects(objects: readonly DatabaseCityObject[]): void
  /** Roads are graded outside the scene so the map and the HUD read the same numbers. */
  setRoads(roads: readonly RoadTraffic[]): void
  setFacilities(facilities: readonly Facility[]): void
  /** Measured wait lanes from buildings to the facility their workload queued at. */
  setFacilityLanes(lanes: readonly FacilityLane[]): void
  setRoute(route: CityRoute | null): void
  setSelected(objectId: string | null): void
  /** Highlights one road and pins both of its endpoints. */
  setSelectedRoad(routeId: string | null): void
  setLayers(layers: Partial<CityLayerToggles>): void
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
}

export function createDatabaseCityScene(
  canvas: HTMLCanvasElement,
  options: SceneOptions,
): DatabaseCitySceneController {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const reducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x070b11)
  const camera = new THREE.PerspectiveCamera(46, 1, 1, 8000)
  camera.position.set(240, 260, 340)

  const controls = new OrbitControls(camera, canvas)
  controls.enableDamping = !reducedMotion
  controls.dampingFactor = 0.08
  controls.screenSpacePanning = false
  controls.minDistance = 24
  controls.maxDistance = 4000
  // Never let the camera drop below the horizon: a city viewed from underground is disorienting.
  controls.maxPolarAngle = Math.PI / 2 - 0.05
  controls.minPolarAngle = 0.05
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }

  scene.add(new THREE.HemisphereLight(0x9fc6e8, 0x0a1018, 1.4))
  const key = new THREE.DirectionalLight(0xfff2dd, 2)
  key.position.set(320, 480, 220)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0x6f9ecb, 0.65)
  fill.position.set(-240, 180, -180)
  scene.add(fill)

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
    ground: new THREE.MeshStandardMaterial({ color: 0x11181f, roughness: 0.98 }),
    asphalt: new THREE.MeshStandardMaterial({ color: 0x252c37, roughness: 0.95 }),
    laneMark: new THREE.MeshStandardMaterial({ color: 0x5f6b7a, roughness: 0.85 }),
    sidewalk: new THREE.MeshStandardMaterial({ color: 0x38414d, roughness: 0.9 }),
    district: new THREE.MeshBasicMaterial({ color: 0x2b4a63, transparent: true, opacity: 0.15 }),
    facility: new THREE.MeshStandardMaterial({ color: 0x53707f, roughness: 0.62 }),
    facilityUnknown: new THREE.MeshBasicMaterial({ color: 0x7d8b96, wireframe: true }),
    facilityFill: new THREE.MeshStandardMaterial({ color: 0x63d8ff, emissive: 0x11455c, roughness: 0.35 }),
    facilityAlert: new THREE.MeshStandardMaterial({ color: 0xe4483c, emissive: 0x4a0f0a, roughness: 0.4 }),
    route: new THREE.MeshBasicMaterial({ color: 0x2fe0ff, transparent: true, opacity: 0.92 }),
    routePin: new THREE.MeshStandardMaterial({ color: 0x2fe0ff, emissive: 0x0d5f70, roughness: 0.3 }),
    roadHighlight: new THREE.MeshBasicMaterial({ color: 0xf4f9ff, transparent: true, opacity: 0.5 }),
    roadPin: new THREE.MeshStandardMaterial({ color: 0xf4f9ff, emissive: 0x5d7183, roughness: 0.3 }),
    roadPinOffMap: new THREE.MeshStandardMaterial({ color: 0xb0bcc7, emissive: 0x39434d, roughness: 0.45 }),
    selection: new THREE.MeshBasicMaterial({ color: 0xffd479, transparent: true, opacity: 0.26 }),
    selectionPin: new THREE.MeshStandardMaterial({ color: 0xffd479, emissive: 0x6b4a06, roughness: 0.35 }),
  }
  const archetypeMaterials = new Map<number, THREE.MeshStandardMaterial>()
  const bodyMaterial = (color: number) => {
    let material = archetypeMaterials.get(color)
    if (!material) {
      material = new THREE.MeshStandardMaterial({ color, roughness: 0.78, metalness: 0.06 })
      archetypeMaterials.set(color, material)
    }
    return material
  }
  const roadMaterials = new Map<number, THREE.MeshBasicMaterial>()
  const roadMaterial = (color: number, faded: boolean) => {
    const cacheKey = color * 2 + (faded ? 1 : 0)
    let material = roadMaterials.get(cacheKey)
    if (!material) {
      material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: faded ? 0.6 : 0.92 })
      roadMaterials.set(cacheKey, material)
    }
    return material
  }

  // One group per layer keeps toggling a layer O(1) and avoids rebuilding the scene graph.
  const groundGroup = new THREE.Group()
  const districtGroup = new THREE.Group()
  const buildingGroup = new THREE.Group()
  const roadGroup = new THREE.Group()
  const laneGroup = new THREE.Group()
  const roadHighlightGroup = new THREE.Group()
  const infrastructureGroup = new THREE.Group()
  const routeGroup = new THREE.Group()
  const selectionGroup = new THREE.Group()
  // Labels are their own layer, but facility labels nest so they disappear with the facilities they
  // name rather than hovering over an empty civic district.
  const labelGroup = new THREE.Group()
  const buildingLabelGroup = new THREE.Group()
  const facilityLabelGroup = new THREE.Group()
  labelGroup.add(buildingLabelGroup, facilityLabelGroup)
  const labelFactory = createCityLabels()
  scene.add(
    groundGroup,
    districtGroup,
    roadGroup,
    roadHighlightGroup,
    laneGroup,
    buildingGroup,
    infrastructureGroup,
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
  let facilitySites = new Map<FacilityKind, FacilitySite>()
  let currentRoads: readonly RoadTraffic[] = []
  let currentRoute: CityRoute | null = null
  let currentFacilities: readonly Facility[] = []
  let currentLanes: readonly FacilityLane[] = []
  let selectedId: string | null = null
  let selectedRoadId: string | null = null
  let hoveredRoadId: string | null = null
  let framedOnce = false
  let disposed = false
  let animationHandle = 0
  let renderRequested = false
  const layers: CityLayerToggles = {
    traffic: true,
    waitLanes: true,
    infrastructure: true,
    route: true,
    districts: false,
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
   */
  const applyLayers = () => {
    roadGroup.visible = layers.traffic
    laneGroup.visible = layers.waitLanes
    roadHighlightGroup.visible = layers.traffic
    infrastructureGroup.visible = layers.infrastructure
    routeGroup.visible = layers.route
    districtGroup.visible = layers.districts
    labelGroup.visible = layers.labels
    facilityLabelGroup.visible = layers.infrastructure
  }
  applyLayers()

  const draw = () => {
    const width = Math.max(canvas.clientWidth, 1)
    const height = Math.max(canvas.clientHeight, 1)
    const ratio = renderer.getPixelRatio()
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    renderer.render(scene, camera)
  }

  // Rendering is on demand; a frame loop runs only while damping is still settling the camera.
  const requestRender = () => {
    if (disposed || renderRequested) return
    renderRequested = true
    requestAnimationFrame(() => {
      renderRequested = false
      if (!disposed) draw()
    })
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

  controls.addEventListener('change', () => {
    options.onCameraChange?.()
    if (controls.enableDamping) runDampingLoop()
    else requestRender()
  })

  function buildGround(cityPlan: CityPlan) {
    clearGroup(groundGroup)
    const pad = ARTERIAL_WIDTH * 2
    const ground = new THREE.Mesh(
      track(new THREE.PlaneGeometry(cityPlan.bounds.width + pad * 2, cityPlan.bounds.depth + pad * 2)),
      materials.ground,
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.set(cityPlan.bounds.centerX, -0.6, cityPlan.bounds.centerZ)
    groundGroup.add(ground)

    // Streets are flat quads laid on the street graph, with a sidewalk strip either side.
    for (const street of cityPlan.streets) {
      const from = cityPlan.intersections.get(street.fromId)
      const to = cityPlan.intersections.get(street.toId)
      if (!from || !to) continue
      const alongX = Math.abs(to.x - from.x) > Math.abs(to.z - from.z)
      const length = alongX ? Math.abs(to.x - from.x) : Math.abs(to.z - from.z)
      const cx = (from.x + to.x) / 2
      const cz = (from.z + to.z) / 2
      addQuad(groundGroup, alongX ? length : street.width, alongX ? street.width : length, cx, cz, -0.25, materials.asphalt)
      // Kerbs sit proud of the carriageway, which is what makes the grid read as streets rather
      // than as gaps between plates.
      const offset = street.width / 2 + 1.6
      if (alongX) {
        addQuad(groundGroup, length, 3.2, cx, cz - offset, -0.12, materials.sidewalk)
        addQuad(groundGroup, length, 3.2, cx, cz + offset, -0.12, materials.sidewalk)
        addQuad(groundGroup, length * 0.94, 0.5, cx, cz, -0.2, materials.laneMark)
      } else {
        addQuad(groundGroup, 3.2, length, cx - offset, cz, -0.12, materials.sidewalk)
        addQuad(groundGroup, 3.2, length, cx + offset, cz, -0.12, materials.sidewalk)
        addQuad(groundGroup, 0.5, length * 0.94, cx, cz, -0.2, materials.laneMark)
      }
    }
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
   * Draws one tint per schema neighborhood. The civic district is deliberately not drawn here: this
   * layer is named for schema neighborhoods, and the infrastructure district is drawn with the
   * facilities it holds so the toggle stays literally true.
   */
  function buildDistricts(cityPlan: CityPlan) {
    clearGroup(districtGroup)
    for (const district of cityPlan.districts) {
      addQuad(
        districtGroup,
        district.maxX - district.minX,
        district.maxZ - district.minZ,
        district.centerX,
        district.centerZ,
        -0.5,
        materials.district,
      )
    }
  }

  /** Places a label on the pavement in front of a building, in world space so it never rotates with the lot. */
  function addBuildingLabel(object: DatabaseCityObject, lot: CityLot) {
    const sprite = labelFactory.make(buildingLabelText(object.schemaName, object.name))
    if (!sprite) return
    const anchor = labelAnchor(lot.x, lot.z, lot.accessX, lot.accessZ, (lot.footprint ?? 11) / 2 + 3)
    sprite.position.set(anchor.x, LABEL_WORLD_HEIGHT / 2 + 0.7, anchor.z)
    buildingLabelGroup.add(sprite)
  }

  function buildBuildings(objects: readonly DatabaseCityObject[], cityPlan: CityPlan) {
    clearGroup(buildingGroup)
    clearGroup(buildingLabelGroup)
    pickable.length = 0
    for (const object of objects) {
      const lot = cityPlan.lots.get(object.objectId)
      if (!lot) continue
      addBuildingLabel(object, lot)
      const known = lot.footprint !== null && lot.height !== null
      const group = new THREE.Group()
      group.position.set(lot.x, 0, lot.z)
      group.rotation.y = lot.rotationY
      group.userData.objectId = object.objectId

      const geometry = buildBuildingGeometry(lot)
      const body = new THREE.Mesh(
        track(geometry.body),
        known ? bodyMaterial(ARCHETYPE_COLORS[lot.archetype]) : materials.unknown,
      )
      body.userData.objectId = object.objectId
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

      // Amber roof cap: attributed Query Store CPU.
      if (known && object.attributedExposure.totalCpuMicroseconds !== null) {
        const cpu = Number(BigInt(object.attributedExposure.totalCpuMicroseconds))
        const capHeight = 0.5 + Math.log2(1 + Math.max(0, cpu)) * 0.05
        const cap = new THREE.Mesh(
          track(new THREE.BoxGeometry(footprint * 0.55, capHeight, footprint * 0.55)),
          materials.exposure,
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
   * Draws every graded road. Roads that share a street leg are pushed into their own lane so a
   * busy corridor reads as several distinct routes instead of one stack of overlapping ribbons.
   */
  function buildRoads(roads: readonly RoadTraffic[], cityPlan: CityPlan) {
    clearGroup(roadGroup)
    roadPickable.length = 0
    roadPaths.clear()

    // Widest first, so the heaviest traffic keeps the centre line and the light roads move aside.
    const ordered = [...roads].sort((left, right) => right.width - left.width || left.routeId.localeCompare(right.routeId))
    const corridorLanes = new Map<string, Set<number>>()

    for (const road of ordered) {
      const from = cityPlan.lots.get(road.fromObjectId)
      if (!from) continue
      const to = cityPlan.lots.get(road.toId)
      // A cross-database reference leaves the city on a ramp through the nearest boundary.
      const target = to ? { x: to.accessX, z: to.accessZ } : rampPoint(cityPlan, from)
      const points = streetPolyline(cityPlan, { x: from.accessX, z: from.accessZ }, target)
      const corridors = corridorKeys(points)
      const lane = claimLane(corridorLanes, corridors)
      const offset = laneOffset(lane)
      const centreline = offsetPolyline(points, offset)
      const ribbon = ribbonGeometry(points, road.width, DASH_PATTERNS[road.pattern], offset)
      if (!ribbon) continue
      const mesh = new THREE.Mesh(track(ribbon), roadMaterial(road.color, road.pattern !== 'solid'))
      // Lane order also stacks the ribbons a hair apart so coplanar roads never z-fight.
      mesh.position.y = 0.06 + lane * 0.014
      mesh.userData.routeId = road.routeId
      mesh.renderOrder = 1
      roadGroup.add(mesh)
      roadPickable.push(mesh)
      roadPaths.set(road.routeId, { road, polyline: centreline, endsOffMap: !to })

      if (!to) {
        const marker = new THREE.Mesh(track(new THREE.ConeGeometry(3.4, 9, 4)), roadMaterial(road.color, false))
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

  function buildFacilityLanes(lanes: readonly FacilityLane[]) {
    clearGroup(laneGroup)
    if (!plan) return
    for (const lane of lanes) {
      const from = plan.lots.get(lane.objectId)
      const site = facilitySites.get(lane.facility)
      // A lane whose building or facility is not on this map is dropped from the geometry only; it
      // still appears in the evidence table, so it is never silently lost.
      if (!from || !site) continue
      const points = streetPolyline(
        plan,
        { x: from.accessX, z: from.accessZ },
        { x: site.x, z: site.z },
      )
      const ribbon = ribbonGeometry(points, lane.width, DASH_PATTERNS[lane.pattern])
      if (!ribbon) continue
      const mesh = new THREE.Mesh(track(ribbon), roadMaterial(lane.color, lane.pattern !== 'solid'))
      // Lanes sit above every road lane so a lane and a road sharing a street stay distinguishable.
      mesh.position.y = 0.2
      mesh.userData.laneId = lane.laneId
      laneGroup.add(mesh)
    }
  }

  function buildInfrastructure(facilities: readonly Facility[]) {
    clearGroup(infrastructureGroup)
    clearGroup(facilityLabelGroup)
    if (!plan) return

    // The civic district's tint travels with its facilities rather than with the schema
    // neighborhoods, so switching schema neighborhoods off still leaves the infrastructure
    // district legible as a place.
    addQuad(
      infrastructureGroup,
      plan.civic.maxX - plan.civic.minX,
      plan.civic.maxZ - plan.civic.minZ,
      plan.civic.centerX,
      plan.civic.centerZ,
      -0.5,
      materials.district,
    )

    for (const facility of facilities) {
      const site = facilitySites.get(facility.kind)
      if (!site) continue
      addFacilityLabel(facility, site)
      const group = new THREE.Group()
      group.position.set(site.x, 0, site.z)

      // The architecture is always drawn, so a facility's location stays learnable even with no
      // evidence. It is fixed decoration and never varies with a measurement.
      const shell = facilityShell(facility.kind, site.radius)
      const shellMaterial = facility.known ? materials.facility : materials.facilityUnknown
      group.add(new THREE.Mesh(track(shell.body), shellMaterial))
      if (shell.trim) {
        group.add(new THREE.Mesh(track(shell.trim), facility.known ? materials.trim : materials.facilityUnknown))
      }
      if (shell.glass) {
        group.add(new THREE.Mesh(track(shell.glass), facility.known ? materials.window : materials.facilityUnknown))
      }

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

  function frame(box: THREE.Box3) {
    if (box.isEmpty()) return
    // Sync the aspect first: frame() can run before the first draw(), and framing against a stale
    // aspect is what crops the city off the bottom of the viewport.
    const width = Math.max(canvas.clientWidth, 1)
    const height = Math.max(canvas.clientHeight, 1)
    camera.aspect = width / height
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    // Distance that fits `span` in the smaller of the two view angles, plus a margin for the
    // oblique view and the floating HUD panels along the edges.
    const vFov = THREE.MathUtils.degToRad(camera.fov)
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect)
    const span = Math.max(size.x, size.z, 90)
    const distance = Math.max(
      span / (2 * Math.tan(hFov / 2)),
      span / (2 * Math.tan(vFov / 2)),
      size.y / (2 * Math.tan(vFov / 2)),
    ) * 1.16
    controls.target.set(center.x, size.y * 0.12, center.z)
    const direction = new THREE.Vector3(0.42, 0.66, 0.62).normalize()
    camera.position.copy(controls.target).addScaledVector(direction, distance)
    camera.near = Math.max(0.5, distance / 900)
    camera.far = distance * 30
    camera.updateProjectionMatrix()
    controls.update()
    requestRender()
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
    const hit = raycaster.intersectObjects(pickable, false)[0]
    const objectId = hit?.object.userData.objectId
    if (typeof objectId === 'string') {
      options.onSelect(objectId)
      return
    }
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
  const resize = new ResizeObserver(() => requestRender())
  resize.observe(canvas)
  draw()

  return {
    setObjects(objects) {
      plan = planCity(objects)
      facilitySites = layoutFacilities(plan.civic)
      buildGround(plan)
      buildDistricts(plan)
      buildBuildings(objects, plan)
      buildRoads(currentRoads, plan)
      buildFacilityLanes(currentLanes)
      buildInfrastructure(currentFacilities)
      buildRoute(currentRoute)
      applySelection()
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
      requestRender()
    },
    setFacilities(facilities) {
      currentFacilities = facilities
      buildInfrastructure(facilities)
      requestRender()
    },
    setFacilityLanes(lanes) {
      currentLanes = lanes
      buildFacilityLanes(lanes)
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
    setLayers(next) {
      Object.assign(layers, next)
      applyLayers()
      if (!layers.traffic) clearHover()
      requestRender()
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
      requestRender()
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
          requestRender()
          return
        }
        case 'rotateLeft':
        case 'rotateRight': {
          const offset = camera.position.clone().sub(controls.target)
          offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), (action === 'rotateLeft' ? 1 : -1) * (Math.PI / 12))
          camera.position.copy(controls.target).add(offset)
          controls.update()
          requestRender()
          return
        }
      }
      camera.position.add(move)
      controls.target.add(move)
      controls.update()
      requestRender()
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
      if (hoverHandle !== 0) cancelAnimationFrame(hoverHandle)
      resize.disconnect()
      canvas.removeEventListener('pointerdown', rememberPointer)
      canvas.removeEventListener('pointerup', maybeSelect)
      canvas.removeEventListener('pointercancel', cancelPointer)
      canvas.removeEventListener('pointermove', trackHover)
      canvas.removeEventListener('pointerleave', clearHover)
      controls.dispose()
      for (const geometry of disposables) geometry.dispose()
      disposables.clear()
      for (const material of Object.values(materials)) material.dispose()
      for (const material of archetypeMaterials.values()) material.dispose()
      for (const material of roadMaterials.values()) material.dispose()
      labelFactory.dispose()
      renderer.dispose()
    },
  }
}

/**
 * Extrudes a polyline into a flat ribbon, so roads read as surfaces rather than hairlines.
 * `dash` repeats a fixed-length on/off pattern along the whole polyline, which is how the reduced
 * confidence patterns are expressed without needing a line material.
 */
function ribbonGeometry(
  points: ReadonlyArray<{ x: number; z: number }>,
  width: number,
  dash: DashPattern | null,
  offset = 0,
): THREE.BufferGeometry | null {
  const line = offsetPolyline(points, offset)
  if (line.length < 2) return null
  const positions: number[] = []
  const half = width / 2
  const push = (
    ax: number,
    az: number,
    bx: number,
    bz: number,
    nx: number,
    nz: number,
  ) => {
    positions.push(
      ax + nx, 0, az + nz,
      bx + nx, 0, bz + nz,
      bx - nx, 0, bz - nz,
      ax + nx, 0, az + nz,
      bx - nx, 0, bz - nz,
      ax - nx, 0, az - nz,
    )
  }

  for (const span of dashSpans(line, dash)) {
    const length = Math.hypot(span.bx - span.ax, span.bz - span.az)
    if (length < 1e-6) continue
    const ux = (span.bx - span.ax) / length
    const uz = (span.bz - span.az) / length
    push(span.ax, span.az, span.bx, span.bz, -uz * half, ux * half)
  }

  // Square off the corners of an unbroken road so perpendicular legs join without a notch. A dashed
  // road needs no corner patch: its dashes already carry around the turn.
  if (dash === null) {
    for (let i = 1; i < line.length - 1; i += 1) {
      push(line[i].x - half, line[i].z, line[i].x + half, line[i].z, 0, half)
    }
  }

  if (positions.length === 0) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  return geometry
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
