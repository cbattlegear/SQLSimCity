import * as THREE from 'three'
import { isFreshLive } from './atlas'
import { CityActivation } from './atlasActivation'
import {
  cityGeometrySignature,
  planAtlasCity,
  regionalRoadPath,
  type AtlasCityPlan,
  type AtlasPoint,
} from './atlasCity'
import { buildAtlasCityGeometry, PAD_HEIGHT, type AtlasCityGeometry } from './atlasCityBuildings'
import { fitDistance, MAP_VIEW_DIRECTION, MIN_FRAME_EXTENT, VIEW_DIRECTION } from './atlasFraming'
import { AtlasLayoutReservations, stableHash } from './atlasLayout'
import {
  planAtlasTerrain,
  RIVER_BANK_WIDTH,
  RIVER_WIDTH,
  type AtlasTerrain,
} from './atlasTerrain'
import { createCityLabels, databaseLabelText, labelAnchor, type CityLabels } from './cityLabels'
import type { AtlasSnapshot, DatabaseAtlasItem, EdgeConfidence } from './contracts'
import { polygonPositions, ribbonPositions } from './mapRibbon'
import { LANDUSE_CITY_COLORS, LANDUSE_MAP_COLORS, MAP_PALETTE, type MapViewMode } from './mapStyle'
import {
  ATLAS_ATMOSPHERE,
  resolveTimeOfDay,
  watchTimeOfDay,
  type AtlasAtmosphere,
  type TimeOfDay,
} from './timeOfDay'

/**
 * The server atlas: one small city per database on a shared grid.
 *
 * A database is a city here and a city again when it is entered, so the two surfaces read as two
 * altitudes over one place rather than as two unrelated diagrams. What a city claims is stated in
 * {@link planAtlasCity}: plot side is allocated bytes, the tallest tower is used bytes, and the block
 * grid follows from the plot because block size is a single constant shared by every city. Skyline
 * shape, setbacks, and masts are decoration seeded from the database's stable id.
 *
 * Every city is named on the ground with the vocabulary the database city already uses. Without names
 * an atlas of a hundred cities can only be read by hovering each one in turn, which is not reading a
 * map.
 */

/**
 * Label height in world units for the atlas. Larger than the database city's, because the atlas frames
 * a 1,000-unit grid rather than a few blocks, and a name that cannot be read at the default framing is
 * worth no more than no name at all.
 */
export const ATLAS_LABEL_WORLD_HEIGHT = 11

/** Gap between a city's plot edge and its label plate. */
const LABEL_KERB = 7

/** Painted width of a regional road, and of the casing under it. Confidence is what these encode. */
const HIGHWAY_FILL_WIDTH = 3.4
const HIGHWAY_CASING_WIDTH = 5.4

/**
 * The sky beyond the last town.
 *
 * Both the clear colour and the fog colour in 3D, which is the whole trick: with the two matched, the
 * landscape fades into the sky at the horizon instead of ending at a hard edge with a void behind it.
 * The database city one level down stands under the same hour, and an atlas lit differently from
 * the city it zooms into is two drawings rather than two altitudes over one place. That is why both
 * read their light out of the same `timeOfDay` module.
 */

type AtlasSceneCallbacks = {
  onHover: (databaseId: string | null) => void
  onSelect: (databaseId: string) => void
  onOpen: (databaseId: string) => void
}

type Beacon = { mesh: THREE.Mesh; phase: number }

