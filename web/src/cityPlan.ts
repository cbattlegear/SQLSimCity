import { stableHash } from './atlasLayout'
import { makeBlockWarp, type CityWarp } from './cityBlockWarp'
import { buildBlocks, type CityBlock, type CityBlockField } from './cityBlocks'
import { planField } from './cityField'
import {
  breakCrossings,
  buildPlanarGraph,
  connectComponents,
  extractFaces,
  type GraphNode,
  type PlanarGraph,
} from './cityGraph'
import { FACILITY_LABELS, FACILITY_ORDER, type FacilityKind, type FacilitySite } from './cityInfrastructure'
import { classifyRoads, RoadRouter, type RoadClass, type RoadProperties } from './cityRouting'
import { mulberry32, seededShuffle } from './citySeed'
import { traceStreamlines, type Point } from './cityStreamlines'
import {
  planLandform,
  planTerrain,
  riverExclusion,
  riverProximity,
  waterBlocks,
  type CityTerrain,
  type Landform,
  type RiverNode,
} from './cityTerrain'
import type { DatabaseCityObject, DatabaseCitySchema } from './databaseCityContracts'

/**
 * Deterministic town plan for one database city.
 *
 * The city is *scattered* — buildings and infrastructure are spread across the whole block grid
 * rather than packed into contiguous rectangles — but it is not random. Every position comes from a
 * generator seeded with the database's own id, so the same database produces byte-identical
 * placement on every load, in every browser, on every machine. Scatter is a look, not a lottery.
 *
 * Placement derives only from that seed and from the backend's stable layout ordinals
 * (`layout.neighborhoodOrdinal` / `layout.objectOrdinal`), never from the order rows happen to
 * arrive in. This preserves the architectural rule that database-city layout is deterministic and
 * independent of source row order, and it keeps a building on the same lot when a later bounded page
 * is appended.
 *
 * Only building footprint and height carry a quantity claim (both documented logarithmic mappings of
 * exact 8-KiB page counts). The archetype selected here changes *style* only -- a house and a
 * skyscraper of identical page counts would occupy identical volume -- so decorative geometry never
 * encodes evidence.
 */

/** Style family for a building. Selected from exact reserved page counts; never a quantity claim itself. */
export type BuildingArchetype =
  | 'house'
  | 'rowhouse'
  | 'midrise'
  | 'tower'
  | 'skyscraper'
  | 'civic'
  | 'vacant'

/**
 * Cartographic weight of a street. Never a measurement — road *class* is styling, exactly as it is on
 * a printed basemap, while the quantities a road carries live in its traffic ribbon.
 *
 * These are the six classes {@link classifyRoads} derives from the street network's own shape: a
 * `motorway` is the edge the most through-routes lean on, a `service` road the least. The class
 * steers routing (a car prefers the faster road) and the carriageway a street is drawn with, and
 * nothing else — two roads carrying identical query traffic look identical whatever their class.
 */
export type StreetClass = RoadClass

/** Which way a lot fronts. `rotationY` is the Y rotation that turns a +Z-facing model toward its street. */
export type Facing = 'north' | 'south' | 'east' | 'west'

export interface CityIntersection {
  readonly id: string
  readonly col: number
  readonly row: number
  readonly x: number
  readonly z: number
}

export interface CityStreet {
  readonly id: string
  readonly fromId: string
  readonly toId: string
  readonly streetClass: StreetClass
  /**
   * Legacy hint at a street's straight-line bearing: `x` for mostly east-west, `z` for mostly
   * north-south, `d` for anything nearer a diagonal. The network is no longer a lattice, so this is a
   * coarse label kept only for consumers that still bucket streets by axis; the drawn shape is `path`.
   */
  readonly axis: 'x' | 'z' | 'd'
  readonly width: number
  readonly fromX: number
  readonly fromZ: number
  readonly toX: number
  readonly toZ: number
  /**
   * The drawn centre line, following the street's curve and always starting at `from` and ending at
   * `to`.
   *
   * The streets are streamlines of a tensor field rather than lattice edges, so a road genuinely
   * curves; the route, the lane offsets and the dash phase all consume this polyline, so a car, a
   * wait lane and the road under them agree.
   *
   * The shape is decoration. The endpoints, the connectivity and everything a road *carries* are
   * untouched by it.
   */
  readonly path: readonly Point[]
  /** True where the street crosses open water and is drawn as a bridge deck. */
  readonly bridge: boolean
}

export interface CityLot {
  readonly objectId: string
  readonly districtId: string
  readonly blockId: string
  /**
   * The id of the block this lot sits on, carried in the legacy `blockCol`; `blockRow` is always 0.
   * A block is a face of the street graph now, not a lattice cell, so the pair is an opaque handle the
   * warp adapter resolves back to a polygon rather than a grid coordinate.
   */
  readonly blockCol: number
  readonly blockRow: number
  /** Building centre in world units. */
  readonly x: number
  readonly z: number
  /** Y rotation that turns the model's +Z front toward its frontage street. */
  readonly rotationY: number
  readonly facing: Facing
  /** Point on the frontage street kerb that this building is entered from; the GPS route stops here. */
  readonly accessX: number
  readonly accessZ: number
  readonly frontageStreetId: string
  readonly lotSize: number
  /** Documented logarithmic mapping of exact reserved 8-KiB pages, or null when size is unknown. */
  readonly footprint: number | null
  /** Documented logarithmic mapping of exact used 8-KiB pages, or null when size is unknown. */
  readonly height: number | null
  readonly archetype: BuildingArchetype
  /** Stable per-object seed for decorative variation only. */
  readonly seed: number
}

export interface CityDistrict {
  readonly districtId: string
  readonly name: string
  readonly neighborhoodOrdinal: number
  readonly kind: 'schema' | 'civic'
  readonly objectCount: number
  /**
   * The blocks this schema's neighbourhood claims, whether or not a loaded object stands on one.
   *
   * Claimed from the schema's full object count, so the shape of a neighbourhood is settled before
   * its tables arrive and does not shift underneath them as pages load.
   */
  readonly blocks: readonly BlockRef[]
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
  readonly centerX: number
  readonly centerZ: number
  /** Where the neighbourhood's name is written: the middle of the ground it owns. */
  readonly labelX: number
  readonly labelZ: number
}

export interface CityBounds {
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
  readonly centerX: number
  readonly centerZ: number
  readonly width: number
  readonly depth: number
}

export interface CityPlan {
  readonly cell: number
  readonly streetWidth: number
  readonly blockCols: number
  readonly blockRows: number
  readonly districts: readonly CityDistrict[]
  readonly lots: ReadonlyMap<string, CityLot>
  readonly intersections: ReadonlyMap<string, CityIntersection>
  readonly streets: readonly CityStreet[]
  readonly bounds: CityBounds
  /**
   * Landform, water and land use.
   *
   * Entirely decorative and documented as such in `cityTerrain`. It is carried on the plan because
   * every consumer that draws the ground needs it, not because it says anything about the database.
   */
  readonly terrain: CityTerrain
  /**
   * Where the CPU / memory / storage / tempdb / log / lock facilities stand.
   *
   * Facilities are scattered across the grid rather than gathered into one civic quarter, because a
   * single infrastructure block turns into a corner of the map you look at once. Spread out, they
   * become landmarks you navigate by — and a route to a table genuinely passes them.
   */
  readonly facilities: ReadonlyMap<FacilityKind, FacilitySite>
  /**
   * Resolves a block id to its polygon, centre and frontage in world units.
   *
   * Carried on the plan because a block is a face of the street graph now, and the mapping from its id
   * back to ground is a lookup into the block field, not a multiplication anyone downstream can repeat
   * for themselves. See `cityBlockWarp`.
   */
  readonly warp: CityWarp
  /**
   * The routing engine over this city's streets: travel-time shortest paths with turn penalties.
   *
   * Carried on the plan so a route can be asked for without rebuilding the graph, and because the
   * graph is an internal of planning that no consumer should have to reconstruct. Decoration, like the
   * road classes it routes over — it changes which streets a car prefers, never what any street
   * measures.
   */
  readonly router: RoadRouter
  /**
   * The street graph the router and blocks were built from, and the road class of every edge.
   *
   * Carried on the plan so query traffic can be *assigned* to the network — loaded route by route so
   * congested streets push later journeys onto parallel ways — without rebuilding the graph the plan
   * already holds. Both are seed-derived scenery: assignment reads them to place ribbons and never
   * writes back, so the same database always draws the same streets and the same road classes.
   */
  readonly graph: PlanarGraph
  readonly roadProperties: ReadonlyMap<number, RoadProperties>
}

/** Options that make a plan reproducible and stable as bounded pages arrive. */
export interface CityPlanOptions {
  /**
   * Seed source for the scatter. The database id, so a database's layout is the same everywhere.
   * Two databases with identical shapes still get different cities, which is the point.
   */
  readonly seed?: string
  /**
   * Total object count for the whole database, from `page.totalObjects`.
   *
   * The grid is sized from this rather than from the loaded count, which is what stops the city
   * from being re-planned — and every building from moving — the moment a second page arrives.
   */
  readonly totalObjects?: string | number | null
  /**
   * All schemas in the database with their full object counts, from `page.schemas`.
   *
   * Every page carries the complete schema list, so these counts give each object a global slot
   * index that does not depend on which page it arrived on. Without them the slot index is derived
   * from the loaded objects alone, which is only stable once everything is loaded.
   */
  readonly schemas?: readonly DatabaseCitySchema[]
}

