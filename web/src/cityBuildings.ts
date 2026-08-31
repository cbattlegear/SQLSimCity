import * as THREE from 'three'
import { neighborhoodHue, type BuildingArchetype, type CityLot } from './cityPlan'
import type { DistrictCharacter } from './cityTerrain'
import { mergeAndDispose } from './mergeGeometry'

/**
 * Procedural building geometry, one merged {@link THREE.BufferGeometry} per building.
 *
 * **Evidence boundary.** Only three things here are measured: the building's `footprint` (log2 of
 * exact reserved pages), its `height` (log2 of exact used pages), and its `archetype` (exact reserved
 * page thresholds). Everything else -- bay rhythm, roof form, cornices, balconies, storefronts,
 * canopies, rooftop plant, palette -- is decoration derived from the lot's stable `seed` and its
 * district's character, and encodes nothing. A building's decoration never changes when its
 * measurements change, and never varies between renders of the same object.
 *
 * A lot whose size is unknown gets `archetype: 'vacant'` and renders as a fenced empty parcel, so an
 * unmeasured object can never be mistaken for a small one.
 *
 * **How the massing is composed.** Every archetype is assembled from the same kit: a plinth, one or
 * more shafts, a facade, and a crown. The facade is bay-based rather than a fixed grid of quads --
 * the number of bays follows the building's own width, so a wide table and a narrow one are visibly
 * different buildings rather than the same texture stretched. Bay count follows geometry, never data.
 */

/** Deterministic 0..1 stream from a lot's stable seed. Decoration only; never gates a measurement. */
function seeded(seed: number): () => number {
  let state = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return ((state >>> 0) % 100_000) / 100_000
  }
}

export interface BuildingGeometrySet {
  /** Body of the building, already centred on the origin with its base at y = 0. */
  readonly body: THREE.BufferGeometry
  /** Windows, emitted as a single instanced-friendly geometry, or null for archetypes without them. */
  readonly windows: THREE.BufferGeometry | null
  /** Trim: roofs, parapets, crowns, doors. Rendered in the accent material. */
  readonly trim: THREE.BufferGeometry | null
  readonly height: number
  readonly footprint: number
}

/** Footprint and height used when the object's page counts are unavailable. */
const VACANT_FENCE_HEIGHT = 2.2

/**
 * A hard ceiling on drawn window panels per building.
 *
 * A large instance can produce thousands of buildings, and the facade system multiplies bays by
 * floors by four faces. Past this count the extra panels are invisible at any camera distance that
 * fits the building on screen, so they are spent on nothing.
 */
const MAX_PANELS = 360

export function buildBuildingGeometry(
  lot: CityLot,
  character: DistrictCharacter = 'commercial',
): BuildingGeometrySet {
  const footprint = lot.footprint ?? 11
  const height = lot.height ?? 0
  const random = seeded(lot.seed)
  switch (lot.archetype) {
    case 'house':
      return house(footprint, height, random, character)
    case 'rowhouse':
      return rowhouse(footprint, height, random, character)
    case 'midrise':
      return midrise(footprint, height, random, character)
    case 'tower':
      return tower(footprint, height, random, character, false)
    case 'skyscraper':
      return tower(footprint, height, random, character, true)
    case 'civic':
      return civic(footprint, height, random, character)
    default:
      return vacant(footprint)
  }
}

type Random = () => number

function box(
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
  rotationY = 0,
): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(width, height, depth)
  if (rotationY !== 0) geometry.rotateY(rotationY)
  geometry.translate(x, y, z)
  return geometry
}

const CUBE_FACES: readonly (readonly [number, number, number, number])[] = [
  [0, 1, 2, 3], [7, 6, 5, 4], [4, 5, 1, 0], [5, 6, 2, 1], [6, 7, 3, 2], [7, 4, 0, 3],
]

/**
 * A rectangular frustum: the workhorse behind setbacks, mansards, tapered crowns and plinths.
 *
 * Emitted as non-indexed triangles on purpose. Sharing corners and calling `computeVertexNormals`
 * would average the normals across the taper and shade a hard-edged solid as if it were inflated.
 */