export class AtlasScene {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(36, 1, 1, 3600)
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()
  private readonly interactive: THREE.Object3D[] = []
  private readonly beacons: Beacon[] = []
  private readonly layout = new AtlasLayoutReservations()
  private readonly activation = new CityActivation()
  private readonly resizeObserver: ResizeObserver
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  private frame: number | null = null
  private hoveredId: string | null = null
  /** Flat basemap or oblique 3D. The atlas rebuilds on switch; it holds only a handful of cities. */
  private viewMode: MapViewMode = 'city'
  private lastSnapshot: AtlasSnapshot | null = null
  private lastSelectedId: string | null = null
  private readonly canvas: HTMLCanvasElement
  private readonly callbacks: AtlasSceneCallbacks
  private readonly labels: CityLabels = createCityLabels(ATLAS_LABEL_WORLD_HEIGHT)
  /**
   * Merged city geometry keyed by everything that can change its shape. The atlas refreshes on a
   * thirty-second timer and a database's size has usually not moved, so rebuilding several thousand
   * boxes every refresh would be pure churn.
   */
  private readonly geometryCache = new Map<string, AtlasCityGeometry>()
  /** Materials carrying the selection highlight for one database. */
  private readonly cityMaterials = new Map<string, THREE.MeshStandardMaterial[]>()
  /** Everything owned by the current snapshot. Cached city geometry is deliberately not in here. */
  private readonly disposables: Array<THREE.BufferGeometry | THREE.Material> = []
  /** Extent of the cities in the current snapshot, including their label plates. */
  private readonly contentBounds = new THREE.Box3()
  private readonly frameCenter = new THREE.Vector3()
  private readonly frameExtents = new THREE.Vector3(MIN_FRAME_EXTENT, MIN_FRAME_EXTENT, MIN_FRAME_EXTENT)
  private readonly nightLights: THREE.Object3D[]
  private readonly hemiLight: THREE.HemisphereLight
  private readonly keyLight: THREE.DirectionalLight
  /** The hour the region is drawn in. Read from the viewer's clock; encodes nothing measured. */
  private timeOfDay: TimeOfDay = resolveTimeOfDay(new Date())
  private readonly stopWatchingClock: () => void
  private readonly ambientLight: THREE.AmbientLight
  /** The fixed regional landscape. Seeded once, never refitted, and never derived from a measurement. */
  private readonly terrainPlan: AtlasTerrain = planAtlasTerrain()
  private terrain: THREE.Group | null = null
  private readonly terrainDisposables: Array<THREE.BufferGeometry | THREE.Material> = []

  constructor(canvas: HTMLCanvasElement, callbacks: AtlasSceneCallbacks) {
    this.canvas = canvas
    this.callbacks = callbacks
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.setClearColor(this.atmosphere.sky, 1)
    this.frameCenter.set(0, 0, 0)

    /*
     * A warm low key light against a cool sky fill is what gives a skyline a lit face and a shaded
     * one; lit flat, a town is a grey mass and the whole point of the 3D view — that you can see the
     * shape of a place — is lost. Which warm and which cool comes from the hour the viewer is in,
     * the same hour the database city one level down is drawn under.
     */
    this.scene.fog = new THREE.Fog(this.atmosphere.sky, 520, 1150)
    this.hemiLight = new THREE.HemisphereLight(
      this.atmosphere.hemiSky,
      this.atmosphere.hemiGround,
      this.atmosphere.hemiIntensity,
    )
    this.scene.add(this.hemiLight)
    this.keyLight = new THREE.DirectionalLight(this.atmosphere.keyColor, this.atmosphere.keyIntensity)
    this.keyLight.position.set(-160, 130, 120)
    this.scene.add(this.keyLight)
    this.nightLights = [this.hemiLight, this.keyLight]
    // Intensity π, not 1: three.js resolves ambient light through the Lambert BRDF, which divides by
    // π, so an intensity of 1 would draw every surface at about a third of its own colour. Cancelling
    // that divide is what makes a lit material render as exactly its base colour in map mode.
    this.ambientLight = new THREE.AmbientLight(0xffffff, Math.PI)
    this.ambientLight.visible = false
    this.scene.add(this.ambientLight)

    this.buildTerrain()

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(canvas)
    canvas.addEventListener('pointermove', this.handlePointerMove)
    canvas.addEventListener('pointerleave', this.handlePointerLeave)
    canvas.addEventListener('click', this.handleClick)
    canvas.addEventListener('dblclick', this.handleDoubleClick)
    this.reducedMotion.addEventListener('change', this.handleMotionPreference)
    this.stopWatchingClock = watchTimeOfDay(phase => {
      if (phase === this.timeOfDay) return
      this.timeOfDay = phase
      this.applyAtmosphere()
    })
    this.resize()
  }