/**
 * Lots per block. One building stands alone on its own block, ringed by street on every side.
 *
 * Blocks used to hold eight buildings in two back-to-back rows, which read as an undifferentiated
 * mass of geometry: the only thing separating one building from the next was the gap between two
 * boxes. Giving every building its own block moves that separation into the street lattice itself.
 * Neighbourhood tints then do a different job — they group buildings rather than divide them.
 *
 * This costs roughly 1.7x the ground area per building -- a lot plus its share of the surrounding
 * street, rather than a lot plus a shared eighth of one. That is the price of the separation and it
 * is paid deliberately.
 */
export const BLOCK_COLS = 1
export const BLOCK_ROWS = 1
export const CELLS_PER_BLOCK = BLOCK_COLS * BLOCK_ROWS

/**
 * Carriageway widths, in world units.
 *
 * Scenery, and scaled with the street *spacing* rather than fixed: a road is wide relative to the
 * block it runs between, and the two numbers only stay in proportion if they move together. When the
 * centre-line spacing was 2.2 cells an ordinary street at 15 was about a fifth of the gap between two
 * of them. {@link SEPARATION_PER_CELL} is now 1.5, so holding 15 would have handed a third of the
 * ground back to tarmac — and, because a block is dropped when it cannot stand its building clear of
 * the widest carriageway that fronts it, would have thinned the supply of blocks below one per table.
 * Ten and fifteen keep the old road-to-block proportion at the new spacing.
 */
export const STREET_WIDTH = 10
export const ARTERIAL_WIDTH = 15
/**
 * Clear ground a block keeps around its building, split evenly on all four sides.
 *
 * This is the verge: the pavement, the street trees and the front garden. Because `chooseCell` sizes a
 * cell as `footprint + LOT_MARGIN` and planning drops any block that cannot hold a square that wide,
 * the block a building lands on always has room for it, so a building edge never reaches its kerb.
 *
 * The verge is an *absolute* width added to a footprint the logarithmic mapping keeps small, so it is
 * the largest term in the cell for every ordinary building: at sixteen, a mean building of fifteen
 * units was given a cell of thirty-one and covered under a quarter of it before the street spacing
 * multiplied that gap again. Ten is a pavement and a front garden either side rather than a paddock,
 * and it is still twice {@link BLOCK_SETBACK}, so the kerb clearance the verge exists for survives.
 */
export const LOT_MARGIN = 10
export const MIN_CELL = 20

/** Footprint and height used for an object whose page counts are unavailable. Nonquantitative by design. */
export const UNKNOWN_FOOTPRINT = 11
export const UNKNOWN_HEIGHT = 8

/** Reserved-page thresholds that select a building's style family. Exact page counts, never rounded. */
export const ARCHETYPE_THRESHOLD_PAGES = {
  house: 128n, // < 1 MiB
  rowhouse: 2048n, // < 16 MiB
  midrise: 32768n, // < 256 MiB
  tower: 524288n, // < 4 GiB
} as const

/**
 * Block spacing at the city centre, as a multiple of the cell.
 *
 * The tracer spaces its streets by this at the centre, then lets the field noise drift it by about a
 * third either way and grows it toward the edge, so the tightest block is roughly two-thirds of it
 * across. Sized so even that tightest block still inscribes a square wider than the largest building —
 * the capacity filter drops any that does not — with the verge to spare. Larger only wastes ground;
 * smaller and the filter starts discarding blocks the city needs.
 *
 * At 2.2 the drawing was mostly ground. A traced face comes out at roughly 1.6 separations across
 * rather than one — the tracer only guarantees streamlines are *at least* a separation apart — and
 * {@link EDGE_SEPARATION_SCALE} widened everything outside the centre again. Measured over a
 * 120-object city the median block was 144 units across against a mean building of 15, so a building
 * covered **0.86% of its own block** and the city read as huts scattered on open moor.
 *
 * 1.5 is the tightest value that keeps the capacity filter's guarantee arithmetic rather than
 * empirical. The tightest block is about two-thirds of a separation, so it inscribes roughly
 * `(2/3) × 1.5 × (widest + LOT_MARGIN)` = `widest + LOT_MARGIN`, still clear of the
 * `widest + BLOCK_CAPACITY_HEADROOM` the filter demands, for any building the mapping can produce.
 * Below 1.5 that margin goes negative and the filter starts discarding blocks the city needs.
 */
const SEPARATION_PER_CELL = 1.5

/** Never trace streets tighter than this, however small the buildings, so a small city still reads. */
const SEPARATION_FLOOR = 34

/** The verge between a block's kerb and its buildable ground, in world units. */
const BLOCK_SETBACK = 5

/**
 * The narrowest square a block must inscribe to survive planning, above the widest building.
 *
 * A block that cannot hold the widest footprint is dropped rather than kept and overhung, so a
 * building never spills into the carriageway around it. Floored so a database of only tiny tables
 * still gets blocks with room to stand a building clear of its kerb.
 *
 * Capacity is measured on the *buildable* ring, which is already pulled {@link BLOCK_SETBACK} in off
 * the centre lines, so the clearance a building actually has from the nearest carriageway centre line
 * is `capacity / 2 + BLOCK_SETBACK`. For that to clear the widest carriageway the network can draw —
 * an {@link ARTERIAL_WIDTH} motorway, whose kerb is half that from its centre line — the headroom has
 * to be `ARTERIAL_WIDTH - 2 × BLOCK_SETBACK`, and the floor has to sit above the same figure.
 *
 * A headroom of 2 was never sufficient for that; it went unnoticed only because blocks were traced so
 * much wider than the buildings on them that no block near the floor was ever reached. Tightening the
 * street spacing brings blocks near the floor into use, and an arterial promptly clipped five
 * buildings across two seeded cities. Derived rather than tuned, so it cannot drift out of step with
 * the carriageway table again.
 */
const BLOCK_CAPACITY_HEADROOM = ARTERIAL_WIDTH - 2 * BLOCK_SETBACK
const BLOCK_CAPACITY_FLOOR = 12

/**
 * City radius per root object, in separations.
 *
 * A disc of streets yields blocks in proportion to its area, so radius grows with the square root of
 * the object count and the block count grows about linearly with it — the role the grid side played.
 *
 * The constant is the number of blocks each building gets to choose from, and it has to be comfortably
 * above one. Below one there is not enough ground in the city for its own tables: the surplus
 * buildings are put on a block another building already holds, and because a lot is placed at its
 * block's centroid they are drawn at exactly the same point, one hidden inside the other. A table you
 * cannot see is a table whose evidence is lost.
 *
 * Measured rather than estimated, because the estimate was wrong. A traced block was assumed to cost
 * about 1.34 separations squared, which put this at two blocks per building. Counting the blocks that
 * actually survive — after the water, the civic facilities and every face too small to hold the widest
 * building are taken out — gives **0.63 blocks per building at 1.0**, so more than a third of every
 * city was stacked invisibly. 1.75 is the value that estimate was originally reduced *from*, and it
 * measures at about 1.9 blocks per building: enough ground for every table, with roughly a third of
 * the city left open for the parks, yards and vacant parcels the map draws — and for the tables the
 * database has not created yet.
 */
const RADIUS_PER_ROOT_OBJECT = 1.75

/**
 * Smallest city radius, in separations, so a handful of tables still gets a walkable town.
 *
 * This has to sit above what the per-object term would give a small database, because the blocks a
 * disc yields fall off with its area while the buildings that must stand on them do not: a nine-table
 * city that loses a third of its ground has fewer blocks left than tables, and two buildings end up
 * sharing a block. Nine separations keeps every city up to about seventy-five objects at least as
 * roomy as it was when the per-object term was larger.
 */
const RADIUS_FLOOR_STEPS = 9

/**
 * How much a database has to grow before its city is rebuilt.
 *
 * The street network is traced from the database's shape, so any quantity that feeds it makes the
 * whole city a function of that quantity: at 1.0 the radius moved on every single added table, and
 * past the point where the floor above stops winning, adding one table retraced every street and
 * moved every building (#47). A city you have to relearn on every deployment is not a map.
 *
 * So the city is not sized from the database, it is sized from the next rung of a ladder above it,
 * and it only rebuilds when the database climbs a rung. A quarter more room per rung is small enough
 * that the city is never wildly bigger than the database in it, and large enough that a database has
 * to grow by a quarter -- not by one table -- before the ground moves.
 *
 * This is the whole trade. Growth cannot be both continuous and stable: either every table redraws
 * the map a little, or the map holds still and redraws rarely. A map has to hold still.
 */
const GROWTH_RATIO = 1.25

/**
 * The rung every city starts on, matched to {@link RADIUS_FLOOR_STEPS}.
 *
 * The radius floor holds every city below about twenty objects at one size, so the ladder starts
 * exactly where the floor stops winning. Below this the city was already stable and the ladder would
 * only make it coarser for nothing.
 */
const GROWTH_FLOOR_OBJECTS = 20

/**
 * The rung a *neighbourhood* starts on.
 *
 * Far lower than the city's, because a schema's share of the ground is relative and quantising
 * destroys exactly that. A floor of eight would hand a one-table schema and an eight-table schema
 * identical territory, which reads as a map that has stopped telling the truth about which schema is
 * the large one — worse than the churn it prevents. Three is low enough that schemas stay ranked by
 * size from the smallest database upward, and still spares a schema of one or two tables from having
 * its borders redrawn the moment it gains another.
 */
const GROWTH_FLOOR_SCHEMA = 3