function frustum(
  bottomWidth: number,
  bottomDepth: number,
  topWidth: number,
  topDepth: number,
  height: number,
  y: number,
): THREE.BufferGeometry {
  const bx = bottomWidth / 2
  const bz = bottomDepth / 2
  const tx = topWidth / 2
  const tz = topDepth / 2
  const corners: readonly (readonly [number, number, number])[] = [
    [-bx, y, -bz], [bx, y, -bz], [bx, y, bz], [-bx, y, bz],
    [-tx, y + height, -tz], [tx, y + height, -tz], [tx, y + height, tz], [-tx, y + height, tz],
  ]
  const positions: number[] = []
  for (const [a, b, c, d] of CUBE_FACES) {
    for (const index of [a, b, c, a, c, d]) positions.push(...corners[index])
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  return geometry
}

/** A triangular prism with its ridge running along X: gables, pediments, dormers. */
function prism(width: number, depth: number, height: number, y: number): THREE.BufferGeometry {
  const hw = width / 2
  const hd = depth / 2
  const corners: readonly (readonly [number, number, number])[] = [
    [-hw, y, -hd], [hw, y, -hd], [hw, y, hd], [-hw, y, hd],
    [-hw, y + height, 0], [hw, y + height, 0],
  ]
  const triangles: readonly (readonly number[])[] = [
    [0, 2, 1], [0, 3, 2], [3, 5, 2], [3, 4, 5], [0, 1, 5], [0, 5, 4], [1, 2, 5], [0, 4, 3],
  ]
  const positions: number[] = []
  for (const triangle of triangles) {
    for (const index of triangle) positions.push(...corners[index])
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  return geometry
}

/** A parapet: four low walls on the roof edge, which is what stops a flat roof reading as a lid. */
function parapet(
  width: number,
  depth: number,
  thickness: number,
  height: number,
  y: number,
): THREE.BufferGeometry[] {
  return [
    box(width, height, thickness, 0, y + height / 2, -depth / 2 + thickness / 2),
    box(width, height, thickness, 0, y + height / 2, depth / 2 - thickness / 2),
    box(thickness, height, depth - thickness * 2, -width / 2 + thickness / 2, y + height / 2, 0),
    box(thickness, height, depth - thickness * 2, width / 2 - thickness / 2, y + height / 2, 0),
  ]
}

const merge = mergeAndDispose

// --------------------------------------------------------------------------------------------------
// The facade system
// --------------------------------------------------------------------------------------------------

/** How a facade is glazed. Purely a look; the bay count follows the building's width either way. */
type Glazing = 'punched' | 'ribbon' | 'curtain'

interface FacadeSpec {
  width: number
  depth: number
  /** Height of the glazed shaft, excluding any plinth below it. */
  height: number
  /** World y of the bottom of the shaft. */
  base: number
  /** Target width of one structural bay. The drawn bay width is this rounded to fit. */
  bay: number
  /** Target floor-to-floor height. */
  floor: number
  glazing: Glazing
  /** Draws a glazed ground floor with a canopy and an entrance. */
  storefront: boolean
  /** Projecting slabs on alternating floors, on the long faces only. */
  balconies: boolean
  /** A horizontal band every few storeys, which is what gives a tall shaft a legible scale. */
  stringCourse: boolean
}

interface FacadeParts {
  windows: THREE.BufferGeometry[]
  trim: THREE.BufferGeometry[]
}

/**
 * Builds one shaft's glazing and its applied trim.
 *
 * The rhythm comes from the geometry: bays are the building's width divided into whole units close to
 * the target bay width, and floors are its height divided into whole storeys. Two buildings of
 * different measured size therefore get visibly different facades, and two of the same measured size
 * get the same one.
 */
function facade(spec: FacadeSpec): FacadeParts {
  const windows: THREE.BufferGeometry[] = []
  const trim: THREE.BufferGeometry[] = []
  const { width, depth, height, base, glazing } = spec
  if (height <= 1.6 || width <= 1 || depth <= 1) return { windows, trim }

  const floors = Math.max(1, Math.min(48, Math.round(height / spec.floor)))
  const floorHeight = height / floors
  if (floorHeight < 1.4) return { windows, trim }

  const groundFloors = spec.storefront && floors > 1 ? 1 : 0
  const upperFloors = floors - groundFloors
  const bayX = Math.max(1, Math.min(9, Math.round(width / spec.bay)))
  const bayZ = Math.max(1, Math.min(9, Math.round(depth / spec.bay)))

  // Trade rows for bays when the building is too tall to draw every storey. Skipping rows keeps the
  // vertical rhythm; dropping bays would change the building's apparent width.
  const perRow = (bayX + bayZ) * 2
  const rowStride = Math.max(1, Math.ceil((upperFloors * perRow) / MAX_PANELS))

  const pitchX = width / bayX
  const pitchZ = depth / bayZ
  const glassRatio = glazing === 'curtain' ? 0.82 : glazing === 'ribbon' ? 0.74 : 0.52
  const sillRatio = glazing === 'curtain' ? 0.86 : glazing === 'ribbon' ? 0.5 : 0.46
  const panelWidthX = pitchX * glassRatio
  const panelWidthZ = pitchZ * glassRatio
  const panelHeight = floorHeight * sillRatio
  const proud = 0.16

  for (let floor = groundFloors; floor < floors; floor += 1) {
    if ((floor - groundFloors) % rowStride !== 0) continue
    const y = base + floorHeight * (floor + 0.52)
    for (let bay = 0; bay < bayX; bay += 1) {
      const x = (bay - (bayX - 1) / 2) * pitchX
      windows.push(box(panelWidthX, panelHeight, 0.22, x, y, depth / 2 + proud))
      windows.push(box(panelWidthX, panelHeight, 0.22, x, y, -depth / 2 - proud))
    }
    for (let bay = 0; bay < bayZ; bay += 1) {
      const z = (bay - (bayZ - 1) / 2) * pitchZ
      windows.push(box(0.22, panelHeight, panelWidthZ, width / 2 + proud, y, z))
      windows.push(box(0.22, panelHeight, panelWidthZ, -width / 2 - proud, y, z))
    }

    // Balconies read as residential from any distance, so they are the cheapest character cue there is.
    if (spec.balconies && floor > groundFloors && (floor - groundFloors) % 2 === 1) {
      const slabY = base + floorHeight * floor + 0.1
      for (const sign of [-1, 1]) {
        trim.push(box(width * 0.62, 0.22, 1.5, 0, slabY, sign * (depth / 2 + 0.75)))
        trim.push(box(width * 0.62, 0.5, 0.14, 0, slabY + 0.36, sign * (depth / 2 + 1.42)))
      }
    }
  }

  // Mullions: the vertical structure between bays. Only on a curtain wall, where they are the wall.
  if (glazing === 'curtain' && bayX <= 7) {
    const shaftBase = base + floorHeight * groundFloors
    const shaftHeight = height - floorHeight * groundFloors
    for (let bay = 0; bay <= bayX; bay += 1) {
      const x = -width / 2 + bay * pitchX
      for (const sign of [-1, 1]) {
        trim.push(box(0.24, shaftHeight, 0.16, x, shaftBase + shaftHeight / 2, sign * (depth / 2 + proud)))
      }
    }
  }

  // String courses every fourth storey. A forty-storey shaft with no horizontal break has no scale.
  if (spec.stringCourse) {
    for (let floor = groundFloors + 4; floor < floors; floor += 4) {
      trim.push(box(width + 0.5, 0.34, depth + 0.5, 0, base + floorHeight * floor, 0))
    }
  }

  if (spec.storefront) {
    const shopHeight = floorHeight * 0.72
    const y = base + shopHeight / 2 + 0.2
    for (const sign of [-1, 1]) {
      windows.push(box(width * 0.86, shopHeight, 0.2, 0, y, sign * (depth / 2 + proud)))
      windows.push(box(0.2, shopHeight, depth * 0.8, sign * (width / 2 + proud), y, 0))
    }
    // Canopy and entrance, on the front face only, so the building has a legible front.
    trim.push(box(width * 0.9, 0.22, 1.9, 0, base + floorHeight * 0.86, depth / 2 + 0.95))
    trim.push(box(width * 0.26, floorHeight * 0.66, 0.4, 0, base + floorHeight * 0.33, depth / 2 + 0.3))
  }

  return { windows, trim }
}

/** Rooftop plant: the clutter that stops every flat roof in the city reading as the same lid. */
function rooftop(width: number, depth: number, y: number, random: Random): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = []
  const scale = Math.min(width, depth)
  if (scale < 6) return parts
  parts.push(box(scale * 0.22, scale * 0.3, scale * 0.22, -width * 0.22, y + scale * 0.15, depth * 0.18))
  if (random() > 0.4) {
    parts.push(box(scale * 0.3, scale * 0.1, scale * 0.2, width * 0.2, y + scale * 0.05, -depth * 0.16))
  }
  if (random() > 0.6) {
    const tank = new THREE.CylinderGeometry(scale * 0.12, scale * 0.12, scale * 0.18, 8)
    tank.translate(width * 0.18, y + scale * 0.26, depth * 0.2)
    parts.push(tank)
    parts.push(box(scale * 0.2, scale * 0.17, scale * 0.2, width * 0.18, y + scale * 0.085, depth * 0.2))
  }
  return parts
}

// --------------------------------------------------------------------------------------------------
// Archetypes
// --------------------------------------------------------------------------------------------------

/** Small detached house: walls, a pitched or hipped roof with eaves, a porch, and a chimney. */
function house(
  footprint: number,
  height: number,
  random: Random,
  character: DistrictCharacter,
): BuildingGeometrySet {
  const width = footprint
  const depth = footprint * (0.78 + random() * 0.16)
  const wallHeight = Math.max(height, 3.2)
  const roofHeight = wallHeight * (0.42 + random() * 0.2)
  const hipped = character === 'civic' || random() > 0.55

  const body = box(width, wallHeight, depth, 0, wallHeight / 2, 0)
  const trim: THREE.BufferGeometry[] = []

  if (hipped) {
    const roof = new THREE.ConeGeometry(Math.max(width, depth) * 0.76, roofHeight, 4)
    roof.rotateY(Math.PI / 4)
    roof.translate(0, wallHeight + roofHeight / 2, 0)
    trim.push(roof)
  } else {
    trim.push(prism(width * 1.1, depth * 1.12, roofHeight, wallHeight))
    // Eaves. Without an overhang a pitched roof looks like a party hat balanced on a box.
    trim.push(box(width * 1.14, 0.28, depth * 1.16, 0, wallHeight + 0.14, 0))
  }

  // Porch: a hood on two posts over the door.
  const doorZ = depth / 2
  trim.push(box(width * 0.24, wallHeight * 0.62, 0.4, 0, wallHeight * 0.31, doorZ + 0.2))
  trim.push(box(width * 0.5, 0.2, 1.3, 0, wallHeight * 0.66, doorZ + 0.65))
  for (const sign of [-1, 1]) {
    trim.push(box(0.24, wallHeight * 0.62, 0.24, sign * width * 0.2, wallHeight * 0.31, doorZ + 1.1))
  }
  if (random() > 0.45) {
    const chimneyX = (random() > 0.5 ? 1 : -1) * width * 0.28
    trim.push(box(1.1, roofHeight * 1.2, 1.1, chimneyX, wallHeight + roofHeight * 0.72, 0))
  }

  const parts = facade({
    width,
    depth,
    height: wallHeight,
    base: 0,
    bay: 3.4,
    floor: 3.2,
    glazing: 'punched',
    storefront: false,
    balconies: false,
    stringCourse: false,
  })
  trim.push(...parts.trim)

  return {
    body,
    windows: merge(parts.windows),
    trim: merge(trim),
    height: wallHeight + roofHeight,
    footprint,
  }
}

/** Terraced housing: a plinth, a cornice, and either a mansard with dormers or a flat parapet. */
function rowhouse(
  footprint: number,
  height: number,
  random: Random,
  character: DistrictCharacter,
): BuildingGeometrySet {
  const width = footprint
  const depth = footprint * (0.7 + random() * 0.12)
  const wallHeight = Math.max(height, 5)
  const mansard = character === 'residential' || random() > 0.6
  const capHeight = mansard ? Math.min(wallHeight * 0.22, 3.4) : 0.8

  const bodies = [
    box(width, wallHeight, depth, 0, wallHeight / 2, 0),
    // Plinth: a slightly wider ground storey, which is how a terrace meets the pavement.
    frustum(width * 1.05, depth * 1.05, width * 1.02, depth * 1.02, Math.min(1.4, wallHeight * 0.2), 0),
  ]

  // The cornice under the roof is the strongest single line on a terrace.
  const trim: THREE.BufferGeometry[] = [box(width * 1.08, 0.55, depth * 1.08, 0, wallHeight - 0.1, 0)]
  if (mansard) {
    trim.push(frustum(width * 1.04, depth * 1.04, width * 0.74, depth * 0.74, capHeight, wallHeight + 0.18))
    const dormers = Math.max(1, Math.min(4, Math.round(width / 4.6)))
    for (let index = 0; index < dormers; index += 1) {
      const x = (index - (dormers - 1) / 2) * (width / dormers)
      trim.push(box((width / dormers) * 0.42, capHeight * 0.62, 1.0, x, wallHeight + capHeight * 0.42, depth * 0.42))
    }
  } else {
    trim.push(...parapet(width * 1.04, depth * 1.04, 0.4, capHeight, wallHeight + 0.18))
  }

  const parts = facade({
    width,
    depth,
    height: wallHeight,
    base: 0,
    bay: 3.2,
    floor: 3.6,
    glazing: 'punched',
    storefront: character === 'commercial',
    balconies: character === 'residential' && wallHeight > 11,
    stringCourse: false,
  })
  trim.push(...parts.trim)

  return {
    body: merge(bodies)!,
    windows: merge(parts.windows),
    trim: merge(trim),
    height: wallHeight + capHeight + 0.18,
    footprint,
  }
}

/** Mid-rise: a podium, a set-back shaft, cornices, parapets, and plant on the roof. */
function midrise(
  footprint: number,
  height: number,
  random: Random,
  character: DistrictCharacter,
): BuildingGeometrySet {
  const width = footprint
  const depth = footprint * (0.86 + random() * 0.12)
  const total = Math.max(height, 10)
  const podiumHeight = total * (0.5 + random() * 0.14)
  const setback = 0.8 + random() * 0.08
  const shaftHeight = total - podiumHeight
  const shaftWidth = width * setback
  const shaftDepth = depth * setback
  const industrial = character === 'industrial'

  const bodies = [
    box(width, podiumHeight, depth, 0, podiumHeight / 2, 0),
    box(shaftWidth, shaftHeight, shaftDepth, 0, podiumHeight + shaftHeight / 2, 0),
  ]

  const trim: THREE.BufferGeometry[] = [
    // The podium cornice is what makes the setback read as deliberate rather than as a modelling slip.
    box(width * 1.05, 0.7, depth * 1.05, 0, podiumHeight - 0.1, 0),
    ...parapet(width * 1.02, depth * 1.02, 0.4, 1.1, podiumHeight),
    ...parapet(shaftWidth * 1.04, shaftDepth * 1.04, 0.4, 1.2, total),
  ]
  trim.push(...rooftop(shaftWidth, shaftDepth, total, random))

  const glazing: Glazing = character === 'commercial' ? 'ribbon' : 'punched'
  const bay = industrial ? 5.2 : 3.8
  const podium = facade({
    width,
    depth,
    height: podiumHeight,
    base: 0,
    bay,
    floor: 4.2,
    glazing,
    storefront: !industrial,
    balconies: false,
    stringCourse: false,
  })
  const shaft = facade({
    width: shaftWidth,
    depth: shaftDepth,
    height: shaftHeight,
    base: podiumHeight,
    bay,
    floor: 4.2,
    glazing,
    storefront: false,
    balconies: character === 'residential',
    stringCourse: shaftHeight > 26,
  })
  trim.push(...podium.trim, ...shaft.trim)

  return {
    body: merge(bodies)!,
    windows: merge([...podium.windows, ...shaft.windows]),
    trim: merge(trim),
    height: total + 1.2,
    footprint,
  }
}

/** Tower / skyscraper: a plinth, tapered stacked shafts, terraces at each step, a crown, and a mast. */
function tower(
  footprint: number,
  height: number,
  random: Random,
  character: DistrictCharacter,
  tallest: boolean,
): BuildingGeometrySet {
  const total = Math.max(height, 18)
  const stacks = tallest ? 3 + Math.round(random()) : 2
  const bodies: THREE.BufferGeometry[] = []
  const windows: THREE.BufferGeometry[] = []
  const trim: THREE.BufferGeometry[] = []
  const glazing: Glazing = character === 'industrial' ? 'ribbon' : 'curtain'

  let base = 0
  let width = footprint
  let depth = footprint * (0.9 + random() * 0.08)
  for (let stack = 0; stack < stacks; stack += 1) {
    const remaining = stacks - stack
    const last = stack === stacks - 1
    const stackHeight = last ? total - base : ((total - base) / remaining) * (0.85 + random() * 0.3)
    const nextWidth = width * (0.8 + random() * 0.08)
    const nextDepth = depth * (0.8 + random() * 0.08)

    if (last) {
      // The top stack tapers rather than stepping, so the tower has a silhouette instead of a stack
      // of boxes with a lid on it.
      bodies.push(frustum(width, depth, width * 0.9, depth * 0.9, stackHeight, base))
    } else {
      bodies.push(box(width, stackHeight, depth, 0, base + stackHeight / 2, 0))
      trim.push(box(width * 1.03, 0.6, depth * 1.03, 0, base + stackHeight - 0.1, 0))
      trim.push(...parapet(width, depth, 0.36, 0.9, base + stackHeight))
    }

    const parts = facade({
      width,
      depth,
      height: stackHeight,
      base,
      bay: 3.6,
      floor: 4.0,
      glazing,
      storefront: stack === 0,
      balconies: false,
      stringCourse: stackHeight > 24,
    })
    windows.push(...parts.windows)
    trim.push(...parts.trim)

    base += stackHeight
    width = nextWidth
    depth = nextDepth
  }

  // A plinth at the pavement and a crown at the top: the two ends a tall building needs before it
  // reads as architecture rather than as an extrusion.
  trim.push(frustum(footprint * 1.12, footprint * 1.12, footprint * 1.04, footprint * 1.04, 0.9, 0))
  const crownWidth = width * 0.9
  const crownDepth = depth * 0.9
  trim.push(frustum(crownWidth * 1.14, crownDepth * 1.14, crownWidth * 0.86, crownDepth * 0.86, 1.6, total))
  trim.push(...rooftop(crownWidth, crownDepth, total + 1.6, random))
  let top = total + 1.6
  if (tallest) {
    // Mast length is capped so a very tall tower does not sprout an implausible spike.
    const mastHeight = Math.min(total * 0.16, 9)
    const mast = new THREE.CylinderGeometry(0.24, 0.62, mastHeight, 6)
    mast.translate(0, top + mastHeight / 2, 0)
    trim.push(mast)
    top += mastHeight
  }

  return { body: merge(bodies)!, windows: merge(windows), trim: merge(trim), height: top, footprint }
}

/** Indexed views get a civic hall: a colonnaded base, steps, and a glazed barrel vault over the hall. */
function civic(
  footprint: number,
  height: number,
  random: Random,
  character: DistrictCharacter,
): BuildingGeometrySet {
  const width = footprint * 1.1
  const depth = footprint * (0.82 + random() * 0.1)
  const wallHeight = Math.max(height, 6)
  const vaultRadius = Math.min(width, depth) * 0.32

  const bodies = [
    box(width, wallHeight, depth, 0, wallHeight / 2, 0),
    frustum(width * 1.14, depth * 1.14, width * 1.04, depth * 1.04, 1.0, 0),
  ]

  const trim: THREE.BufferGeometry[] = [box(width * 1.08, 1.1, depth * 1.08, 0, wallHeight + 0.55, 0)]

  // Colonnade across the front, under a full-width entablature.
  const columns = Math.max(4, Math.min(9, Math.round(width / 3.4)))
  const columnHeight = wallHeight * 0.92
  for (let index = 0; index < columns; index += 1) {
    const x = (index - (columns - 1) / 2) * (width / columns)
    const column = new THREE.CylinderGeometry(0.5, 0.58, columnHeight, 8)
    column.translate(x, 1.0 + columnHeight / 2, depth / 2 + 1.0)
    trim.push(column)
  }
  trim.push(box(width * 1.06, 0.9, 2.0, 0, 1.0 + columnHeight + 0.45, depth / 2 + 1.0))
  for (let step = 0; step < 3; step += 1) {
    trim.push(
      box(width * (0.9 + step * 0.06), 0.34, 2.4 + step * 0.8, 0, 0.85 - step * 0.34, depth / 2 + 1.5 + step * 0.4),
    )
  }

  // A glazed barrel vault over the hall: the one roof form nothing else in the city uses.
  const vault = new THREE.CylinderGeometry(vaultRadius, vaultRadius, depth * 0.72, 14, 1, true, 0, Math.PI)
  vault.rotateZ(-Math.PI / 2)
  vault.rotateY(Math.PI / 2)
  vault.translate(0, wallHeight + 1.1, 0)

  const parts = facade({
    width,
    depth,
    height: wallHeight,
    base: 1.0,
    bay: 3.6,
    floor: 5.0,
    glazing: character === 'industrial' ? 'punched' : 'ribbon',
    storefront: false,
    balconies: false,
    stringCourse: false,
  })
  trim.push(...parts.trim)

  return {
    body: merge(bodies)!,
    windows: merge([...parts.windows, vault]),
    trim: merge(trim),
    height: wallHeight + 1.1 + vaultRadius,
    footprint,
  }
}

/** Unknown size: a fenced empty parcel. Deliberately has no massing at all -- it claims nothing. */
function vacant(footprint: number): BuildingGeometrySet {
  const posts: THREE.BufferGeometry[] = []
  const half = footprint / 2
  const perSide = 4
  for (let i = 0; i <= perSide; i += 1) {
    const t = -half + (footprint * i) / perSide
    posts.push(box(0.35, VACANT_FENCE_HEIGHT, 0.35, t, VACANT_FENCE_HEIGHT / 2, -half))
    posts.push(box(0.35, VACANT_FENCE_HEIGHT, 0.35, t, VACANT_FENCE_HEIGHT / 2, half))
    posts.push(box(0.35, VACANT_FENCE_HEIGHT, 0.35, -half, VACANT_FENCE_HEIGHT / 2, t))
    posts.push(box(0.35, VACANT_FENCE_HEIGHT, 0.35, half, VACANT_FENCE_HEIGHT / 2, t))
  }
  posts.push(box(footprint, 0.2, 0.25, 0, VACANT_FENCE_HEIGHT, -half))
  posts.push(box(footprint, 0.2, 0.25, 0, VACANT_FENCE_HEIGHT, half))
  posts.push(box(0.25, 0.2, footprint, -half, VACANT_FENCE_HEIGHT, 0))
  posts.push(box(0.25, 0.2, footprint, half, VACANT_FENCE_HEIGHT, 0))
  return { body: merge(posts)!, windows: null, trim: null, height: VACANT_FENCE_HEIGHT, footprint }
}

/** Palette. Colours are per-archetype styling and carry no measurement. */
export const ARCHETYPE_COLORS: Readonly<Record<BuildingArchetype, number>> = {
  house: 0x8a6f5a,
  rowhouse: 0x7d6c5e,
  midrise: 0x4f6675,
  tower: 0x35505f,
  skyscraper: 0x2b4453,
  civic: 0x6b7f96,
  vacant: 0x6e7d88,
}

/**
 * Per-character shifts on the archetype palette.
 *
 * A district's character is hashed from its schema id, so this is styling and nothing else: two
 * schemas with identical contents can and will be different colours. It exists so a city has
 * neighbourhoods you can navigate by, not so a colour can be looked up in a table and believed.
 */
const CHARACTER_TINTS: Readonly<Record<DistrictCharacter, Readonly<Record<BuildingArchetype, number>>>> = {
  residential: {
    house: 0x977a60, rowhouse: 0x8b7460, midrise: 0x6a6a70, tower: 0x4c5a63,
    skyscraper: 0x3c4d59, civic: 0x77808f, vacant: 0x6e7d88,
  },
  commercial: {
    house: 0x7f7264, rowhouse: 0x76707a, midrise: 0x4f6675, tower: 0x35505f,
    skyscraper: 0x2b4453, civic: 0x6b7f96, vacant: 0x6e7d88,
  },
  industrial: {
    house: 0x76685c, rowhouse: 0x6d655c, midrise: 0x565c5c, tower: 0x424f52,
    skyscraper: 0x36474c, civic: 0x5f7078, vacant: 0x6e7d88,
  },
  civic: {
    house: 0x8e8272, rowhouse: 0x847a6d, midrise: 0x5a6a7c, tower: 0x3d5468,
    skyscraper: 0x334a5e, civic: 0x7889a0, vacant: 0x6e7d88,
  },
}

/**
 * How much of a neighbourhood's hue reaches a building it stands in.
 *
 * Pushed hard because {@link tintPreservingLuma} spends it entirely on hue: brightness is restored
 * afterwards, so a large weight buys colour without costing the massing read. A gentler mix looked
 * principled and did nothing — under a warm low sun, a 26% blend of a mid-light hue into an
 * already-pale facade is invisible from any distance you would actually read a neighbourhood at.
 */
const NEIGHBORHOOD_TINT_WEIGHT = 0.44

/**
 * The same, for the flattened plates of the basemap.
 *
 * Map mode draws every building as one grey plate, because height is a 3D claim. That leaves the
 * plates free to carry the neighbourhood instead, which is the clearest possible answer to *which
 * schema is this* on a printed-looking map: a whole quarter of pale green, next to a quarter of pale
 * rose. Lower than the 3D weight only because paper wants less colour than a lit facade does.
 */
const MAP_NEIGHBORHOOD_TINT_WEIGHT = 0.36

/**
 * The hue that identifies one neighbourhood, as a packed sRGB colour.
 *
 * The hue itself comes from {@link neighborhoodHue} so the sidebar swatch and the map agree. Strongly
 * saturated and mid-light: this colour is never drawn directly, only ever mixed at a fraction of its
 * strength and then rebalanced back to the base's brightness, so a timid source colour arrives as no
 * colour at all. It says *these buildings are the same schema* and nothing else — the ordinal it comes
 * from is the schema's place in the catalogue's own listing, not a rank, a size or a score.
 */
export function neighborhoodTint(ordinal: number): number {
  return new THREE.Color().setHSL(neighborhoodHue(ordinal), 0.7, 0.5).getHex()
}

/** Blends two packed sRGB colours. `weight` is how much of `tint` survives. */
export function mixColor(base: number, tint: number, weight: number): number {
  const amount = Math.min(1, Math.max(0, weight))
  let mixed = 0
  for (let shift = 16; shift >= 0; shift -= 8) {
    const from = (base >> shift) & 0xff
    const to = (tint >> shift) & 0xff
    mixed |= Math.round(from + (to - from) * amount) << shift
  }
  return mixed
}

/** Rec. 709 relative luminance of a packed sRGB colour, on the same 0-255 scale as its channels. */
function luma(color: number): number {
  return 0.2126 * ((color >> 16) & 0xff) + 0.7152 * ((color >> 8) & 0xff) + 0.0722 * (color & 0xff)
}

/**
 * Mixes `tint` into `base`, then puts the brightness back.
 *
 * The archetype palette encodes nothing measured, but its *values* are what make a city read: pale
 * towers against dark warehouses, a bright civic block against its street. An ordinary blend drags
 * every facade toward the tint's own lightness, so a strong enough neighbourhood cue also flattens
 * the city into one tone — and a weak enough one to preserve the tone is not a cue.
 *
 * Rescaling the blend back to the original luminance breaks that trade. Hue and saturation come from
 * the mix; brightness comes from the building. A neighbourhood can then be pushed until it is
 * genuinely obvious while every facade keeps exactly the value it started with.
 *
 * A near-white facade cannot be scaled all the way back up — a channel hits 255 first — so whatever
 * brightness the scaling could not recover is made up by fading toward white. The tint gets paler on
 * the palest buildings, which is the right way to lose the argument: the value structure is what the
 * eye reads the city by, and the hue is only a name.
 */
export function tintPreservingLuma(base: number, tint: number, weight: number): number {
  const mixed = mixColor(base, tint, weight)
  const target = luma(base)
  const actual = luma(mixed)
  // A black source has no brightness to preserve and no ratio to scale by.
  if (actual <= 0.5) return mixed
  const peak = Math.max((mixed >> 16) & 0xff, (mixed >> 8) & 0xff, mixed & 0xff)
  const scale = Math.min(target / actual, peak > 0 ? 255 / peak : 1)

  const channels = [16, 8, 0].map(shift => ((mixed >> shift) & 0xff) * scale)
  const scaled = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
  // Whatever the ceiling stole, white gives back.
  const toWhite = scaled >= target || scaled >= 255 ? 0 : (target - scaled) / (255 - scaled)

  let out = 0
  channels.forEach((value, index) => {
    const lifted = value + (255 - value) * toWhite
    out |= Math.min(255, Math.max(0, Math.round(lifted))) << (16 - index * 8)
  })
  return out
}

/** The drawn colour of one building. Styling only: nothing about it can be looked up as a fact. */
export function buildingColor(
  archetype: BuildingArchetype,
  character: DistrictCharacter | undefined,
  tint?: number,
): number {
  const base = character ? CHARACTER_TINTS[character][archetype] : ARCHETYPE_COLORS[archetype]
  if (tint === undefined) return base
  // A parcel with no measured size is left alone. Its wireframe grey is how the map says "unknown",
  // and a neighbourhood hue washed over it would make it look like an ordinary building.
  if (archetype === 'vacant') return base
  return tintPreservingLuma(base, tint, NEIGHBORHOOD_TINT_WEIGHT)
}

/** The same building's flattened plate on the basemap. */
export function mapBuildingColor(archetype: BuildingArchetype, plate: number, tint?: number): number {
  if (tint === undefined || archetype === 'vacant') return plate
  return tintPreservingLuma(plate, tint, MAP_NEIGHBORHOOD_TINT_WEIGHT)
}

/** Rec. 709 relative luminance of a packed sRGB colour, on the same 0-255 scale as its channels. */
export function relativeLuma(color: number): number {
  return luma(color)
}

/*
 * How a building whose statistics the engine is owed an update on is drawn.
 *
 * The first version of this was a single 35% blend of the body colour toward a mid grey, and
 * measured against a real instance it was invisible: a stale tower stood beside two fresh ones and
 * no reader could pick it out, because the neighbourhood tint already spans a wider range than the
 * blend moved the facade. Windows, trim and roof all stayed pristine, so the only thing that changed
 * was a fraction of one of the several colours a building is made of.
 *
 * What follows is deliberately not a stronger version of the same single cue. Three separate parts
 * of the building change together, so the read survives distance, a low sun and a dark district:
 * the facade takes on grime, the glazing goes out, and the trim dulls. Any one of them alone is a
 * shade; all three at once is a derelict building.
 *
 * It stays an honest per-object claim. Nothing here is drawn from a threshold anyone tuned by eye —
 * an object is weathered exactly when the engine's own AUTO_UPDATE_STATISTICS threshold has been
 * passed on at least one of its statistics, and never otherwise.
 */

/** Soot and dirt: warm, very dark and nearly neutral, so the blend both darkens and desaturates. */
const WEATHERED_GRIME = 0x2e2a25

/**
 * How much grime reaches a facade.
 *
 * Past half, which is what makes it a different building rather than a darker one. The facade
 * palette is only a style, so there is nothing measured to preserve here — unlike
 * {@link tintPreservingLuma}, which exists precisely to protect that palette's value structure from
 * the neighbourhood hue. Weathering is the one blend that is *supposed* to spend brightness.
 */
const WEATHERED_BODY_WEIGHT = 0.58

/**
 * The same on the basemap, held back a little.
 *
 * Map plates carry the neighbourhood, and a plate blended as hard as a lit facade lands on the same
 * near-black whatever schema it belongs to, which trades one reading for another. This is still far
 * past the point of being obvious on paper.
 */
const WEATHERED_MAP_WEIGHT = 0.46

/** Lit glazing: the pale cold glass every healthy building on the map is fenestrated with. */
export const BUILDING_WINDOW_COLOR = 0xd8e8f4
/** The light behind that glass. */
export const BUILDING_WINDOW_EMISSIVE = 0x2f4f6a
/** Clean trim: the light grey ledges and parapets. */
export const BUILDING_TRIM_COLOR = 0x93a1ae

/**
 * Boarded windows.
 *
 * Not "dark glass", which at a distance is indistinguishable from glass in shadow, and not black,
 * which would merge the fenestration into the grimy facade and leave a featureless slab. Weathered
 * plywood is *lighter* than the dirty body it sits in, so the window grid stays visible while
 * reading as plainly not glass — a warm, flat, dead pattern where every neighbour has a cold, lit one.
 */
export const WEATHERED_WINDOW_COLOR = 0x6f5c44
/** Boards emit nothing. The lights being out is half of what makes the building read as abandoned. */
export const WEATHERED_WINDOW_EMISSIVE = 0x000000
/** Trim that has not been painted in a long time. */
export const WEATHERED_TRIM_COLOR = 0x5c564c

/** The grimed facade of a building whose statistics are past the engine's update threshold. */
export function weatheredBuildingColor(color: number): number {
  return mixColor(color, WEATHERED_GRIME, WEATHERED_BODY_WEIGHT)
}

/** The same building's flattened plate on the basemap. */
export function weatheredMapBuildingColor(plate: number): number {
  return mixColor(plate, WEATHERED_GRIME, WEATHERED_MAP_WEIGHT)
}