  /** The atlas rig for the hour the viewer is in. */
  private get atmosphere(): AtlasAtmosphere {
    return ATLAS_ATMOSPHERE[this.timeOfDay]
  }

  /**
   * Moves the region to a new hour.
   *
   * Lights and fog only. A snapshot rebuild is what a *view mode* switch costs, because the two
   * modes draw different geometry; two hours draw the same geometry under different light, so
   * rebuilding here would be pure churn on a thirty-second refresh timer.
   *
   * Map mode is skipped outright: a printed sheet has no sky, and `setViewMode` reads the current
   * atmosphere back when the 3D view returns.
   */
  private applyAtmosphere(): void {
    const atmosphere = this.atmosphere
    this.hemiLight.color.setHex(atmosphere.hemiSky)
    this.hemiLight.groundColor.setHex(atmosphere.hemiGround)
    this.hemiLight.intensity = atmosphere.hemiIntensity
    this.keyLight.color.setHex(atmosphere.keyColor)
    this.keyLight.intensity = atmosphere.keyIntensity
    if (this.viewMode === 'map') return
    this.renderer.setClearColor(atmosphere.sky, 1)
    if (this.scene.fog instanceof THREE.Fog) this.scene.fog.color.setHex(atmosphere.sky)
    this.render()
  }

  setSnapshot(snapshot: AtlasSnapshot): void {
    this.lastSnapshot = snapshot
    this.clearAtlasObjects()
    this.contentBounds.makeEmpty()
    const centers = new Map<string, THREE.Vector3>()
    const plans = new Map<string, AtlasCityPlan>()
    const liveSignatures = new Set<string>()

    const layout = this.layout.place(snapshot.databases.map(database => database.databaseId))
    for (const database of snapshot.databases) {
      const position = layout.get(database.databaseId)
      if (!position) continue
      const center = new THREE.Vector3(position.x, 0, position.z)
      centers.set(database.databaseId, center)
      const placed = this.addDatabase(database, center, snapshot.generatedAt)
      plans.set(database.databaseId, placed.plan)
      liveSignatures.add(placed.signature)
    }

    for (const [signature, geometry] of this.geometryCache) {
      if (liveSignatures.has(signature)) continue
      this.geometryCache.delete(signature)
      disposeCityGeometry(geometry)
    }

    for (const edge of snapshot.edges) {
      const from = centers.get(edge.fromDatabaseId)
      const to = centers.get(edge.toDatabaseId)
      if (!from || !to) continue
      this.addEdge(
        from,
        to,
        plans.get(edge.fromDatabaseId),
        plans.get(edge.toDatabaseId),
        edge.confidence,
        `${edge.fromDatabaseId}->${edge.toDatabaseId}`,
      )
    }

    this.frameContent()
    this.render()
    this.syncAnimation()
  }

  setSelected(databaseId: string | null): void {
    this.lastSelectedId = databaseId
    const base = this.viewMode === 'map' ? 0 : 0.08
    const active = this.viewMode === 'map' ? 0.35 : 0.75
    for (const [id, materials] of this.cityMaterials) {
      for (const material of materials) material.emissiveIntensity = id === databaseId ? active : base
    }
    this.render()
  }