/**
 * How much a *schema* has to grow before its neighbourhood is widened.
 *
 * Coarser than the city's ladder, because a neighbourhood is the one thing the city ladder cannot
 * hold still on its own: widening one schema's territory hands it blocks that were vacant, and the
 * buildings already inside it choose their ground from the blocks the neighbourhood holds. So a
 * schema crossing a rung shuffles that schema — never the city, and never another schema, now that
 * quotas no longer divide a fixed pool between them.
 *
 * At half again per rung, and with half again more blocks than tables in each neighbourhood, a schema
 * runs out of vacant plots at about the same time it earns more ground. That is the point: the
 * territory is widened when the schema genuinely needs it rather than on a fixed cadence.
 */
const SCHEMA_GROWTH_RATIO = 1.5

/**
 * How coarsely the largest building's footprint is read, in world units.
 *
 * The block spacing and the minimum block size are both derived from the widest building, so reading
 * that width exactly makes the entire street network a function of the largest table's page count --
 * and tables gain pages constantly. Rounding up to a step of this size means the city holds still
 * unless its largest table grows by roughly forty times, which is a genuinely different database.
 *
 * Only ever rounded *up*: a block must still hold the widest building it is asked to hold.
 */
const FOOTPRINT_STEP = 4

/**
 * The next rung at or above `count`.
 *
 * Walked rather than solved with a logarithm, because `Math.log` lands a hair either side of an
 * exact rung and would put a database sitting precisely on one onto the rung above -- so the city
 * would depend on floating-point noise. The `+ 1` floor keeps the ladder strictly increasing at
 * small counts where a quarter of the value rounds to nothing.
 */
export function plannedCount(count: number, floor: number, ratio: number = GROWTH_RATIO): number {
  const wanted = Number.isFinite(count) ? Math.max(0, Math.ceil(count)) : 0
  let planned = Math.max(1, floor)
  while (planned < wanted) planned = Math.max(planned + 1, Math.round(planned * ratio))
  return planned
}

/**
 * The widest building the city is planned around, rounded up to {@link FOOTPRINT_STEP}.
 *
 * Read from the loaded objects, because no page states the widest object in the database. Rounding
 * absorbs both a table gaining pages and most of the difference between one page and the next; a
 * later page carrying a far larger table than anything seen so far can still step the city up a
 * rung, which is the honest limit of planning from a bounded page.
 */
function plannedFootprint(objects: readonly DatabaseCityObject[]): number {
  return Math.max(
    UNKNOWN_FOOTPRINT,
    Math.ceil(widestFootprint(objects) / FOOTPRINT_STEP) * FOOTPRINT_STEP,
  )
}

/** How far past the field radius streamlines may run, so the network reaches the map edge. */
const SPAN_SCALE = 1.1

/**
 * How much wider block spacing grows from centre to edge, handed to the streamline tracer.
 *
 * A real city does loosen toward its edge, so this is not one. But at 2.3 the outer ring — which is
 * most of a disc's area, and so most of the blocks anyone actually sees — was traced at more than
 * twice the centre's spacing, and a building standing on one of those blocks was a speck on a field.
 * 1.35 keeps the gradient legible while leaving the periphery recognisably the same city as the
 * middle.
 */
const EDGE_SEPARATION_SCALE = 1.35

/** Shortest streamline kept, in separations: anything shorter is tracing noise, not a street. */
const MIN_STREAMLINE_STEPS = 1.45

/** Ceiling on streamlines traced, so a very large database still plans in bounded time. */
const MAX_STREAMLINES = 900

/**
 * Graph welding, snapping and stub tolerances, as fractions of the local separation.
 *
 * The snap radius is how far a dangling streamline end may reach to join the network. A tight reach
 * left whole clusters of streets stranded as separate islands, and a route between two tables that
 * happened to land on different islands then silently failed; a radius wider than the separation lets
 * a stray end find the nearest way instead. The stub minimum is the shortest cul-de-sac worth keeping:
 * below it a stub is a streamline that petered out in open ground rather than a street anyone drives,
 * so trimming at a larger fraction clears the dead ends the wider snap would otherwise leave behind.
 */
const WELD_FRACTION = 0.12
const SNAP_FRACTION = 1.25
const STUB_FRACTION = 0.6

/**
 * How aggressively the crossing-breaker turns four-way junctions into staggered T-junctions.
 *
 * A pure streamline graph meets mostly at crossroads, which read as a grid however the streets
 * curve; nudging a quarter of them into T-junctions and merging the odd tiny block is what gives the
 * plan an organic street pattern. The protected length and block area are in separations, so the
 * breaker leaves the arterials and the large blocks alone whatever the city's scale.
 *
 * The block-area ceiling is generous because a city sized to hold all its tables is a wide disc of
 * streets, and its interior blocks are correspondingly large. A tighter ceiling protected those
 * interior crossings from the breaker, so the four-way share climbed back toward a grid's as the
 * database grew; at twelve squared-separations the breaker reaches them and the junction mix holds
 * steady at roughly a quarter crossroads whatever the city's size.
 */
const CROSSROAD_TARGET_SHARE = 0.24
const CROSSING_PROTECT_STEPS = 7
const CROSSING_MAX_REMOVAL_SHARE = 0.3
const CROSSING_MAX_MERGED_BLOCKS = 3
const CROSSING_MAX_BLOCK_AREA_STEPS = 12

/**
 * Carriageway width drawn for each road class, in world units.
 *
 * Decoration, keyed on the decorative road class rather than on anything a street carries: `tertiary`
 * is the ordinary {@link STREET_WIDTH} street, a `motorway` the widest and a `service` road the
 * narrowest. Two roads with the same class are drawn identically whatever their query traffic, which
 * lives in the separate traffic ribbon.
 */
const CARRIAGEWAY_WIDTH: Readonly<Record<RoadClass, number>> = {
  motorway: ARTERIAL_WIDTH,
  primary: 13,
  secondary: 11,
  tertiary: STREET_WIDTH,
  residential: 8,
  service: 6,
}

/** How far one straight-line bearing must dominate the other before a street is called `x` or `z`. */
const AXIS_BIAS = 1.8

/** A bridgeable gap is left in the river exclusion every N separations, each this many wide. */
const BRIDGE_SPACING_STEPS = 4
const BRIDGE_GAP_STEPS = 1.6

/** Least distance between two facilities, in separations, so each reads as its own landmark. */
const FACILITY_SEPARATION_STEPS = 2.5

/**
 * How many seeded attempts to make at a spaced facility layout before falling back.
 *
 * Each attempt is a greedy pass over a freshly shuffled block list, which is a random maximal
 * independent set — usually successful on the first or second try at these grid sizes. The cap
 * exists so an adversarially small grid terminates instead of spinning.
 */
const FACILITY_PLACEMENT_ATTEMPTS = 32

/**
 * Building footprint in world units from exact reserved 8-KiB pages.
 * `6 + log2(1 + pages) * 0.75` -- a doubling of reserved pages widens the building by 0.75 units.
 */
export function buildingFootprint(reservedPages8KiB: string | null): number | null {
  const pages = pageCount(reservedPages8KiB)
  if (pages === null) return null
  return 6 + Math.log2(1 + pages) * 0.75
}

/**
 * Building height in world units from exact used 8-KiB pages.
 * `log2(1 + pages) * 4.8` -- zero used pages is zero height, and every doubling adds 4.8 units.
 * Deliberately unclamped so the mapping stays strictly monotonic in the measured value.
 */
export function buildingHeight(usedPages8KiB: string | null): number | null {
  const pages = pageCount(usedPages8KiB)
  if (pages === null) return null
  return Math.log2(1 + pages) * 4.8
}

/** Style family for one object. Unknown size is always `vacant`, which makes no quantity claim. */
export function buildingArchetype(object: DatabaseCityObject): BuildingArchetype {
  if (object.reservedPages8KiB === null || object.usedPages8KiB === null) return 'vacant'
  if (object.kind === 'IndexedView') return 'civic'
  let pages: bigint
  try {
    pages = BigInt(object.reservedPages8KiB)
  } catch {
    return 'vacant'
  }
  if (pages < ARCHETYPE_THRESHOLD_PAGES.house) return 'house'
  if (pages < ARCHETYPE_THRESHOLD_PAGES.rowhouse) return 'rowhouse'
  if (pages < ARCHETYPE_THRESHOLD_PAGES.midrise) return 'midrise'
  if (pages < ARCHETYPE_THRESHOLD_PAGES.tower) return 'tower'
  return 'skyscraper'
}

export function planCity(
  objects: readonly DatabaseCityObject[],
  options: CityPlanOptions = {},
): CityPlan {
  const seed = options.seed ?? 'sqlsimcity'
  const numericSeed = stableHash(seed)
  const widest = plannedFootprint(objects)
  const cell = chooseCell(widest)

  const ordered = orderObjects(objects)
  const sizes = schemaSizes(ordered, options.schemas)
  /*
   * How many buildings the city has to have room for.
   *
   * Read from the database's own total, never from what has loaded. This is the one number the
   * street network is sized from, so it has to be the same on every page or the streets retrace
   * themselves under a city that is already on screen — and every building moves with them.
   *
   * Slot indices deliberately do not get a vote. A slot is a global ordinal handed out by the
   * collector, and the connected collector numbers objects across the whole database rather than
   * within a schema, so adding a schema's offset to one produces indices far past the object count
   * — and different ones on every page. Letting those size the city is what made a second page
   * redraw it. Nothing needs them to: nothing in the plan reads a collector ordinal any more.
   *
   * Then rounded up to the next rung of the growth ladder, so the city is sized from a database of
   * roughly this shape rather than from this exact database. That is what lets a table be added
   * without the streets being retraced under the buildings already standing on them.
   */
  const capacity = plannedCount(
    Math.max(parseCount(options.totalObjects) ?? 0, ordered.length),
    GROWTH_FLOOR_OBJECTS,
  )

  /*
   * The street network is settled before anything is placed on it.
   *
   * The field, its streamlines, the graph they weave and the blocks that graph cuts depend only on
   * the seed and two scalars read from the database's shape: how wide a block must be to hold the
   * largest building, and how far the city has to reach to hold them all. Nothing about which objects
   * have loaded touches them, which is what keeps an appended page from redrawing the streets under a
   * city that is already on screen.
   *
   * Because that is true, it is also worth not doing twice. A city is replanned every time a page of
   * objects arrives — up to eighty times while a large database loads — and tracing the network is by
   * far the most expensive thing here. Keyed on exactly the inputs it reads, the groundwork is traced
   * on the first page and reused by every page after it, so the stability the ladder promises is what
   * makes the loading fast rather than something paid for with time.
   *
   * The key names every argument the trace reads, `widest` included, even though `cell` is derived
   * from `widest` and currently determines it. That derivation runs through a `MIN_CELL` clamp, so two
   * different widths would collide onto one key the moment the clamp ever bound — and a collision here
   * does not degrade the cache, it serves a city ground that was cut for a different building size.
   * Naming it costs no hit rate, because it only ever moves when `cell` does.
   */
  const groundwork = cityGroundwork(
    [
      seed,
      cell,
      capacity,
      widest,
      sizes.map(size => `${size.schemaId}:${size.count}`).join(','),
    ].join('|'),
    () => traceGroundwork(seed, numericSeed, cell, capacity, widest, sizes),
  )
  const {
    landform,
    graph,
    blockField,
    roads,
    router,
    warp,
    intersections,
    streets,
    water,
    facilityBlocks,
    facilityIds,
    neighbourhoodPool,
    territories,
  } = groundwork

  const lots = new Map<string, CityLot>()
  const occupied = new Set<number>()
  placeBuildings(ordered, territories, neighbourhoodPool, lots, occupied)

  // Districts describe territory as block references, the shape `describeDistricts` and every chrome
  // consumer already read, so the schema-to-ground mapping survives the move off the lattice.
  const territoryRefs = new Map<string, BlockRef[]>()
  for (const [schemaId, claimed] of territories) {
    territoryRefs.set(schemaId, claimed.map(block => ({ col: block.id, row: 0 })))
  }
  const districts = describeDistricts(ordered, lots, territoryRefs, warp)
  const terrain = planTerrain({
    field: blockField,
    landform,
    occupied,
    facilities: facilityIds,
    water,
    districtIds: districts.map(district => district.districtId),
    seed,
  })

  return {
    cell,
    streetWidth: STREET_WIDTH,
    blockCols: blockField.blocks.length,
    blockRows: 1,
    districts,
    lots,
    intersections,
    streets,
    bounds: cityBounds(warp),
    terrain,
    facilities: facilitySites(facilityBlocks, cell),
    warp,
    router,
    graph,
    roadProperties: roads,
  }
}

/**
 * Everything about a city that the database's *contents* cannot change: the land, the streets, the
 * blocks they cut and the neighbourhood each block belongs to.
 *
 * Held separately from the plan because it is both the expensive half and the stable half. Which
 * objects have loaded decides only which of these blocks has a building on it.
 */
interface CityGroundwork {
  readonly landform: Landform
  readonly graph: PlanarGraph
  readonly blockField: CityBlockField
  readonly roads: ReadonlyMap<number, RoadProperties>
  readonly router: RoadRouter
  readonly warp: CityWarp
  readonly intersections: Map<string, CityIntersection>
  readonly streets: CityStreet[]
  readonly water: ReadonlySet<number>
  readonly facilityBlocks: CityBlock[]
  readonly facilityIds: Set<number>
  readonly neighbourhoodPool: CityBlock[]
  readonly territories: Map<string, CityBlock[]>
}

/**
 * How many traced networks to keep.
 *
 * One would serve a single database loading its pages, which is the case that matters. A few more
 * costs little and covers moving between databases in the atlas and back, where retracing a city the
 * user has already seen is the most visible stall there is.
 */
const GROUNDWORK_CACHE_LIMIT = 4

const groundworkCache = new Map<string, CityGroundwork>()

function cityGroundwork(key: string, trace: () => CityGroundwork): CityGroundwork {
  const cached = groundworkCache.get(key)
  if (cached) {
    // Re-inserted so the most recently used city is the last one evicted.
    groundworkCache.delete(key)
    groundworkCache.set(key, cached)
    return cached
  }
  const traced = trace()
  groundworkCache.set(key, traced)
  for (const oldest of groundworkCache.keys()) {
    if (groundworkCache.size <= GROUNDWORK_CACHE_LIMIT) break
    groundworkCache.delete(oldest)
  }
  return traced
}

function traceGroundwork(
  seed: string,
  numericSeed: number,
  cell: number,
  capacity: number,
  widest: number,
  sizes: readonly SchemaSize[],
): CityGroundwork {
  const separation = Math.max(SEPARATION_FLOOR, cell * SEPARATION_PER_CELL)
  const radius = Math.max(
    separation * RADIUS_FLOOR_STEPS,
    separation * RADIUS_PER_ROOT_OBJECT * Math.sqrt(capacity + FACILITY_ORDER.length),
  )
  const span = radius * SPAN_SCALE

  // Landform is traced first so the streets can be kept out of the water. It runs on a generator of
  // its own, so adding a river never consumes from the placement stream and never moves a building.
  const landform = planLandform({
    seed,
    minX: -span,
    maxX: span,
    minZ: -span,
    maxZ: span,
    streetWidth: STREET_WIDTH,
    cell,
  })
  const excluded = riverExclusion(
    landform.river,
    separation * BRIDGE_SPACING_STEPS,
    separation * BRIDGE_GAP_STEPS,
  )

  const field = planField({ seed, centreX: 0, centreZ: 0, radius })
  const streamlines = traceStreamlines({
    field,
    minX: -span,
    maxX: span,
    minZ: -span,
    maxZ: span,
    separation,
    edgeSeparationScale: EDGE_SEPARATION_SCALE,
    minLength: separation * MIN_STREAMLINE_STEPS,
    maxStreamlines: MAX_STREAMLINES,
    excluded,
  })

  const graphOptions = {
    weldRadius: separation * WELD_FRACTION,
    snapRadius: separation * SNAP_FRACTION,
    minStub: separation * STUB_FRACTION,
  }
  let graph = breakCrossings(
    buildPlanarGraph(streamlines, graphOptions),
    {
      seed: numericSeed,
      targetCrossroadShare: CROSSROAD_TARGET_SHARE,
      protectLength: separation * CROSSING_PROTECT_STEPS,
      maxRemovalShare: CROSSING_MAX_REMOVAL_SHARE,
      maxMergedBlocks: CROSSING_MAX_MERGED_BLOCKS,
      maxBlockArea: separation * separation * CROSSING_MAX_BLOCK_AREA_STEPS,
    },
    graphOptions,
  )
  // Faces are recovered from the strictly planar graph, before any link road is added: a link road
  // can cross an existing street, and walking a block's boundary relies on that planarity holding.
  const faces = extractFaces(graph)
  const minCapacity = Math.max(BLOCK_CAPACITY_FLOOR, Math.ceil(widest) + BLOCK_CAPACITY_HEADROOM)
  const blockField = buildBlocks(graph, faces, { setback: BLOCK_SETBACK, minCapacity })

  // Tracing can leave a pocket of streets with no way in, where one district's grain turns hard
  // against its neighbour's and the seam gap outruns the snap radius. The pocket draws -- its streets
  // and blocks are all there -- but a query ribbon that has to reach into it silently fails to route.
  // connectComponents joins the pieces with the few shortest link roads that close the gaps. It runs
  // after the faces are taken, because a link may cross an edge and a face walk needs planarity, and
  // before anything routes, because the router and the traffic assignment need one navigable city. It
  // only appends edges, so every node id, edge index and block built above stays valid.
  graph = connectComponents(graph)
  const roads = classifyRoads(graph)
  const router = new RoadRouter(graph, roads)
  const warp = makeBlockWarp(blockField)
  const { intersections, streets } = buildStreets(graph, roads, landform.river)

  // Water is withheld from every placement pool, so no building or facility is ever put on the river.
  const water = waterBlocks(blockField, landform.river)
  const dry = blockField.blocks.filter(block => !water.has(block.id))

  /*
   * Facilities draw first, then the neighbourhoods take the ground that is left, then the buildings
   * stand on their own neighbourhood — the order the lattice city used. Facilities are spaced by world
   * distance rather than a block count now, because a block is no longer a fixed size.
   */
  const facilityBlocks = placeFacilities(dry, separation * FACILITY_SEPARATION_STEPS, numericSeed)
  const facilityIds = new Set(facilityBlocks.map(block => block.id))
  const neighbourhoodPool = dry.filter(block => !facilityIds.has(block.id))
  const territories = planNeighborhoods(neighbourhoodPool, sizes, seed, separation)

  return {
    landform,
    graph,
    blockField,
    roads,
    router,
    warp,
    intersections,
    streets,
    water,
    facilityBlocks,
    facilityIds,
    neighbourhoodPool,
    territories,
  }
}