  /**
   * Switches the atlas between the flat basemap drawing and the oblique 3D view.
   *
   * The atlas holds one parcel per database, so a rebuild is cheaper and far simpler than a material
   * indirection. Nothing measured changes: parcel size, tint, and label are computed in
   * `planAtlasCity` and are identical in both modes.
   */
  setViewMode(mode: MapViewMode): void {
    if (mode === this.viewMode) return
    this.viewMode = mode
    const flat = mode === 'map'
    this.renderer.setClearColor(flat ? MAP_PALETTE.ground : this.atmosphere.sky, 1)
    for (const light of this.nightLights) light.visible = !flat
    this.ambientLight.visible = flat
    // Fog is what stops the far edge of the landscape reading as a cliff into empty space. The flat
    // drawing is a printed sheet seen straight down, and a printed sheet has no haze.
    this.scene.fog = flat ? null : new THREE.Fog(this.atmosphere.sky, 520, 1150)
    this.buildTerrain()
    if (this.lastSnapshot) this.setSnapshot(this.lastSnapshot)
    else this.placeCamera()
    this.setSelected(this.lastSelectedId)
    this.render()
  }

  /**
   * Draws the regional landscape for the current view mode: ground, water, woodland, and the river.
   *
   * Rebuilt on a mode switch rather than recoloured, for the same reason the cities are: the atlas
   * holds one landscape, a rebuild is a handful of buffers, and a material indirection would be more
   * code to say less. Kept entirely outside the per-snapshot object list, because the ground does not
   * change when a database does.
   */
  private buildTerrain(): void {
    if (this.terrain) {
      this.scene.remove(this.terrain)
      for (const disposable of this.terrainDisposables) disposable.dispose()
      this.terrainDisposables.length = 0
      this.terrain = null
    }

    const flat = this.viewMode === 'map'
    const cover = flat ? LANDUSE_MAP_COLORS : LANDUSE_CITY_COLORS
    const group = new THREE.Group()

    const addFlatMesh = (positions: number[], color: number, opacity = 1): void => {
      if (positions.length === 0) return
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      const material = new THREE.MeshBasicMaterial({
        color,
        transparent: opacity < 1,
        opacity,
        depthWrite: false,
        // Double-sided because the winding of a fan-triangulated blob depends on which way its
        // outline happened to be wound, and a silently back-face-culled landscape is a blank sheet.
        side: THREE.DoubleSide,
      })
      this.terrainDisposables.push(geometry, material)
      group.add(new THREE.Mesh(geometry, material))
    }

    const reach = this.terrainPlan.extent * 1.35
    const ground = new THREE.PlaneGeometry(reach * 2, reach * 2)
    ground.rotateX(-Math.PI / 2)
    ground.translate(0, -0.6, 0)
    const groundMaterial = new THREE.MeshBasicMaterial({
      color: flat ? MAP_PALETTE.ground : 0x5c6a49,
    })
    this.terrainDisposables.push(ground, groundMaterial)
    group.add(new THREE.Mesh(ground, groundMaterial))

    // One buffer per cover class, not one per patch: a hundred blobs is a hundred draw calls
    // otherwise, and the atlas already has cities to spend its budget on.
    const byKind = new Map<string, number[]>()
    const waterRim: number[] = []
    for (const patch of this.terrainPlan.patches) {
      const positions = byKind.get(patch.kind) ?? []
      polygonPositions(patch.points, -0.45, positions)
      byKind.set(patch.kind, positions)
      // A darker rim is what makes a lake read as a lake rather than as a blue smear — the same
      // treatment the river bank gets, and the same one the database city gives its water.
      if (patch.kind === 'water') polygonPositions(expand(patch.points, 1.07), -0.5, waterRim)
    }
    addFlatMesh(waterRim, flat ? MAP_PALETTE.waterEdge : 0x2b6580)
    for (const [kind, positions] of byKind) {
      addFlatMesh(positions, cover[kind as keyof typeof cover] ?? cover.park, flat ? 1 : 0.95)
    }

    addFlatMesh(
      ribbonPositions(this.terrainPlan.river, RIVER_BANK_WIDTH, null, 0, [], -0.3),
      flat ? MAP_PALETTE.waterEdge : 0x2b6580,
    )
    addFlatMesh(
      ribbonPositions(this.terrainPlan.river, RIVER_WIDTH, null, 0, [], -0.15),
      cover.water,
    )

    this.terrain = group
    this.scene.add(group)
  }

  dispose(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.resizeObserver.disconnect()
    this.canvas.removeEventListener('pointermove', this.handlePointerMove)
    this.canvas.removeEventListener('pointerleave', this.handlePointerLeave)
    this.canvas.removeEventListener('click', this.handleClick)
    this.canvas.removeEventListener('dblclick', this.handleDoubleClick)
    this.reducedMotion.removeEventListener('change', this.handleMotionPreference)
    this.stopWatchingClock()
    this.clearAtlasObjects()
    for (const geometry of this.geometryCache.values()) disposeCityGeometry(geometry)
    this.geometryCache.clear()
    for (const disposable of this.terrainDisposables) disposable.dispose()
    this.terrainDisposables.length = 0
    this.labels.dispose()
    this.renderer.dispose()
  }

  /** Places one database's city and returns its plan plus the cache signature its geometry was built under. */
  private addDatabase(
    database: DatabaseAtlasItem,
    center: THREE.Vector3,
    generatedAt: string,
  ): { plan: AtlasCityPlan; signature: string } {
    const plan = planAtlasCity(database)
    const signature = cityGeometrySignature(plan)
    let geometry = this.geometryCache.get(signature)
    if (!geometry) {
      geometry = buildAtlasCityGeometry(plan)
      this.geometryCache.set(signature, geometry)
    }

    const tint = plan.sizeKnown ? colorFor(database.databaseId) : 0x637080
    const materials: THREE.MeshStandardMaterial[] = []
    const flat = this.viewMode === 'map'

    // The pad is always present, so it is what a pointer finds over a city with no massing at all.
    // In map mode it becomes the parcel itself: a light plate with the database's tint, the way a
    // basemap draws a named area.
    const padMaterial = new THREE.MeshStandardMaterial({
      color: flat
        ? (plan.sizeKnown ? MAP_PALETTE.block : 0xe4e2da)
        : (plan.sizeKnown ? 0x1d2a36 : 0x2a323b),
      roughness: 0.95,
      metalness: 0.02,
      transparent: !plan.sizeKnown,
      opacity: plan.sizeKnown ? 1 : 0.55,
      emissive: tint,
      emissiveIntensity: flat ? 0 : 0.08,
    })
    materials.push(padMaterial)
    this.addCityMesh(geometry.pad, padMaterial, center, database.databaseId, true)

    if (geometry.massing) {
      const massingMaterial = new THREE.MeshStandardMaterial({
        color: tint,
        roughness: 0.72,
        metalness: 0.08,
        emissive: tint,
        emissiveIntensity: flat ? 0 : 0.08,
      })
      materials.push(massingMaterial)
      this.addCityMesh(geometry.massing, massingMaterial, center, database.databaseId, true)
    }

    if (geometry.trim) {
      const trimMaterial = new THREE.MeshStandardMaterial({
        color: flat ? MAP_PALETTE.buildingEdge : 0xdbe7f2,
        roughness: 0.5,
        metalness: 0.05,
        emissive: tint,
        emissiveIntensity: flat ? 0 : 0.08,
      })
      materials.push(trimMaterial)
      this.addCityMesh(geometry.trim, trimMaterial, center, database.databaseId, false)
    }

    if (geometry.streetCasing || geometry.streetFill) {
      const flatStreets = this.viewMode === 'map'
      const layers: Array<[THREE.BufferGeometry | null, number]> = [
        [geometry.streetCasing, flat ? MAP_PALETTE.roadCasing : 0x2c3a46],
        [geometry.streetFill, flat ? MAP_PALETTE.roadFill : 0x8ea6ba],
      ]
      for (const [streetGeometry, color] of layers) {
        if (!streetGeometry) continue
        const material = new THREE.MeshBasicMaterial({ color })
        const mesh = new THREE.Mesh(streetGeometry, material)
        mesh.position.copy(center)
        // Squashed with the buildings in the flat drawing, so roads stay under the massing rather
        // than floating over it in a straight-down view.
        if (flatStreets) mesh.scale.y = 0.02
        mesh.userData.atlasObject = true
        this.disposables.push(material)
        this.scene.add(mesh)
      }
    }

    this.cityMaterials.set(database.databaseId, materials)
    this.addLabel(database, plan, center)
    this.expandContentBounds(center, plan)

    if (!plan.sizeKnown) this.addUnknownMark(center)
    if (isFreshLive(database, generatedAt)) {
      this.addBeacon(center, PAD_HEIGHT + (plan.towerHeight ?? 0), database.databaseId)
    }
    return { plan, signature }
  }