/**
 * The intersection and street layers: one intersection per graph node, one street per graph edge.
 *
 * This is the whole bridge from the planar graph to the `CityPlan` shape every consumer already
 * speaks. A node's legacy `col`/`row` are its id and 0; a street's id is its edge id, so a block's
 * frontage edge resolves straight to a street. The drawn polyline is the edge's own curve, and the
 * carriageway width and the axis label are decoration derived from the edge, never from traffic.
 */
function buildStreets(
  graph: PlanarGraph,
  roads: ReadonlyMap<number, RoadProperties>,
  river: readonly RiverNode[],
): { intersections: Map<string, CityIntersection>; streets: CityStreet[] } {
  const intersections = new Map<string, CityIntersection>()
  for (const node of graph.nodes.values()) {
    const id = intersectionId(node.id, 0)
    intersections.set(id, { id, col: node.id, row: 0, x: node.x, z: node.z })
  }

  const streets: CityStreet[] = []
  for (const edge of graph.edges) {
    const from = graph.nodes.get(edge.fromId)
    const to = graph.nodes.get(edge.toId)
    if (!from || !to) continue
    const roadClass: RoadClass = roads.get(edge.id)?.roadClass ?? 'residential'
    streets.push({
      id: streetId(edge.id),
      fromId: intersectionId(edge.fromId, 0),
      toId: intersectionId(edge.toId, 0),
      streetClass: roadClass,
      axis: axisOf(from, to),
      width: CARRIAGEWAY_WIDTH[roadClass],
      fromX: from.x,
      fromZ: from.z,
      toX: to.x,
      toZ: to.z,
      path: edge.points,
      bridge: crossesWater(edge.points, river),
    })
  }
  return { intersections, streets }
}

/** The legacy axis label from a street's straight-line bearing; see the `axis` field on CityStreet. */
function axisOf(from: GraphNode, to: GraphNode): 'x' | 'z' | 'd' {
  const dx = Math.abs(to.x - from.x)
  const dz = Math.abs(to.z - from.z)
  if (dx > dz * AXIS_BIAS) return 'x'
  if (dz > dx * AXIS_BIAS) return 'z'
  return 'd'
}

/** True where any sample of a street's polyline falls inside the river channel. */
function crossesWater(points: readonly Point[], river: readonly RiverNode[]): boolean {
  if (river.length < 2) return false
  for (const point of points) {
    const { distance, halfWidth } = riverProximity(river, point.x, point.z)
    if (distance < halfWidth) return true
  }
  return false
}

function streetId(edgeId: number): string {
  return `street:${edgeId}`
}

/**
 * Stands every loaded object on a block: its own schema's ground where it has some, the city-wide
 * fallback where a schema was walled in before it claimed any.
 *
 * Two orders meet here, and both are append-only, which is the whole of the stability guarantee.
 *
 * Tables arrive in **catalogue order** — by the object id SQL Server issues increasing, compared as a
 * number rather than as text, so a table created later sorts after every table already there. Blocks
 * are offered in the order their neighbourhood **claimed** them, which region growth produces outward
 * from the neighbourhood's seed. Each arrival takes the first block still vacant.
 *
 * So a building's block depends only on the tables that arrived before it — never on how many blocks
 * the neighbourhood has, nor on how large its neighbours are. A new table can only take ground no
 * earlier table wanted, and widening a neighbourhood only appends blocks past everything already
 * spoken for. The old rule ranked tables by footprint and blocks by capacity, which had exactly the
 * opposite property: a new large table sorted to the front and renumbered every building behind it
 * (#47, #50).
 *
 * Matching a big table to a roomy block is given up to get this, and costs nothing that was load
 * bearing: planning already drops every block too small to hold the widest building in the city, so
 * no building can overhang its kerb wherever it stands. What is gained instead is a city that reads
 * as one: claim order runs outward from each neighbourhood's centre, so the oldest tables hold the
 * old town and each new one takes a plot further out, the way a town actually grows.
 *
 * Dropping a table is the one case that still moves buildings: its block falls vacant and the next
 * table along takes it. Only tables *after* the dropped one can move, never the ones before.
 */
function placeBuildings(
  ordered: readonly DatabaseCityObject[],
  territories: ReadonlyMap<string, CityBlock[]>,
  fallback: readonly CityBlock[],
  lots: Map<string, CityLot>,
  occupied: Set<number>,
): void {
  const bySchema = new Map<string, DatabaseCityObject[]>()
  for (const object of ordered) {
    const list = bySchema.get(object.schemaId)
    if (list) list.push(object)
    else bySchema.set(object.schemaId, [object])
  }

  for (const [schemaId, members] of bySchema) {
    const claimed = territories.get(schemaId) ?? []
    const ground = claimed.length > 0 ? claimed : fallback
    if (ground.length === 0) continue
    const arrivals = [...members].sort((left, right) =>
      compareCreationOrder(left.objectId, right.objectId),
    )

    arrivals.forEach((object, index) => {
      // A neighbourhood with fewer blocks than tables cannot give every building its own ground.
      // Doubling up keeps the building on the map, which matters more than it standing alone —
      // planning sizes the city so this does not arise, but a building is never dropped.
      const block = index < ground.length ? ground[index] : ground[index % ground.length]
      lots.set(object.objectId, placeLot(object, block))
      occupied.add(block.id)
    })
  }
}


/** The widest building the database asks for, so a block can be required to hold it. */
function widestFootprint(objects: readonly DatabaseCityObject[]): number {
  let widest = UNKNOWN_FOOTPRINT
  for (const object of objects) {
    const footprint = buildingFootprint(object.reservedPages8KiB) ?? UNKNOWN_FOOTPRINT
    if (footprint > widest) widest = footprint
  }
  return widest
}

/**
 * A representative street-to-street spacing, for chrome that needs one scale for the whole city.
 *
 * The network is no longer laid on a fixed pitch, so this is the nominal grain — a cell plus its
 * carriageway — not an exact one. Consumers that once quantised a curved road to this now key on
 * street id instead; what is left is sizing map furniture, like labels, to the city's grain.
 */
export function streetPitch(plan: Pick<CityPlan, 'cell'>): { x: number; z: number } {
  return {
    x: plan.cell + STREET_WIDTH,
    z: plan.cell + STREET_WIDTH,
  }
}

/** Id of the intersection nearest a world point, for entering the street graph. */
export function nearestIntersectionId(plan: CityPlan, x: number, z: number): string {
  let bestId = ''
  let bestDistance = Infinity
  for (const intersection of plan.intersections.values()) {
    const distance = (intersection.x - x) ** 2 + (intersection.z - z) ** 2
    if (distance < bestDistance) {
      bestDistance = distance
      bestId = intersection.id
    }
  }
  return bestId
}

/**
 * Shortest street-following path between two intersections, as an ordered list of intersection ids.
 *
 * Delegated to the plan's {@link RoadRouter}, which minimises travel time — road class sets a speed
 * limit, and a turn costs a moment — rather than raw distance, so the route a car takes is the one a
 * driver would choose. The id-in, id-out shape is unchanged, so `cityRoute` and its callers keep
 * working; an intersection's `col` is its graph node id, which is what the router routes between.
 */
export function streetPath(plan: CityPlan, fromId: string, toId: string): string[] {
  const from = plan.intersections.get(fromId)
  const to = plan.intersections.get(toId)
  if (!from || !to) return []
  if (fromId === toId) return [fromId]
  const route = plan.router.route(from.col, to.col)
  if (!route) return []
  return route.nodeIds.map(id => intersectionId(id, 0))
}

/**
 * World-space polyline that visits every waypoint in order, following streets the whole way.
 *
 * Used by shared wait lanes, which must thread through each object a multi-object query family names
 * before running out to its facility: one continuous path, drawn once, so the family's whole wait
 * total is never duplicated across the buildings it touches. Consecutive duplicate points are
 * dropped where one leg ends exactly where the next begins, so the joins are seamless.
 *
 * Fewer than two waypoints describes no journey, so the result is empty rather than a degenerate
 * point: a lane with nowhere to go is not drawn at all.
 */
export function streetPolylineThrough(
  plan: CityPlan,
  waypoints: ReadonlyArray<{ x: number; z: number }>,
): Array<{ x: number; z: number }> {
  if (waypoints.length < 2) return []
  const points: Array<{ x: number; z: number }> = []
  for (let index = 0; index < waypoints.length - 1; index += 1) {
    for (const point of streetPolyline(plan, waypoints[index], waypoints[index + 1])) {
      const last = points[points.length - 1]
      if (last && last.x === point.x && last.z === point.z) continue
      points.push(point)
    }
  }
  return points
}

/**
 * World-space polyline from one point to another that only ever travels along street centre lines.
 *
 * A building is entered from its frontage kerb, which sits on a street centre line already, so the
 * connector at each end runs straight from the kerb to the nearest junction — along the frontage
 * street, not across the block. The lattice used an axis-aligned elbow there to keep the dogleg
 * orthogonal, but on a bowed or diagonal street that corner cut across the block instead of hugging
 * the road, so it is gone.
 *
 * Between the two connectors the route follows each street's drawn centre line rather than the
 * straight line between intersections, so a car on a bowed collector, an embankment road or a
 * diagonal avenue stays on the carriageway instead of cutting the corner through the blocks.
 */
export function streetPolyline(
  plan: CityPlan,
  from: { x: number; z: number },
  to: { x: number; z: number },
): Array<{ x: number; z: number }> {
  return streetRoute(plan, from, to).points
}