  private addCityMesh(
    geometry: THREE.BufferGeometry,
    material: THREE.MeshStandardMaterial,
    center: THREE.Vector3,
    databaseId: string,
    pickable: boolean,
  ): void {
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.copy(center)
    // Massing is a 3D claim. The flat drawing keeps the same footprint and tint but no height.
    if (this.viewMode === 'map') mesh.scale.y = 0.02
    mesh.userData.databaseId = databaseId
    mesh.userData.atlasObject = true
    this.disposables.push(material)
    this.scene.add(mesh)
    if (pickable) this.interactive.push(mesh)
  }

  /**
   * Names a city on the pavement at the edge of its plot, in world space so it never leans with the
   * camera. The anchor is the south kerb, which is the side the default framing looks in from.
   */
  private addLabel(database: DatabaseAtlasItem, plan: AtlasCityPlan, center: THREE.Vector3): void {
    const sprite = this.labels.make(databaseLabelText(database.name))
    if (!sprite) return
    const reach = (plan.sizeKnown ? plan.radius.max : plan.side / 2) + LABEL_KERB
    const anchor = labelAnchor(center.x, center.z, center.x, center.z + 1, reach)
    sprite.position.set(anchor.x, PAD_HEIGHT + ATLAS_LABEL_WORLD_HEIGHT / 2, anchor.z)
    sprite.userData.atlasObject = true
    this.scene.add(sprite)

    // The rasterised sprite's own scale is the only honest source for how wide a name ended up.
    const halfWidth = sprite.scale.x / 2
    const halfHeight = sprite.scale.y / 2
    this.contentBounds.expandByPoint(new THREE.Vector3(anchor.x - halfWidth, 0, anchor.z - halfHeight))
    this.contentBounds.expandByPoint(
      new THREE.Vector3(anchor.x + halfWidth, sprite.position.y + halfHeight, anchor.z + halfHeight),
    )
  }

  private addUnknownMark(center: THREE.Vector3): void {
    const material = new THREE.MeshBasicMaterial({ color: 0xf2f5f7 })
    this.disposables.push(material)
    for (const rotation of [Math.PI / 4, -Math.PI / 4]) {
      const geometry = new THREE.BoxGeometry(28, 1.4, 2.2)
      const bar = new THREE.Mesh(geometry, material)
      bar.position.set(center.x, PAD_HEIGHT + 4, center.z)
      bar.rotation.y = rotation
      bar.userData.atlasObject = true
      this.disposables.push(geometry)
      this.scene.add(bar)
    }
  }

  private addBeacon(center: THREE.Vector3, height: number, databaseId: string): void {
    const geometry = new THREE.SphereGeometry(3.4, 16, 10)
    const material = new THREE.MeshBasicMaterial({ color: 0x72f4c4 })
    const beacon = new THREE.Mesh(geometry, material)
    beacon.position.set(center.x, height + 9, center.z)
    beacon.userData.atlasObject = true
    this.disposables.push(geometry, material)
    this.scene.add(beacon)
    this.beacons.push({ mesh: beacon, phase: (stableHash(databaseId) % 1000) / 100 })
  }