/**
 * The same route as {@link streetPolyline}, paired with the intersection ids it passes through.
 *
 * The ids are what the lane allocator keys on. Two ribbons that share a street leg must be nudged into
 * separate lanes, and a leg is named by the unordered pair of intersections it joins — not by a point
 * on a curve, which never lands twice in the same place once the street bows. Returning both from one
 * call means the route is solved once, rather than once for the geometry and again for the lane key.
 */
export function streetRoute(
  plan: CityPlan,
  from: { x: number; z: number },
  to: { x: number; z: number },
): { nodeIds: string[]; points: Array<{ x: number; z: number }> } {
  const nodeIds = streetPath(
    plan,
    nearestIntersectionId(plan, from.x, from.z),
    nearestIntersectionId(plan, to.x, to.z),
  )
  const lattice = nodeIds
    .map(id => plan.intersections.get(id))
    .filter((node): node is CityIntersection => node !== undefined)

  const points: Array<{ x: number; z: number }> = [{ x: from.x, z: from.z }]
  if (lattice.length === 0) {
    points.push({ x: to.x, z: to.z })
    return { nodeIds, points: dedupePoints(points) }
  }

  const geometry = streetGeometry(plan)
  const entry = lattice[0]
  points.push({ x: entry.x, z: entry.z })
  for (let index = 1; index < lattice.length; index += 1) {
    const leg = geometry.get(`${lattice[index - 1].id}>${lattice[index].id}`)
    if (leg && leg.length > 1) {
      // The leg repeats the node the previous leg ended on; dedupePoints drops it at the end.
      for (const point of leg) points.push({ x: point.x, z: point.z })
    } else {
      points.push({ x: lattice[index].x, z: lattice[index].z })
    }
  }

  points.push({ x: to.x, z: to.z })
  return { nodeIds, points: dedupePoints(points) }
}

/**
 * A reference to one block, in the legacy `col`/`row` shape district descriptions still read. `col` is
 * the block id and `row` is always 0; a block is a face of the street graph now, not a grid cell.
 */
export interface BlockRef {
  readonly col: number
  readonly row: number
}

/**
 * Stable object order: neighbourhood, then object ordinal, then catalogue order. Never row arrival
 * order.
 *
 * The last tiebreak compares object ids as {@link compareCreationOrder} does, numerically rather than
 * as text, for the same reason placement does: it only fires when two objects report the same
 * ordinal, and when it fires it should fall back on which table came first, not on which id happens
 * to start with a smaller digit.
 */
function orderObjects(objects: readonly DatabaseCityObject[]): DatabaseCityObject[] {
  return [...objects].sort(
    (left, right) =>
      left.layout.neighborhoodOrdinal - right.layout.neighborhoodOrdinal ||
      compareOrdinal(left.schemaId, right.schemaId) ||
      left.layout.objectOrdinal - right.layout.objectOrdinal ||
      compareCreationOrder(left.objectId, right.objectId),
  )
}

function parseCount(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null
}

/** How many objects a schema holds in total, and where it sits in neighbourhood order. */
interface SchemaSize {
  readonly schemaId: string
  readonly ordinal: number
  readonly count: number
}

/**
 * Every schema's full object count, in neighbourhood order.
 *
 * Taken from the page's complete schema list when there is one, because that count is the same on
 * every page and is therefore what a neighbourhood can be sized from without moving as pages load.
 * A schema the list did not mention, or one whose count is short of what actually arrived, is
 * widened to fit rather than allowed to overlap the next schema.
 *
 * Widened by *counting what arrived*, never by reading an object's collector ordinal as though it
 * were a position within its schema. The connected collector numbers objects across the whole
 * database, so that reading turned the five-hundredth object into a schema of five hundred and one
 * and handed its neighbourhood a fifth of the city (#49).
 */
function schemaSizes(
  ordered: readonly DatabaseCityObject[],
  schemas: readonly DatabaseCitySchema[] | undefined,
): SchemaSize[] {
  const counts = new Map<string, { ordinal: number; count: number }>()

  if (schemas && schemas.length > 0) {
    for (const schema of schemas) {
      counts.set(schema.schemaId, {
        ordinal: schema.neighborhoodOrdinal,
        count: parseCount(schema.objectCount) ?? 0,
      })
    }
  }

  const loaded = new Map<string, number>()
  for (const object of ordered) {
    loaded.set(object.schemaId, (loaded.get(object.schemaId) ?? 0) + 1)
  }
  for (const object of ordered) {
    const existing = counts.get(object.schemaId)
    const observed = loaded.get(object.schemaId) ?? 1
    if (!existing) {
      counts.set(object.schemaId, { ordinal: object.layout.neighborhoodOrdinal, count: observed })
    } else if (observed > existing.count) {
      counts.set(object.schemaId, { ordinal: existing.ordinal, count: observed })
    }
  }

  return [...counts.entries()]
    .map(([schemaId, entry]) => ({ schemaId, ordinal: entry.ordinal, count: entry.count }))
    .sort((left, right) => left.ordinal - right.ordinal || compareOrdinal(left.schemaId, right.schemaId))
}

/**
 * Ground a neighbourhood claims per object it holds.
 *
 * Above 1 so a neighbourhood has gaps in it — front gardens, corner parks, the odd empty plot, and
 * the ground the next table to be created will stand on — which is what stops a schema reading as a
 * solid slab of buildings. Below {@link RADIUS_PER_ROOT_OBJECT}, which is the airiness of the city as
 * a whole, because the difference between the two is the open country that separates one
 * neighbourhood from the next. That separation is the whole point: a schema you can see the edge of
 * is a schema you can navigate by.
 */
const NEIGHBORHOOD_SLACK = 1.5

/**
 * How far a block's cost may wander when a neighbourhood decides whether to claim it.
 *
 * Growth without this is a distance field, and a distance field grows discs. Real neighbourhoods have
 * ragged edges, so every block gets a fixed seeded handicap that makes some of them cheap to reach and
 * others expensive. Big enough to bend a boundary by a block or two, small enough that a region stays
 * one connected place rather than breaking into islands.
 */
const NEIGHBORHOOD_WOBBLE = 1.7

/**
 * The hue a neighbourhood is drawn in, as a 0–1 turn around the wheel.
 *
 * Lives here, three-free, because two very different renderers have to agree on it: the 3D scene
 * bakes it into building materials and ground washes, and the sidebar paints the same swatch beside
 * the schema name. A second copy of this formula would be a colour legend that quietly lies.
 *
 * Hues step by the golden angle, so consecutive schemas land far apart on the wheel and the tenth
 * schema is still distinguishable from the first. That also makes the sequence ordinal-only: it is a
 * set of names, not a scale, and no hue is higher, hotter or busier than another.
 */
export function neighborhoodHue(ordinal: number): number {
  return (((ordinal * 0.6180339887498949) % 1) + 1) % 1
}

/** The neighbourhood swatch as a CSS colour, for chrome that never loads the 3D renderer. */
export function neighborhoodSwatch(ordinal: number): string {
  return `hsl(${(neighborhoodHue(ordinal) * 360).toFixed(1)} 52% 55%)`
}

/**
 * Divides the buildable blocks into one contiguous territory per schema.
 *
 * This is the answer to "where does a table stand". Blocks used to be handed out from a single
 * city-wide shuffle, which put a schema's tables everywhere and nowhere: the map had no districts you
 * could point at, so the only way to see that two tables were related was to read both their labels.
 *
 * Each schema is given a seed block, spread as far from the other seeds as the city allows, and the
 * territories then grow outward in rounds, each schema in turn claiming the nearest unclaimed block to
 * the ground it already holds. Growing towards its own region keeps a territory one connected place —
 * the hard requirement that a schema's tables sit together on the map — and because "nearest" is
 * measured in world space rather than over the block adjacency graph, a region can still step across a
 * bridge in the street network. That matters: an organic network is full of dead-end lanes and
 * three-way forks, so the faces either side of them touch only at a point and the dual graph they
 * form is not one connected mesh but a handful of islands. Growth constrained to dual neighbours would
 * strand a schema on whichever island its seed fell on and pile every one of its tables onto those
 * few blocks; growth by proximity flows over the gaps and fills the district it was meant to.
 *
 * A schema still growing after its neighbours have met their quota keeps taking ground, so a schema
 * with ten times the tables gets roughly ten times the territory, and the borders land wherever two
 * regions grow into each other. Only when every block in the city is claimed does a schema stop short,
 * and then its objects share out the blocks it did claim.
 *
 * Crucially the partition is a function of the seed, the block field and the *full* schema counts,
 * never of which objects have loaded. Appending a page fills a neighbourhood in; it never redraws one.
 */