  /**
   * Draws the road between two databases that reference each other.
   *
   * Was a one-pixel straight line between two town centres, which is a node-and-edge diagram: it ran
   * *through* both towns and arrived nowhere in particular. It is now a road — a bowed centreline
   * between the two towns' nearest gateways, drawn as a casing and a fill exactly like every other
   * road on either surface, ending where a street begins.
   *
   * The measurement is untouched: confidence is still the only thing encoded, still by the same three
   * treatments, and the bow is seeded from the pair of database ids so a given reference draws the
   * same road every time.
   */
  private addEdge(
    from: THREE.Vector3,
    to: THREE.Vector3,
    fromPlan: AtlasCityPlan | undefined,
    toPlan: AtlasCityPlan | undefined,
    confidence: EdgeConfidence,
    seedKey: string,
  ): void {
    const points = regionalRoadPath(from, fromPlan, to, toPlan, seedKey)
    if (points.length < 2) return

    const flat = this.viewMode === 'map'
    const dash =
      confidence === 'Confirmed' ? null : confidence === 'Probable' ? { on: 11, off: 6 } : { on: 4, off: 9 }
    const fill =
      confidence === 'Confirmed'
        ? (flat ? MAP_PALETTE.arterialFill : 0xe8edf2)
        : confidence === 'Probable'
          ? 0xf0b44e
          : 0x9aa7b4
    const casing = flat ? MAP_PALETTE.arterialCasing : 0x1b2530
    const y = PAD_HEIGHT * (flat ? 0.02 : 1) - 0.05

    // The casing of a dashed road is dashed too, or the gaps fill in and the confidence is lost.
    const layers: Array<[number, number, number]> = [
      [HIGHWAY_CASING_WIDTH, casing, 0],
      [HIGHWAY_FILL_WIDTH, fill, 0.02],
    ]
    for (const [width, color, lift] of layers) {
      const positions = ribbonPositions(points, width, dash, 0, [], y + lift)
      if (positions.length === 0) continue
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      const material = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })
      const mesh = new THREE.Mesh(geometry, material)
      mesh.userData.atlasObject = true
      this.disposables.push(geometry, material)
      this.scene.add(mesh)
    }
  }

  private clearAtlasObjects(): void {
    const removable = this.scene.children.filter(child => child.userData.atlasObject === true)
    for (const child of removable) this.scene.remove(child)
    for (const disposable of this.disposables) disposable.dispose()
    this.disposables.length = 0
    this.interactive.length = 0
    this.beacons.length = 0
    this.cityMaterials.clear()
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const bounds = this.canvas.getBoundingClientRect()
    this.pointer.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    )
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hit = this.raycaster.intersectObjects(this.interactive, false)[0]
    const nextId = hit?.object.userData.databaseId as string | undefined
    const normalized = nextId ?? null
    if (normalized !== this.hoveredId) {
      this.hoveredId = normalized
      this.canvas.style.cursor = normalized ? 'pointer' : 'default'
      this.callbacks.onHover(normalized)
    }
  }

  private readonly handlePointerLeave = (): void => {
    this.hoveredId = null
    this.canvas.style.cursor = 'default'
    this.callbacks.onHover(null)
  }

  private readonly handleClick = (): void => {
    this.activation.click(this.hoveredId)
    if (this.hoveredId) this.callbacks.onSelect(this.hoveredId)
  }

  /**
   * Enters the double-clicked database's city. The click handler has already selected it, so the
   * detail panel and the city view name the same database, and the panel's own button stays the
   * keyboard-reachable way to do this.
   */
  private readonly handleDoubleClick = (): void => {
    const databaseId = this.activation.activate()
    if (databaseId) this.callbacks.onOpen(databaseId)
  }

  private readonly handleMotionPreference = (): void => this.syncAnimation()

  private syncAnimation(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame)
      this.frame = null
    }
    if (this.beacons.length > 0 && !this.reducedMotion.matches) this.frame = requestAnimationFrame(this.animate)
    else this.render()
  }

  private readonly animate = (time: number): void => {
    for (const beacon of this.beacons) {
      beacon.mesh.scale.setScalar(0.85 + Math.sin(time * 0.004 + beacon.phase) * 0.18)
    }
    this.render()
    this.frame = requestAnimationFrame(this.animate)
  }

  private resize(): void {
    const width = Math.max(1, this.canvas.clientWidth)
    const height = Math.max(1, this.canvas.clientHeight)
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.placeCamera()
    this.render()
  }

  /**
   * Records how much room a city's plot needs. The label is accounted for separately in
   * {@link addLabel}, because it stands on one side only and its width is whatever the rasterised name
   * turned out to be — padding all four sides by a guess would claim ground no city occupies and push
   * the camera back for nothing.
   */
  private expandContentBounds(center: THREE.Vector3, plan: AtlasCityPlan): void {
    const reach = plan.sizeKnown ? plan.radius.max : plan.side / 2
    const top = PAD_HEIGHT + (plan.towerHeight ?? 0)
    this.contentBounds.expandByPoint(new THREE.Vector3(center.x - reach, 0, center.z - reach))
    this.contentBounds.expandByPoint(new THREE.Vector3(center.x + reach, top, center.z + reach))
  }

  /** Re-centres the framing on the current snapshot's cities. */
  private frameContent(): void {
    if (this.contentBounds.isEmpty()) {
      this.frameCenter.set(0, 0, 0)
      this.frameExtents.set(MIN_FRAME_EXTENT, MIN_FRAME_EXTENT, MIN_FRAME_EXTENT)
    } else {
      this.contentBounds.getCenter(this.frameCenter)
      this.contentBounds.getSize(this.frameExtents).multiplyScalar(0.5)
      this.frameExtents.x = Math.max(this.frameExtents.x, MIN_FRAME_EXTENT)
      this.frameExtents.z = Math.max(this.frameExtents.z, MIN_FRAME_EXTENT)
    }
    this.placeCamera()
  }

  /**
   * Solves the camera distance for the current framing and viewport shape. Called on resize as well as
   * on snapshot, because a narrower panel needs to stand further back to hold the same cities.
   */
  private placeCamera(): void {
    // Map mode is a plan view on the same heading, with a narrow field of view so parcels at the edge
    // of the atlas are not skewed by perspective — a basemap that keels over at the margins reads as a
    // rendering fault rather than as a map.
    const flat = this.viewMode === 'map'
    const view = flat ? MAP_VIEW_DIRECTION : VIEW_DIRECTION
    const fov = flat ? 12 : 36
    if (this.camera.fov !== fov) {
      this.camera.fov = fov
      this.camera.updateProjectionMatrix()
    }
    const distance = fitDistance(this.frameExtents, this.camera.fov, this.camera.aspect, undefined, view)
    const reach = this.frameExtents.length()
    this.camera.position.set(
      this.frameCenter.x + view.x * distance,
      this.frameCenter.y + view.y * distance,
      this.frameCenter.z + view.z * distance,
    )
    this.camera.lookAt(this.frameCenter)
    this.camera.near = Math.max(1, distance - reach * 2)
    this.camera.far = distance + reach * 3
    this.camera.updateProjectionMatrix()
  }

  private render(): void {
    this.renderer.render(this.scene, this.camera)
  }
}

function disposeCityGeometry(geometry: AtlasCityGeometry): void {
  geometry.pad.dispose()
  geometry.massing?.dispose()
  geometry.trim?.dispose()
  geometry.streetCasing?.dispose()
  geometry.streetFill?.dispose()
}

function colorFor(databaseId: string): number {
  const palette = [0x39c6a3, 0x45a7e6, 0xe9a84c, 0xb48be8, 0x57bd70, 0xde6f73, 0x7bb7b2, 0xd58cb7]
  return palette[stableHash(databaseId) % palette.length] ?? 0x45a7e6
}

/** A closed outline grown about its own centroid, for drawing a rim under a filled shape. */
function expand(points: readonly AtlasPoint[], factor: number): AtlasPoint[] {
  let cx = 0
  let cz = 0
  for (const point of points) {
    cx += point.x
    cz += point.z
  }
  cx /= points.length
  cz /= points.length
  return points.map(point => ({
    x: cx + (point.x - cx) * factor,
    z: cz + (point.z - cz) * factor,
  }))
}