function planNeighborhoods(
  pool: readonly CityBlock[],
  schemas: readonly SchemaSize[],
  seed: string,
  separation: number,
): Map<string, CityBlock[]> {
  const territories = new Map<string, CityBlock[]>()
  if (schemas.length === 0 || pool.length === 0) return territories
  for (const schema of schemas) territories.set(schema.schemaId, [])

  const wobble = new Map<number, number>()
  const byId = new Map<number, CityBlock>()
  for (const block of pool) {
    wobble.set(block.id, ((stableHash(`${seed}::hood::${block.id}`) % 1024) / 1024) * NEIGHBORHOOD_WOBBLE)
    byId.set(block.id, block)
  }

  const quotas = neighborhoodQuotas(schemas, pool.length)
  const seeds = spreadSeeds(pool, schemas.length, seed)

  // Each schema keeps, for every still-unclaimed block, the distance from that block to the nearest
  // block the schema already owns, in separations. Growing to the block with the smallest such
  // distance is region growth by proximity, and holding the distances rather than recomputing them
  // keeps the whole partition to a handful of passes over the pool.
  const claimedBy = new Set<number>()
  const nearest = schemas.map(() => new Map<number, number>())
  const distanceOf = (block: CityBlock, from: CityBlock) =>
    Math.hypot(block.centroid.x - from.centroid.x, block.centroid.z - from.centroid.z) / separation

  const claim = (index: number, block: CityBlock) => {
    claimedBy.add(block.id)
    territories.get(schemas[index].schemaId)!.push(block)
    for (const own of nearest) own.delete(block.id)
    for (const candidate of pool) {
      if (claimedBy.has(candidate.id)) continue
      const stretch = distanceOf(candidate, block)
      const current = nearest[index].get(candidate.id)
      if (current === undefined || stretch < current) nearest[index].set(candidate.id, stretch)
    }
  }

  seeds.forEach((block, index) => {
    if (block && !claimedBy.has(block.id)) claim(index, block)
  })

  // Rounds rather than one schema at a time: growing a schema to its full quota before the next one
  // starts would let the first schema reach clear across the map and hem the other seeds in.
  let growing = true
  while (growing) {
    growing = false
    for (let index = 0; index < schemas.length; index += 1) {
      if (territories.get(schemas[index].schemaId)!.length >= quotas[index]) continue
      const next = nearestUnclaimed(nearest[index], wobble)
      if (next === null) continue
      claim(index, byId.get(next)!)
      growing = true
    }
  }

  return territories
}

/**
 * How many blocks each neighbourhood may claim.
 *
 * Sized from the schema's own rung of the growth ladder rather than its exact object count, for the
 * same reason the city is: a border that moves whenever one table is added takes every building near
 * it along. A neighbourhood therefore claims ground for a schema of roughly its size, which leaves
 * it visibly empty plots to grow into — that is what a new table moves onto.
 *
 * Deliberately *not* scaled to fit the ground available. Dividing a fixed pool between the schemas
 * would make every schema's quota a function of every other schema's size, so one schema gaining a
 * table would narrow all its neighbours — the coupling that redrew a city on a single `CREATE TABLE`.
 * Each schema instead asks for what it needs on its own, and the region growth that honours these
 * quotas simply stops when the ground runs out: schemas claim in interleaved rounds, so a starved
 * city still shares its blocks out rather than letting the first schema take everything.
 */
function neighborhoodQuotas(schemas: readonly SchemaSize[], available: number): number[] {
  if (schemas.length === 0) return []
  return schemas.map(schema =>
    Math.min(
      available,
      Math.max(
        schema.count,
        Math.round(plannedCount(schema.count, GROWTH_FLOOR_SCHEMA, SCHEMA_GROWTH_RATIO) * NEIGHBORHOOD_SLACK),
      ),
    ),
  )
}

/**
 * Picks one starting block per schema, each as far as possible from the ones already picked.
 *
 * Farthest-point sampling rather than random blocks: two seeds that land next to each other produce
 * two neighbourhoods that spend the whole growth fighting over the same ground and end up interleaved,
 * which is exactly the scattering this replaced.
 */
function spreadSeeds(pool: readonly CityBlock[], count: number, seed: string): CityBlock[] {
  const seeds: CityBlock[] = []
  if (pool.length === 0) return seeds
  const rng = mulberry32(stableHash(`${seed}::seeds`))
  seeds.push(pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))])

  while (seeds.length < count && seeds.length < pool.length) {
    let best: CityBlock | null = null
    let bestDistance = -1
    for (const block of pool) {
      let nearest = Infinity
      for (const chosen of seeds) {
        nearest = Math.min(
          nearest,
          Math.hypot(block.centroid.x - chosen.centroid.x, block.centroid.z - chosen.centroid.z),
        )
        if (nearest === 0) break
      }
      if (nearest > bestDistance) {
        bestDistance = nearest
        best = block
      }
    }
    if (!best || bestDistance <= 0) break
    seeds.push(best)
  }

  // More schemas than blocks is degenerate but must not throw; the extras share a seed and fall back
  // to the city-wide pool when they find no ground of their own.
  while (seeds.length < count) seeds.push(pool[seeds.length % pool.length])
  return seeds
}

/**
 * The unclaimed block nearest the region a schema already holds, with its seeded handicap added.
 *
 * `nearest` only ever holds unclaimed blocks — a block is dropped from every schema's map the moment
 * it is claimed — so this is just the minimum of each candidate's distance plus its wobble. The wobble
 * ragged-edges the border by a block or two; ties fall to the lowest block id so the partition never
 * depends on Map iteration order.
 */
function nearestUnclaimed(
  nearest: ReadonlyMap<number, number>,
  wobble: ReadonlyMap<number, number>,
): number | null {
  let bestId: number | null = null
  let bestCost = Infinity
  for (const [id, distance] of nearest) {
    const value = distance + (wobble.get(id) ?? 0)
    if (value < bestCost || (value === bestCost && (bestId === null || id < bestId))) {
      bestCost = value
      bestId = id
    }
  }
  return bestId
}

/**
 * Chooses six blocks for the infrastructure facilities, every pair at least `minSpacing` apart.
 *
 * Each attempt greedily walks a freshly shuffled block list and takes any block that still clears the
 * spacing — a random maximal independent set, which scatters the facilities across the city instead of
 * lining them up. If an attempt runs out of ground before placing all six it is discarded and the next
 * shuffle tried, so a lucky-but-cramped partial layout never ships. Spacing is a world distance now,
 * not a block count, because blocks are no longer a fixed size.
 *
 * The chosen blocks are finally sorted into a reading order and zipped against {@link FACILITY_ORDER},
 * so the facilities appear in a consistent order across the map.
 */
function placeFacilities(pool: readonly CityBlock[], minSpacing: number, numericSeed: number): CityBlock[] {
  for (let attempt = 0; attempt < FACILITY_PLACEMENT_ATTEMPTS; attempt += 1) {
    // Each attempt is its own seeded stream, so the shuffle is deterministic yet every attempt differs.
    const rng = mulberry32((numericSeed ^ (attempt * 0x9e3779b1)) >>> 0)
    const chosen: CityBlock[] = []
    for (const block of seededShuffle([...pool], rng)) {
      if (chosen.length === FACILITY_ORDER.length) break
      if (chosen.every(taken => facilityGap(taken, block) >= minSpacing)) chosen.push(block)
    }
    if (chosen.length === FACILITY_ORDER.length) return sortForReading(chosen)
  }
  return sortForReading(spreadFacilities(pool))
}

/**
 * Deterministic fallback for a city too small to satisfy the spacing rule.
 *
 * Starts at the first block and repeatedly takes whichever free block is furthest from everything
 * already taken, ties broken by block id. The spacing rule is relaxed rather than enforced — a tiny
 * database still gets a laid-out city, just a tighter one — and the result is still entirely
 * determined by the block field, so it never varies between loads.
 */
function spreadFacilities(blocks: readonly CityBlock[]): CityBlock[] {
  if (blocks.length === 0) return []
  const chosen: CityBlock[] = [blocks[0]]
  while (chosen.length < FACILITY_ORDER.length) {
    let best: CityBlock | null = null
    let bestGap = -1
    for (const candidate of blocks) {
      if (chosen.some(taken => taken.id === candidate.id)) continue
      const gap = Math.min(...chosen.map(taken => facilityGap(taken, candidate)))
      // Ties broken by id so the fallback never depends on array order beyond what the field fixes.
      if (gap > bestGap) {
        bestGap = gap
        best = candidate
      }
    }
    // Fewer blocks than facilities: reuse from the front rather than return a short list, so every
    // facility still has somewhere to stand.
    chosen.push(best ?? blocks[chosen.length % blocks.length])
  }
  return chosen
}

/** World distance between two blocks, measured centroid to centroid. */
function facilityGap(left: CityBlock, right: CityBlock): number {
  return Math.hypot(left.centroid.x - right.centroid.x, left.centroid.z - right.centroid.z)
}

/** Reading order: north to south, then west to east, so facilities are numbered top-left first. */
function sortForReading(blocks: readonly CityBlock[]): CityBlock[] {
  return [...blocks].sort(
    (left, right) => left.centroid.z - right.centroid.z || left.centroid.x - right.centroid.x || left.id - right.id,
  )
}

function facilitySites(blocks: readonly CityBlock[], cell: number): Map<FacilityKind, FacilitySite> {
  const sites = new Map<FacilityKind, FacilitySite>()
  FACILITY_ORDER.forEach((kind, index) => {
    const block = blocks[index]
    if (!block) return
    sites.set(kind, {
      kind,
      label: FACILITY_LABELS[kind],
      x: block.centroid.x,
      z: block.centroid.z,
      // Facilities fill their block. They are civic landmarks and must stay legible next to a
      // skyscraper, so their size is fixed by the block, never by a measurement.
      radius: cell / 2,
    })
  })
  return sites
}

/**
 * Describes each schema's neighbourhood: the ground it claimed and the buildings standing on it.
 *
 * The box is the territory rather than the bounding box of whatever has loaded, so framing "show me
 * this schema" holds still as pages arrive and always frames the same place. Only schemas with a
 * building on the map get a district, because a district is what the map labels and there is nothing
 * to point at otherwise.
 */
function describeDistricts(
  ordered: readonly DatabaseCityObject[],
  lots: ReadonlyMap<string, CityLot>,
  territories: ReadonlyMap<string, BlockRef[]>,
  warp: CityWarp,
): CityDistrict[] {
  const groups = new Map<string, { name: string; ordinal: number; lots: CityLot[] }>()
  for (const object of ordered) {
    const lot = lots.get(object.objectId)
    if (!lot) continue
    const existing = groups.get(object.schemaId)
    if (existing) {
      existing.lots.push(lot)
      existing.ordinal = Math.min(existing.ordinal, object.layout.neighborhoodOrdinal)
    } else {
      groups.set(object.schemaId, {
        name: object.schemaName,
        ordinal: object.layout.neighborhoodOrdinal,
        lots: [lot],
      })
    }
  }

  return [...groups.entries()]
    .sort((left, right) => left[1].ordinal - right[1].ordinal || compareOrdinal(left[0], right[0]))
    .map(([districtId, group]) => {
      const blocks = territories.get(districtId) ?? []
      // A block is a polygon of any number of sides, so a territory's extent is the extent of its
      // corners rather than a multiple of a pitch.
      const corners = blocks.flatMap(block => warp.blockCorners(block.col, block.row))
      const box = corners.length > 0
        ? {
            minX: Math.min(...corners.map(point => point.x)),
            maxX: Math.max(...corners.map(point => point.x)),
            minZ: Math.min(...corners.map(point => point.z)),
            maxZ: Math.max(...corners.map(point => point.z)),
          }
        : {
            minX: Math.min(...group.lots.map(lot => lot.x)),
            maxX: Math.max(...group.lots.map(lot => lot.x)),
            minZ: Math.min(...group.lots.map(lot => lot.z)),
            maxZ: Math.max(...group.lots.map(lot => lot.z)),
          }
      const centres = blocks.map(block => warp.blockCenter(block.col, block.row))
      return {
        districtId,
        name: group.name,
        neighborhoodOrdinal: group.ordinal,
        kind: 'schema' as const,
        objectCount: group.lots.length,
        blocks,
        ...box,
        centerX: (box.minX + box.maxX) / 2,
        centerZ: (box.minZ + box.maxZ) / 2,
        // The name goes over the middle of the claimed ground, not the middle of the box: an L-shaped
        // territory's box centre can easily be a block the schema does not own. The mean of the
        // claimed blocks has the same flaw for a crescent — its middle is the bay — so the label is
        // then pulled to the owned block nearest that mean, which is on the neighbourhood by
        // construction whatever shape it grew into.
        ...labelPoint(centres, group.lots),
      }
    })
}

/** Where a neighbourhood's name is written: on owned ground nearest the middle of it. */
function labelPoint(
  centres: readonly Point[],
  lots: ReadonlyArray<{ x: number; z: number }>,
): { labelX: number; labelZ: number } {
  if (centres.length === 0) {
    return { labelX: average(lots.map(lot => lot.x)), labelZ: average(lots.map(lot => lot.z)) }
  }
  const meanX = average(centres.map(point => point.x))
  const meanZ = average(centres.map(point => point.z))
  let best = centres[0]
  let bestDistance = Infinity
  for (const centre of centres) {
    const distance = (centre.x - meanX) ** 2 + (centre.z - meanZ) ** 2
    if (distance >= bestDistance) continue
    bestDistance = distance
    best = centre
  }
  return { labelX: best.x, labelZ: best.z }
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/**
 * A single city-wide lot size, set by the widest building the database asks for.
 *
 * This is the scale the whole city is derived from: the streamline separation is a multiple of it, so
 * even the tightest block still clears the largest footprint. The logarithmic footprint mapping bounds
 * the spread, so one very large table cannot make the whole city sparse.
 */
function chooseCell(widest: number): number {
  return Math.max(MIN_CELL, Math.ceil(widest + LOT_MARGIN))
}

function placeLot(object: DatabaseCityObject, block: CityBlock): CityLot {
  /*
   * One lot per block, so the building fronts the street along its block's frontage edge and the
   * block's other sides are open street too. There is no back row to face the other way.
   *
   * The building turns to face its own frontage, at whatever angle the block sits, which is what makes
   * an organically laid quarter read as a place that was laid out rather than a scatter of towers.
   */
  return {
    objectId: object.objectId,
    districtId: object.schemaId,
    blockId: `block/${block.id}`,
    blockCol: block.id,
    blockRow: 0,
    x: block.centroid.x,
    z: block.centroid.z,
    rotationY: block.heading,
    facing: 'north',
    accessX: block.frontage.x,
    accessZ: block.frontage.z,
    frontageStreetId: streetId(block.frontageEdgeId),
    lotSize: block.capacity,
    footprint: buildingFootprint(object.reservedPages8KiB),
    height: buildingHeight(object.usedPages8KiB),
    archetype: buildingArchetype(object),
    seed: stableHash(object.objectId),
  }
}

function cityBounds(warp: CityWarp): CityBounds {
  return {
    minX: warp.minX,
    maxX: warp.maxX,
    minZ: warp.minZ,
    maxZ: warp.maxZ,
    centerX: (warp.minX + warp.maxX) / 2,
    centerZ: (warp.minZ + warp.maxZ) / 2,
    width: warp.maxX - warp.minX,
    depth: warp.maxZ - warp.minZ,
  }
}

const geometryCache = new WeakMap<CityPlan, Map<string, readonly Point[]>>()

/** Drawn centre lines keyed by ordered intersection pair, so a leg can be walked either way. */
function streetGeometry(plan: CityPlan): Map<string, readonly Point[]> {
  const cached = geometryCache.get(plan)
  if (cached) return cached

  const map = new Map<string, readonly Point[]>()
  for (const street of plan.streets) {
    const forward = `${street.fromId}>${street.toId}`
    // The lattice and an avenue can both connect a pair; the first one wins, deterministically,
    // because street order is itself deterministic.
    if (!map.has(forward)) map.set(forward, street.path)
    const backward = `${street.toId}>${street.fromId}`
    if (!map.has(backward)) map.set(backward, [...street.path].reverse())
  }
  geometryCache.set(plan, map)
  return map
}

export function intersectionId(col: number, row: number): string {
  return `x${col}:z${row}`
}

export function dedupePoints(points: Array<{ x: number; z: number }>): Array<{ x: number; z: number }> {
  const result: Array<{ x: number; z: number }> = []
  for (const point of points) {
    const last = result[result.length - 1]
    if (last && Math.abs(last.x - point.x) < 0.001 && Math.abs(last.z - point.z) < 0.001) continue
    result.push(point)
  }
  return result
}

function pageCount(value: string | null): number | null {
  if (value === null) return null
  let parsed: bigint
  try {
    parsed = BigInt(value)
  } catch {
    return null
  }
  return parsed < 0n ? 0 : Number(parsed)
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Catalogue order for two object ids: the order SQL Server created the objects in, as closely as an
 * id can state it.
 *
 * Not a string comparison, which is the trap. An object id carries its `sys.objects.object_id`
 * unpadded — `sales/object/9`, `sales/object/1234567` — and compared as text the shorter number wins
 * on its first digit, so object 9 sorts *after* object 1234567. Placement hands out blocks in this
 * order and relies on a newly created table sorting last; under a plain string compare a new table
 * would land in the middle instead and push every building after it along, which is the whole bug
 * this order exists to fix (#47, #50).
 *
 * So runs of digits are compared as numbers and everything else as text. Runs are compared by length
 * before value, which orders them numerically without parsing an id of any length into a number.
 *
 * This is catalogue order, not a timeline: SQL Server allocates object ids increasing, but it can
 * reuse the id of a dropped object, so two tables' relative order is a fact about the catalogue
 * rather than a claim about when they were created.
 */
function compareCreationOrder(left: string, right: string): number {
  let leftAt = 0
  let rightAt = 0
  while (leftAt < left.length && rightAt < right.length) {
    const leftDigit = isDigit(left, leftAt)
    if (leftDigit !== isDigit(right, rightAt)) break

    if (!leftDigit) {
      if (left[leftAt] !== right[rightAt]) return left[leftAt] < right[rightAt] ? -1 : 1
      leftAt += 1
      rightAt += 1
      continue
    }

    // Leading zeros carry no value, so `object/007` and `object/7` compare equal here and fall
    // through to the length tiebreak below rather than ordering by how they were written.
    let leftStart = leftAt
    let rightStart = rightAt
    while (left[leftStart] === '0' && isDigit(left, leftStart + 1)) leftStart += 1
    while (right[rightStart] === '0' && isDigit(right, rightStart + 1)) rightStart += 1
    let leftEnd = leftStart
    let rightEnd = rightStart
    while (isDigit(left, leftEnd)) leftEnd += 1
    while (isDigit(right, rightEnd)) rightEnd += 1

    const leftRun = left.slice(leftStart, leftEnd)
    const rightRun = right.slice(rightStart, rightEnd)
    if (leftRun.length !== rightRun.length) return leftRun.length < rightRun.length ? -1 : 1
    if (leftRun !== rightRun) return leftRun < rightRun ? -1 : 1
    leftAt = leftEnd
    rightAt = rightEnd
  }

  if (leftAt >= left.length && rightAt >= right.length) return compareOrdinal(left, right)
  if (leftAt >= left.length) return -1
  if (rightAt >= right.length) return 1
  return left[leftAt] < right[rightAt] ? -1 : 1
}

function isDigit(value: string, at: number): boolean {
  const code = value.charCodeAt(at)
  return code >= 48 && code <= 57
}

