import { describe, expect, it } from 'vitest'
import {
  BLOCK_COLS,
  BLOCK_ROWS,
  CELLS_PER_BLOCK,
  STREET_WIDTH,
  buildingArchetype,
  buildingFootprint,
  buildingHeight,
  nearestIntersectionId,
  planCity,
  streetPath,
  streetPolyline,
  streetPolylineThrough,
  type CityPlan,
  type CityPlanOptions,
  type StreetClass,
} from './cityPlan'
import { FACILITY_ORDER } from './cityInfrastructure'
import { distanceToStreetNetwork } from './cityPlan.testkit'
import type { DatabaseCityObject, DatabaseCitySchema } from './databaseCityContracts'
import type { Evidence } from './contracts'

const evidence: Evidence = {
  source: 'CatalogSnapshot',
  status: 'Available',
  observedAt: null,
  freshUntil: null,
  reason: 'test',
}

function object(
  objectId: string,
  schemaId: string,
  neighborhoodOrdinal: number,
  objectOrdinal: number,
  reservedPages: string | null = '4096',
  usedPages: string | null = '2048',
): DatabaseCityObject {
  return {
    objectId,
    schemaId,
    schemaName: schemaId.replace('schema:', ''),
    name: objectId,
    kind: 'Table',
    reservedPages8KiB: reservedPages,
    usedPages8KiB: usedPages,
    reservedBytes: reservedPages === null ? null : String(BigInt(reservedPages) * 8192n),
    usedBytes: usedPages === null ? null : String(BigInt(usedPages) * 8192n),
    sizeStatus: reservedPages === null ? 'Unknown' : 'Known',
    sizeReason: null,
    layout: { neighborhoodOrdinal, objectOrdinal, x: 0, z: 0 },
    indexes: [],
    directActivity: { totalOperations: '1', resetEpochToken: null, evidence },
    attributedExposure: {
      executionCount: null,
      totalCpuMicroseconds: null,
      totalDurationMicroseconds: null,
      totalLogicalReads8KiBPages: null,
      confidence: 'Unknown',
      rationale: 'test',
      evidence,
    },
  }
}

function sampleCity(): DatabaseCityObject[] {
  const objects: DatabaseCityObject[] = []
  for (let index = 0; index < 11; index += 1) {
    objects.push(object(`object:dbo:${100 + index}`, 'schema:dbo', 0, index))
  }
  for (let index = 0; index < 5; index += 1) {
    objects.push(object(`object:rep:${300 + index}`, 'schema:reporting', 1, index))
  }
  objects.push(object('object:arc:900', 'schema:archive', 2, 0, null, null))
  return objects
}

/** The schema list and totals every page of {@link sampleCity} would carry. */
function sampleSchemas(): DatabaseCitySchema[] {
  return [
    { schemaId: 'schema:dbo', name: 'dbo', neighborhoodOrdinal: 0, objectCount: '11', evidence },
    { schemaId: 'schema:reporting', name: 'reporting', neighborhoodOrdinal: 1, objectCount: '5', evidence },
    { schemaId: 'schema:archive', name: 'archive', neighborhoodOrdinal: 2, objectCount: '1', evidence },
  ]
}

function options(overrides: Partial<CityPlanOptions> = {}): CityPlanOptions {
  return { seed: 'db:sales', totalObjects: '17', schemas: sampleSchemas(), ...overrides }
}

/** Turns a world position back into the block grid coordinates the plan placed it on. */
function blockIndex(plan: CityPlan, x: number, z: number): { col: number; row: number } {
  // Division no longer inverts the mapping: block spans vary and the whole lattice is displaced, so
  // the plan's own warp is the only thing that knows where a point landed.
  return plan.warp.blockAt(x, z)
}

function blockOf(plan: CityPlan, x: number, z: number): string {
  const { col, row } = blockIndex(plan, x, z)
  return `${col}-${row}`
}

/** Shortest distance from a point to a drawn centre line, segments included, not just vertices. */
function distanceToPath(path: readonly { x: number; z: number }[], x: number, z: number): number {
  let best = Infinity
  for (let index = 0; index + 1 < path.length; index += 1) {
    const from = path[index]
    const to = path[index + 1]
    const dx = to.x - from.x
    const dz = to.z - from.z
    const lengthSquared = dx * dx + dz * dz
    const t = lengthSquared < 1e-9
      ? 0
      : Math.min(1, Math.max(0, ((x - from.x) * dx + (z - from.z) * dz) / lengthSquared))
    best = Math.min(best, Math.hypot(from.x + dx * t - x, from.z + dz * t - z))
  }
  return best
}

/** Whether a point lies within a block's polygon, so a lot can be checked against the ground it stands on. */
function insidePolygon(polygon: readonly { x: number; z: number }[], x: number, z: number): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]!
    const b = polygon[j]!
    const straddles = a.z > z !== b.z > z
    if (straddles && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside
  }
  return inside
}

/** World centre of a district's block, so contiguity can be judged in metres rather than opaque ids. */
function blockCentre(plan: CityPlan, block: { col: number; row: number }): { x: number; z: number } {
  return plan.warp.blockCenter(block.col, block.row)
}

describe('buildingFootprint / buildingHeight', () => {
  it('maps exact page counts logarithmically and monotonically', () => {
    expect(buildingFootprint('0')).toBeCloseTo(6, 6)
    expect(buildingFootprint('1')).toBeCloseTo(6.75, 6)
    expect(buildingHeight('0')).toBeCloseTo(0, 6)
    expect(buildingHeight('1')).toBeCloseTo(4.8, 6)

    let previousFootprint = -1
    let previousHeight = -1
    for (const pages of ['0', '1', '8', '128', '2048', '65536', '1048576', '17179869184']) {
      const footprint = buildingFootprint(pages)!
      const height = buildingHeight(pages)!
      expect(footprint).toBeGreaterThan(previousFootprint)
      expect(height).toBeGreaterThan(previousHeight)
      previousFootprint = footprint
      previousHeight = height
    }
  })

  it('adds a fixed amount per doubling', () => {
    expect(buildingFootprint('1023')! - buildingFootprint('511')!).toBeCloseTo(0.75, 6)
    expect(buildingHeight('1023')! - buildingHeight('511')!).toBeCloseTo(4.8, 6)
  })

  it('returns null for unknown size rather than inventing a value', () => {
    expect(buildingFootprint(null)).toBeNull()
    expect(buildingHeight(null)).toBeNull()
    expect(buildingFootprint('not-a-number')).toBeNull()
  })

  it('handles page counts beyond Number.MAX_SAFE_INTEGER without throwing', () => {
    expect(buildingHeight('99999999999999999999999')).toBeGreaterThan(0)
  })
})

describe('buildingArchetype', () => {
  it('selects a style family from exact reserved pages', () => {
    expect(buildingArchetype(object('a', 'schema:dbo', 0, 0, '1', '1'))).toBe('house')
    expect(buildingArchetype(object('a', 'schema:dbo', 0, 0, '127', '1'))).toBe('house')
    expect(buildingArchetype(object('a', 'schema:dbo', 0, 0, '128', '1'))).toBe('rowhouse')
    expect(buildingArchetype(object('a', 'schema:dbo', 0, 0, '2047', '1'))).toBe('rowhouse')
    expect(buildingArchetype(object('a', 'schema:dbo', 0, 0, '2048', '1'))).toBe('midrise')
    expect(buildingArchetype(object('a', 'schema:dbo', 0, 0, '32768', '1'))).toBe('tower')
    expect(buildingArchetype(object('a', 'schema:dbo', 0, 0, '524288', '1'))).toBe('skyscraper')
  })

  it('renders unknown size as a vacant parcel that makes no quantity claim', () => {
    expect(buildingArchetype(object('a', 'schema:dbo', 0, 0, null, null))).toBe('vacant')
    expect(buildingArchetype(object('a', 'schema:dbo', 0, 0, '4096', null))).toBe('vacant')
  })

  it('gives indexed views their own civic style', () => {
    const view = { ...object('a', 'schema:dbo', 0, 0, '4096', '2048'), kind: 'IndexedView' as const }
    expect(buildingArchetype(view)).toBe('civic')
  })
})

describe('planCity placement', () => {
  it('is independent of the order rows arrive in', () => {
    const forward = planCity(sampleCity(), options())
    const reversed = planCity([...sampleCity()].reverse(), options())
    const shuffled = planCity(
      [...sampleCity()].sort((left, right) => left.objectId.localeCompare(right.objectId)).reverse(),
      options(),
    )
    for (const plan of [reversed, shuffled]) {
      expect(plan.blockCols).toBe(forward.blockCols)
      expect(plan.blockRows).toBe(forward.blockRows)
      for (const [objectId, lot] of forward.lots) {
        expect(plan.lots.get(objectId)).toEqual(lot)
      }
    }
  })

  it('produces the identical city every time for the same seed', () => {
    const first = planCity(sampleCity(), options())
    const second = planCity(sampleCity(), options())
    expect([...second.lots.entries()]).toEqual([...first.lots.entries()])
    expect([...second.facilities.entries()]).toEqual([...first.facilities.entries()])
  })

  it('gives a different database a different city', () => {
    const sales = planCity(sampleCity(), options({ seed: 'db:sales' }))
    const archive = planCity(sampleCity(), options({ seed: 'db:archive' }))
    const moved = [...sales.lots.entries()].filter(([objectId, lot]) => {
      const other = archive.lots.get(objectId)!
      return other.x !== lot.x || other.z !== lot.z
    })
    // Two databases of identical shape must not produce the same town, or the seed is doing nothing.
    expect(moved.length).toBeGreaterThan(sales.lots.size / 2)
  })

  it('keeps a building on the same lot when a later bounded page is appended', () => {
    const firstPage = sampleCity().filter(item => item.schemaId === 'schema:dbo')
    // The totals and schema list are identical on every page, which is what lets the first page be
    // planned against the whole database rather than against itself.
    const planned = planCity(firstPage, options())
    const withMorePages = planCity(sampleCity(), options())
    for (const item of firstPage) {
      const before = planned.lots.get(item.objectId)!
      const after = withMorePages.lots.get(item.objectId)!
      expect({ x: after.x, z: after.z }).toEqual({ x: before.x, z: before.z })
    }
    expect([...withMorePages.facilities.entries()]).toEqual([...planned.facilities.entries()])
  })

  it('sizes the city from the database total, not from collector-assigned slot ordinals', () => {
    /*
     * The connected collector numbers `layout.objectOrdinal` across the whole database, in object-id
     * order, while the fixture numbers it within each schema. The layout adds a schema offset to
     * that ordinal to get a slot, so against a real instance the slots ran far past the object count
     * — and landed somewhere different on every page, because the offsets are built from per-page
     * schema counts. When those slots were allowed to size the city, a seventy-five table database
     * asked for hundreds of block columns and re-planned its whole street network the moment a
     * second page arrived.
     *
     * The city is sized from `totalObjects` alone, so a global ordinal cannot inflate or move it.
     */
    const perSchema = largeCity()
    const global = perSchema.map((item, index) => ({
      ...item,
      layout: { ...item.layout, objectOrdinal: index },
    }))

    const fromPerSchema = planCity(perSchema, largeOptions())
    const fromGlobal = planCity(global, largeOptions())

    expect(fromGlobal.blockCols).toBe(fromPerSchema.blockCols)
    expect(fromGlobal.streets.map(street => street.id))
      .toEqual(fromPerSchema.streets.map(street => street.id))
    expect(fromGlobal.lots.size).toBe(perSchema.length)
  })

  it('keeps the street network identical while pages with per-page schema counts arrive', () => {
    // `page.schemas` counts only that page's objects, so the counts a plan sees genuinely change as
    // pages land, and the collector's object ordinals are database-global. The streets must not
    // notice either: they are sized from the database total alone.
    const all = largeCity().map((item, index) => ({
      ...item,
      layout: { ...item.layout, objectOrdinal: index },
    }))
    const firstPage = all.slice(0, 50)
    const countsFor = (objects: readonly DatabaseCityObject[]): DatabaseCitySchema[] => {
      const counts = new Map<string, number>()
      for (const item of objects) counts.set(item.schemaId, (counts.get(item.schemaId) ?? 0) + 1)
      return [...counts.entries()].map(([schemaId, count]) => ({
        schemaId,
        name: schemaId,
        neighborhoodOrdinal: Number(schemaId.slice(-1)),
        objectCount: String(count),
        evidence,
      }))
    }

    const partial = planCity(firstPage, { ...largeOptions(), schemas: countsFor(firstPage) })
    const complete = planCity(all, { ...largeOptions(), schemas: countsFor(all.slice(50)) })

    expect(complete.streets.map(street => street.id))
      .toEqual(partial.streets.map(street => street.id))
    expect(complete.blockCols).toBe(partial.blockCols)
    expect(complete.lots.size).toBe(all.length)
  })

  it('never overlaps two lots', () => {
    const plan = planCity(sampleCity(), options())
    const lots = [...plan.lots.values()]
    // One building per block, and every building fits inside the largest square its block holds. The
    // blocks are disjoint faces of the street graph, so a footprint that fits its own block cannot
    // reach into another; that, not a fixed grid pitch, is what keeps two buildings apart now.
    const blocks = new Set(lots.map(lot => lot.blockId))
    expect(blocks.size).toBe(lots.length)
    for (const lot of lots) {
      if (lot.footprint === null) continue
      expect(lot.footprint).toBeLessThanOrEqual(lot.lotSize)
    }
  })

  /**
   * The city used to be almost entirely ground: measured over a 220-object city the median block was
   * about 144 units across against a mean building of 15, so a building covered under 1% of the block
   * it stood on and the drawing read as huts scattered on open moor (#70). The block is sized from the
   * cell and the cell from the widest building, so this ratio is a property of the planning constants
   * — {@link LOT_MARGIN}, the street separation and the centre-to-edge spacing — and not of the data.
   *
   * Deliberately a ratio and not an absolute size. Footprint and height are measured quantities that
   * may not be adjusted to make a picture look better, so the only honest way to fill a block is to
   * stop cutting the block so much larger than the building that has to stand on it.
   */
  it('stands a building on a block sized for it rather than on a paddock', () => {
    const plan = planCity(largeCity(), largeOptions())
    const shares: number[] = []
    for (const lot of plan.lots.values()) {
      if (lot.footprint === null) continue
      const polygon = plan.warp.blockCorners(lot.blockCol, lot.blockRow)
      if (polygon.length < 3) continue
      let twiceArea = 0
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
        twiceArea += (polygon[j]!.x + polygon[i]!.x) * (polygon[j]!.z - polygon[i]!.z)
      }
      shares.push((lot.footprint * lot.footprint) / (Math.abs(twiceArea) / 2))
    }
    expect(shares.length).toBeGreaterThan(50)
    shares.sort((left, right) => left - right)
    const median = shares[Math.floor(shares.length / 2)]!
    expect(median).toBeGreaterThan(0.02)
  })

  it('never puts a building on a facility block', () => {
    const plan = planCity(sampleCity(), options())
    const facilityBlocks = new Set(
      [...plan.facilities.values()].map(site => blockOf(plan, site.x, site.z)),
    )
    for (const lot of plan.lots.values()) {
      expect(facilityBlocks.has(blockOf(plan, lot.x, lot.z))).toBe(false)
    }
  })

  it('keeps every building inside its own district bounding box', () => {
    const plan = planCity(sampleCity(), options())
    for (const lot of plan.lots.values()) {
      const district = plan.districts.find(item => item.districtId === lot.districtId)!
      // Inclusive, because a one-block district collapses its bounding box onto its single lot, and a
      // building standing exactly on the box it defines is inside its own district, not outside it.
      expect(lot.x).toBeGreaterThanOrEqual(district.minX)
      expect(lot.x).toBeLessThanOrEqual(district.maxX)
      expect(lot.z).toBeGreaterThanOrEqual(district.minZ)
      expect(lot.z).toBeLessThanOrEqual(district.maxZ)
    }
  })

  it('fronts every lot onto a street it can be entered from', () => {
    const plan = planCity(sampleCity(), options())
    const streets = new Map(plan.streets.map(street => [street.id, street]))
    for (const lot of plan.lots.values()) {
      const street = streets.get(lot.frontageStreetId)
      expect(street, `${lot.objectId} fronts a street that was pruned`).toBeDefined()

      // The door stands on the carriageway that is drawn, not on the chord between its junctions.
      // Which of the block's edges that is depends on which survived the street patterns and the
      // junction prune, so the test asserts the relationship rather than a fixed direction.
      const offStreet = distanceToPath(street!.path, lot.accessX, lot.accessZ)
      expect(offStreet, `${lot.objectId} is entered from a point off its own street`)
        .toBeLessThan(1e-6)

      // The door is on this block's own kerb rather than one across town: it sits within the block the
      // building stands on, which the warp can draw as a polygon.
      const corners = plan.warp.blockCorners(lot.blockCol, lot.blockRow)
      const radius = Math.max(...corners.map(corner => Math.hypot(corner.x - lot.x, corner.z - lot.z)))
      expect(Math.hypot(lot.accessX - lot.x, lot.accessZ - lot.z)).toBeLessThanOrEqual(radius + 1e-6)

      // And the building turns to face it: +Z rotated by rotationY points from centre to door.
      expect(lot.rotationY).toBeCloseTo(Math.atan2(lot.accessX - lot.x, lot.accessZ - lot.z), 6)
    }
  })

  it('gives every building its own block, ringed by street', () => {
    const objects = Array.from({ length: 9 }, (_unused, index) =>
      object(`object:dbo:${index}`, 'schema:dbo', 0, index))
    const plan = planCity(objects, options())
    const blocks = new Set([...plan.lots.values()].map(lot => lot.blockId))

    // The separation that schema tints used to provide now lives in the street network, so no two
    // buildings share a block: one lot per block, and every object the schema holds is placed.
    expect(plan.lots.size).toBe(objects.length)
    expect(blocks.size).toBe(plan.lots.size)
    expect(CELLS_PER_BLOCK).toBe(1)
    expect(BLOCK_COLS * BLOCK_ROWS).toBe(CELLS_PER_BLOCK)
  })

  it('stands every building inside its own block', () => {
    const plan = planCity(sampleCity(), options())
    for (const lot of plan.lots.values()) {
      // A block is a real polygon now, so the strongest statement of "one building, one block" is that
      // the building's centre lies inside the ground the block covers. Disjoint blocks then keep the
      // buildings themselves apart, whatever angle the streets meet at.
      const corners = plan.warp.blockCorners(lot.blockCol, lot.blockRow)
      expect(corners.length).toBeGreaterThanOrEqual(3)
      expect(insidePolygon(corners, lot.x, lot.z)).toBe(true)
    }
  })

  it('scatters buildings rather than packing them into a corner', () => {
    const plan = planCity(sampleCity(), options())
    const lots = [...plan.lots.values()]
    const xs = lots.map(lot => lot.x)
    const zs = lots.map(lot => lot.z)
    // A packed layout would huddle in one corner of the map; a scattered one reaches across it. The
    // lattice rows and columns are gone, so coverage is measured in world space: the buildings span a
    // healthy fraction of the city they sit in on both axes.
    const spanX = Math.max(...xs) - Math.min(...xs)
    const spanZ = Math.max(...zs) - Math.min(...zs)
    expect(spanX).toBeGreaterThan(plan.bounds.width * 0.4)
    expect(spanZ).toBeGreaterThan(plan.bounds.depth * 0.4)
  })

  it('plans a usable city from a single object', () => {
    const plan = planCity([object('object:dbo:1', 'schema:dbo', 0, 0)], options())
    expect(plan.lots.size).toBe(1)
    expect(plan.streets.length).toBeGreaterThan(0)
    expect(plan.bounds.width).toBeGreaterThan(0)
  })

  it('plans an empty city without throwing, and still sites its infrastructure', () => {
    const plan = planCity([], options())
    expect(plan.lots.size).toBe(0)
    expect(plan.districts).toHaveLength(0)
    expect(plan.facilities.size).toBe(FACILITY_ORDER.length)
  })
})

describe('schema neighborhoods', () => {
  /** Mean world distance between every pair of lots drawn from `lots`. */
  function spread(_plan: CityPlan, lots: readonly { x: number; z: number }[]): number {
    let total = 0
    let pairs = 0
    for (let i = 0; i < lots.length; i += 1) {
      for (let j = i + 1; j < lots.length; j += 1) {
        total += Math.hypot(lots[i].x - lots[j].x, lots[i].z - lots[j].z)
        pairs += 1
      }
    }
    return pairs === 0 ? 0 : total / pairs
  }

  it('stands a schema\u2019s tables together instead of spreading them over the whole map', () => {
    const plan = planCity(largeCity(), largeOptions())
    const all = [...plan.lots.values()]
    for (const district of plan.districts) {
      const mine = all.filter(lot => lot.districtId === district.districtId)
      expect(mine.length).toBeGreaterThan(1)
      // A neighbourhood has to be tighter than the city it sits in, or it is not a neighbourhood.
      expect(spread(plan, mine)).toBeLessThan(spread(plan, all) * 0.75)
    }
  })

  it('never lets two neighborhoods claim the same ground', () => {
    const plan = planCity(largeCity(), largeOptions())
    const owner = new Map<string, string>()
    for (const district of plan.districts) {
      for (const block of district.blocks) {
        const key = `${block.col}-${block.row}`
        expect(owner.get(key)).toBeUndefined()
        owner.set(key, district.districtId)
      }
    }
    expect(owner.size).toBeGreaterThan(0)
  })

  it('keeps a neighborhood in one piece rather than in scattered islands', () => {
    const plan = planCity(largeCity(), largeOptions())
    // Blocks are no longer numbered by lattice position, so contiguity is judged in world space. Reach
    // is taken per district from its own grain — a generous multiple of the typical gap between a block
    // and its nearest sibling — because the tensor field spaces blocks wider towards the city edge, so
    // one absolute distance cannot serve a district near the centre and one on the rim at once. The
    // test asks that the bulk of a district forms a single cluster rather than that every last block
    // does: a river carves a district in two and proximity growth can leave a lone block across the
    // water, and neither means the schema is scattered across the map.
    for (const district of plan.districts) {
      if (district.blocks.length < 4) continue
      const centres = district.blocks.map(block => blockCentre(plan, block))
      const nearest = centres.map((centre, index) => {
        let best = Infinity
        centres.forEach((other, otherIndex) => {
          if (otherIndex === index) return
          best = Math.min(best, Math.hypot(centre.x - other.x, centre.z - other.z))
        })
        return best
      }).sort((left, right) => left - right)
      const reach = nearest[Math.floor(nearest.length / 2)]! * 3

      const unseen = new Set(centres.map((_centre, index) => index))
      let largest = 0
      while (unseen.size > 0) {
        const start = unseen.values().next().value as number
        unseen.delete(start)
        const queue = [start]
        let size = 1
        while (queue.length > 0) {
          const here = centres[queue.pop()!]!
          for (const index of [...unseen]) {
            if (Math.hypot(here.x - centres[index]!.x, here.z - centres[index]!.z) > reach) continue
            unseen.delete(index)
            queue.push(index)
            size += 1
          }
        }
        largest = Math.max(largest, size)
      }
      // The main body of the district must hold the overwhelming majority of its ground; a schema split
      // into equal islands would fail this, a schema with one stray across the river passes it.
      expect(largest).toBeGreaterThanOrEqual(district.blocks.length * 0.85)
    }
  })

  it('gives a schema ground in proportion to how many tables it holds', () => {
    const plan = planCity(sampleCity(), options())
    const size = (id: string) => plan.districts.find(district => district.districtId === id)!.blocks.length
    expect(size('schema:dbo')).toBeGreaterThan(size('schema:reporting'))
    expect(size('schema:reporting')).toBeGreaterThanOrEqual(size('schema:archive'))
    // Every table needs somewhere to stand, however small its schema.
    expect(size('schema:archive')).toBeGreaterThanOrEqual(1)
  })

  it('settles a neighborhood\u2019s shape before its tables arrive, so a later page fills it in', () => {
    const full = planCity(sampleCity(), options())
    // The same database, one page in: fewer objects, but every page carries the whole schema list.
    const firstPage = planCity(sampleCity().slice(0, 4), options())
    for (const district of firstPage.districts) {
      const same = full.districts.find(item => item.districtId === district.districtId)!
      expect(district.blocks.map(block => `${block.col}-${block.row}`))
        .toEqual(same.blocks.map(block => `${block.col}-${block.row}`))
    }
  })

  it('writes a neighborhood\u2019s name over ground that neighborhood actually owns', () => {
    const plan = planCity(largeCity(), largeOptions())
    for (const district of plan.districts) {
      const owned = new Set(district.blocks.map(block => `${block.col}-${block.row}`))
      const { col, row } = blockIndex(plan, district.labelX, district.labelZ)
      expect(owned.has(`${col}-${row}`)).toBe(true)
    }
  })
})

describe('facility scatter', () => {
  it('places every facility well clear of every other', () => {
    for (const seed of ['db:sales', 'db:archive', 'db:1', 'db:2', 'db:3']) {
      const plan = planCity(sampleCity(), options({ seed }))
      const sites = [...plan.facilities.values()]
      expect(sites).toHaveLength(FACILITY_ORDER.length)
      // Each facility stands on its own block, and no two share a kerb: the spacing rule that used to
      // count grid cells now measures world distance, so a facility reads as its own landmark even
      // though the blocks around it are no longer a fixed size. A full cell of clear ground between
      // any two is comfortably inside what the placer enforces and survives its small-city fallback.
      const blocks = new Set(sites.map(site => `${blockIndex(plan, site.x, site.z).col}`))
      expect(blocks.size).toBe(FACILITY_ORDER.length)
      for (let left = 0; left < sites.length; left += 1) {
        for (let right = left + 1; right < sites.length; right += 1) {
          const gap = Math.hypot(sites[left]!.x - sites[right]!.x, sites[left]!.z - sites[right]!.z)
          expect(gap).toBeGreaterThan(plan.cell)
        }
      }
    }
  })

  it('sites one facility per kind, in a consistent reading order', () => {
    const plan = planCity(sampleCity(), options())
    expect([...plan.facilities.keys()]).toEqual([...FACILITY_ORDER])
    // Reading order is north to south, then west to east, measured in world space rather than by grid
    // row and column, because a block no longer has either. Consecutive facilities never step north.
    const sites = FACILITY_ORDER.map(kind => plan.facilities.get(kind)!)
    for (let index = 1; index < sites.length; index += 1) {
      const previous = sites[index - 1]!
      const current = sites[index]!
      const stepsSouth = current.z > previous.z + 1e-6
      const sameRowStepsEast = Math.abs(current.z - previous.z) <= 1e-6 && current.x > previous.x
      expect(stepsSouth || sameRowStepsEast).toBe(true)
    }
  })

  it('still lays out when the grid cannot satisfy the spacing rule', () => {
    // Falls back to a maximise-minimum-distance sweep rather than throwing or dropping a facility.
    const plan = planCity([], { seed: 'tiny' })
    expect(plan.facilities.size).toBe(FACILITY_ORDER.length)
    const seen = new Set([...plan.facilities.values()].map(site => `${site.x}/${site.z}`))
    expect(seen.size).toBe(FACILITY_ORDER.length)
  })
})

describe('street graph', () => {
  it('connects every intersection to every other intersection', () => {
    const plan = planCity(sampleCity())
    const ids = [...plan.intersections.keys()]
    const first = ids[0]!
    for (const id of ids) {
      expect(streetPath(plan, first, id).length).toBeGreaterThan(0)
    }
  })

  it('produces a continuous path where every step is a real street', () => {
    const plan = planCity(sampleCity())
    const ids = [...plan.intersections.keys()].sort()
    const path = streetPath(plan, ids[0]!, ids[ids.length - 1]!)
    expect(path[0]).toBe(ids[0])
    expect(path[path.length - 1]).toBe(ids[ids.length - 1])

    // Steps used to be asserted as one block of Manhattan distance, which quietly assumed the network
    // was nothing but the lattice. Diagonal avenues are real edges now, so the invariant that actually
    // matters is that consecutive nodes are joined by a street that exists.
    const edges = new Set(plan.streets.flatMap(street => [
      `${street.fromId}>${street.toId}`,
      `${street.toId}>${street.fromId}`,
    ]))
    for (let index = 1; index < path.length; index += 1) {
      expect(edges.has(`${path[index - 1]}>${path[index]}`)).toBe(true)
    }
  })

  it('is deterministic and symmetric in length', () => {
    const plan = planCity(sampleCity())
    const ids = [...plan.intersections.keys()].sort()
    const forward = streetPath(plan, ids[0]!, ids[ids.length - 1]!)
    expect(streetPath(plan, ids[0]!, ids[ids.length - 1]!)).toEqual(forward)
    expect(streetPath(plan, ids[ids.length - 1]!, ids[0]!)).toHaveLength(forward.length)
  })

  it('returns an empty path for an unknown intersection', () => {
    const plan = planCity(sampleCity())
    expect(streetPath(plan, 'x0:z0', 'nowhere')).toEqual([])
  })

  it('walks streets between two buildings instead of cutting across blocks', () => {
    const plan = planCity(sampleCity())
    const lots = [...plan.lots.values()]
    const from = { x: lots[0]!.accessX, z: lots[0]!.accessZ }
    const to = { x: lots[lots.length - 1]!.accessX, z: lots[lots.length - 1]!.accessZ }
    const line = streetPolyline(plan, from, to)
    expect(line.length).toBeGreaterThan(2)

    // Every vertex between the two kerbs sits on a carriageway. The endpoints are excused because a
    // lot's access point is deliberately half a street off the centre line, at the kerb.
    for (let index = 1; index < line.length - 1; index += 1) {
      expect(distanceToStreetNetwork(plan, line[index]!)).toBeLessThanOrEqual(STREET_WIDTH)
    }
  })

  it('threads one continuous street path through every waypoint in order', () => {
    const plan = planCity(sampleCity())
    const lots = [...plan.lots.values()]
    const stops = [lots[0]!, lots[2]!, lots[lots.length - 1]!].map(lot => ({
      x: lot.accessX,
      z: lot.accessZ,
    }))
    const threaded = streetPolylineThrough(plan, stops)

    // Every waypoint is actually visited, so a shared lane really does pass each building it names.
    for (const stop of stops) {
      expect(threaded.some(point => point.x === stop.x && point.z === stop.z)).toBe(true)
    }
    // Waypoints appear in the order given: the path is one journey, not three overlapping ones.
    const visits = stops.map(stop =>
      threaded.findIndex(point => point.x === stop.x && point.z === stop.z))
    expect(visits).toEqual([...visits].sort((left, right) => left - right))
    // Still drives on streets rather than cutting the corner between legs.
    for (let index = 1; index < threaded.length - 1; index += 1) {
      expect(distanceToStreetNetwork(plan, threaded[index]!)).toBeLessThanOrEqual(STREET_WIDTH)
    }
    // No duplicated vertex where one leg hands over to the next.
    for (let index = 1; index < threaded.length; index += 1) {
      expect(threaded[index]).not.toEqual(threaded[index - 1])
    }
  })

  it('draws nothing for a lane with fewer than two waypoints', () => {
    const plan = planCity(sampleCity())
    expect(streetPolylineThrough(plan, [])).toEqual([])
    expect(streetPolylineThrough(plan, [{ x: 0, z: 0 }])).toEqual([])
  })

  it('snaps a world point to the nearest intersection', () => {
    const plan = planCity(sampleCity())
    // Intersections are named for their graph node now, not their grid position, so there is no
    // 'x0:z0' to hard-code. The contract is unchanged though: the id returned is a real intersection,
    // and it is the closest one to the query, which the test confirms by scanning them all.
    const nearestByScan = (x: number, z: number) => {
      let best = ''
      let bestDistance = Infinity
      for (const node of plan.intersections.values()) {
        const distance = Math.hypot(node.x - x, node.z - z)
        if (distance < bestDistance) {
          bestDistance = distance
          best = node.id
        }
      }
      return best
    }
    for (const point of [[0, 0], [-9999, -9999], [9999, 9999], [120, -40]] as const) {
      const snapped = nearestIntersectionId(plan, point[0], point[1])
      expect(plan.intersections.has(snapped)).toBe(true)
      expect(snapped).toBe(nearestByScan(point[0], point[1]))
    }
  })

  it('gives the arteries between districts more width than the lanes inside them', () => {
    const plan = planCity(largeCity(), largeOptions())
    // The old lattice tagged a handful of streets 'arterial' by hand. The network earns its hierarchy
    // from through-traffic instead, so the honest invariant is that the classifier finds a spread of
    // classes and that the busier ones are drawn wider than the quiet residential lanes.
    const widthOf = (roadClass: StreetClass) => {
      const widths = plan.streets.filter(street => street.streetClass === roadClass).map(street => street.width)
      return widths.length === 0 ? null : Math.max(...widths)
    }
    const primary = widthOf('primary') ?? widthOf('secondary')
    const residential = widthOf('residential') ?? widthOf('tertiary')
    expect(primary).not.toBeNull()
    expect(residential).not.toBeNull()
    expect(primary!).toBeGreaterThan(residential!)
    for (const street of plan.streets) {
      expect(street.width).toBeGreaterThan(0)
    }
  })
})

/** A city big enough to earn a ring boulevard, diagonals and a river. */
function largeCity(count = 220): DatabaseCityObject[] {
  const objects: DatabaseCityObject[] = []
  const perSchema = Math.ceil(count / 3)
  for (let index = 0; index < count; index += 1) {
    const ordinal = Math.floor(index / perSchema)
    objects.push(
      object(
        `object:${index}`,
        `schema:s${ordinal}`,
        ordinal,
        index % perSchema,
        String(1024 * (1 + (index % 40))),
        String(512 * (1 + (index % 40))),
      ),
    )
  }
  return objects
}

function largeOptions(seed = 'db:sales'): CityPlanOptions {
  return {
    seed,
    totalObjects: '220',
    schemas: [0, 1, 2].map(ordinal => ({
      schemaId: `schema:s${ordinal}`,
      name: `s${ordinal}`,
      neighborhoodOrdinal: ordinal,
      objectCount: '74',
      evidence,
    })),
  }
}

/**
 * The degree of every junction the network actually uses, plus the junctions it stranded.
 *
 * Degree — how many streets meet at a point — is what separates a real street network from a
 * lattice, and it is invisible to every other test in this file. A grid is ~100% four-way; a real
 * city is mostly T-junctions with a meaningful tail of dead ends.
 */
function junctionDegrees(plan: CityPlan) {
  const degree = new Map<string, number>()
  for (const id of plan.intersections.keys()) degree.set(id, 0)
  for (const street of plan.streets) {
    degree.set(street.fromId, (degree.get(street.fromId) ?? 0) + 1)
    degree.set(street.toId, (degree.get(street.toId) ?? 0) + 1)
  }
  const used = [...degree.values()].filter(count => count > 0)
  const share = (predicate: (count: number) => boolean) =>
    used.filter(predicate).length / Math.max(1, used.length)
  return {
    used,
    orphans: [...degree.values()].filter(count => count === 0).length,
    mean: used.reduce((total, count) => total + count, 0) / Math.max(1, used.length),
    deadEnds: share(count => count === 1),
    tees: share(count => count === 3),
    fourWay: share(count => count === 4),
  }
}

/*
 * Boeing, *A Multi-Scale Analysis of 27,000 Urban Street Networks* (2018), gives the shape of a real
 * street network: mean node degree 2.7–3.0, 57% T-junctions, 14.5% dead ends, and only 23% four-way.
 * A lattice sits at 4.0 and ~100% four-way, which is exactly why it reads as graph paper.
 *
 * Measured across four seeds and city sizes from 24 to 700 buildings, this planner holds mean degree
 * 2.5–2.7, dead ends 13.5–14.3%, T-junctions 27–40% and four-way crossings 10–19%. The bounds below
 * sit a little outside that so a new seed does not fail the build, and well inside a grid so removing
 * the junction pass does.
 */
describe('junction topology', () => {
  it('does not meet four streets at every corner, the way a grid does', () => {
    for (const seed of ['db:sales', 'db:warehouse', 'db:archive', 'db:ops']) {
      const plan = planCity(largeCity(), largeOptions(seed))
      const degrees = junctionDegrees(plan)
      expect(degrees.fourWay).toBeLessThan(0.3)
      expect(degrees.mean).toBeGreaterThan(2.3)
      expect(degrees.mean).toBeLessThan(3.2)
    }
  })

  it('turns more corners into T-junctions than into crossroads', () => {
    // The single cleanest statement of "this is not a grid": on graph paper the ratio is zero.
    const plan = planCity(largeCity(), largeOptions())
    const degrees = junctionDegrees(plan)
    expect(degrees.tees).toBeGreaterThan(degrees.fourWay * 1.5)
    expect(degrees.tees).toBeGreaterThan(0.28)
  })

  it('leaves roughly one street in seven to end rather than continue', () => {
    for (const seed of ['db:sales', 'db:ops']) {
      const degrees = junctionDegrees(planCity(largeCity(), largeOptions(seed)))
      expect(degrees.deadEnds).toBeGreaterThan(0.07)
      // A city of nothing but cul-de-sacs is as unreal as a city of nothing but crossroads.
      expect(degrees.deadEnds).toBeLessThan(0.25)
    }
  })

  it('leaves no junction stranded with no street to reach it by', () => {
    for (const seed of ['db:sales', 'db:warehouse']) {
      const plan = planCity(largeCity(), largeOptions(seed))
      expect(junctionDegrees(plan).orphans).toBe(0)
    }
  })

  it('keeps every part of the city reachable from every other part', () => {
    // Removing streets to make T-junctions is only safe if it never severs the network: a lot snapped
    // onto an island has no path anywhere, and the map then falls back to drawing a straight dogleg
    // across the city, through whatever is in the way. Swept across seeds and sizes because a split
    // graph is a property of a particular pattern landing on a particular cell — one fixture cannot
    // see it. The sweep is kept small because each plan is a full city and the point is coverage of
    // distinct seeds and scales, not exhaustiveness.
    const split: string[] = []
    for (const seed of ['db:sales', 'db:archive', 'db:ops']) {
      for (const count of [60, 300]) {
        const plan = planCity(largeCity(count), { ...largeOptions(seed), totalObjects: String(count) })
        const neighbours = new Map<string, string[]>()
        for (const street of plan.streets) {
          if (!neighbours.has(street.fromId)) neighbours.set(street.fromId, [])
          if (!neighbours.has(street.toId)) neighbours.set(street.toId, [])
          neighbours.get(street.fromId)!.push(street.toId)
          neighbours.get(street.toId)!.push(street.fromId)
        }
        const start = plan.streets[0]!.fromId
        const seen = new Set([start])
        const queue = [start]
        while (queue.length > 0) {
          for (const next of neighbours.get(queue.shift()!) ?? []) {
            if (seen.has(next)) continue
            seen.add(next)
            queue.push(next)
          }
        }
        if (seen.size !== neighbours.size) {
          split.push(`${seed} n=${count}: ${seen.size}/${neighbours.size} junctions reachable`)
        }
      }
    }
    expect(split).toEqual([])
  }, 30000)

  it('gives every built block a street to stand on', () => {
    const plan = planCity(largeCity(), largeOptions())
    for (const lot of plan.lots.values()) {
      // The access point is the lot's door, and it is bound to a carriageway the map draws.
      const nearest = Math.min(
        ...plan.streets.map(street => distanceToPath(street.path, lot.accessX, lot.accessZ)),
      )
      expect(nearest).toBeLessThanOrEqual(plan.streetWidth)
    }
  })
})

describe('street network', () => {
  it('draws every street between the intersections it connects', () => {
    const plan = planCity(largeCity(), largeOptions())
    for (const street of plan.streets) {
      const first = street.path[0]!
      const last = street.path[street.path.length - 1]!
      expect(street.path.length).toBeGreaterThan(1)
      // Curvature is decoration: it moves the middle of a road, never its ends, so the graph the
      // route finder walks is exactly the graph the map draws.
      expect(first.x).toBeCloseTo(street.fromX, 9)
      expect(first.z).toBeCloseTo(street.fromZ, 9)
      expect(last.x).toBeCloseTo(street.toX, 9)
      expect(last.z).toBeCloseTo(street.toZ, 9)
      expect(plan.intersections.has(street.fromId)).toBe(true)
      expect(plan.intersections.has(street.toId)).toBe(true)
    }
  })

  it('never runs a carriageway through a measured building', () => {
    // The single invariant that lets roads curve at all: a bowed street, an embankment shifted onto
    // the far bank and a diagonal avenue must all still miss every footprint the catalogue measured.
    const violations: string[] = []
    for (const seed of ['db:sales', 'db:warehouse', 'db:archive', 'db:ops']) {
      const plan = planCity(largeCity(), largeOptions(seed))
      const lots = [...plan.lots.values()].filter(lot => lot.footprint !== null)
      for (const street of plan.streets) {
        const reach = street.width / 2
        for (const point of street.path) {
          for (const lot of lots) {
            const half = lot.footprint! / 2 + reach
            if (Math.abs(point.x - lot.x) < half && Math.abs(point.z - lot.z) < half) {
              violations.push(`${seed}: ${street.id} (${street.streetClass}) hits ${lot.objectId}`)
            }
          }
        }
      }
    }
    expect(violations.slice(0, 5)).toEqual([])
  })

  it('bends most of its streets without turning any of them into a detour', () => {
    const plan = planCity(largeCity(), largeOptions())
    const curved = plan.streets.filter(street => street.path.length > 2)
    expect(curved.length).toBeGreaterThan(plan.streets.length * 0.5)

    // A curve costs a little length, and most streets pay almost nothing: the drawn line barely
    // exceeds the straight chord. A handful of edges are horseshoes left by merging two blocks into
    // one, whose short chord makes their ratio large without making them a detour anyone drives, so
    // the invariant is on the body of the distribution — the 95th percentile — not on the worst case.
    const detours = plan.streets.map(street => {
      const straight = Math.hypot(street.toX - street.fromX, street.toZ - street.fromZ)
      let drawn = 0
      for (let index = 1; index < street.path.length; index += 1) {
        drawn += Math.hypot(
          street.path[index]!.x - street.path[index - 1]!.x,
          street.path[index]!.z - street.path[index - 1]!.z,
        )
      }
      return straight < 1e-6 ? 1 : drawn / straight
    }).sort((left, right) => left - right)
    const median = detours[Math.floor(detours.length / 2)]!
    const p95 = detours[Math.floor(detours.length * 0.95)]!
    expect(median).toBeLessThan(1.1)
    expect(p95).toBeLessThan(1.5)
  })

  it('adds a road hierarchy the lattice alone could not express', () => {
    const plan = planCity(largeCity(), largeOptions())
    const classes = new Set(plan.streets.map(street => street.streetClass))
    // The classifier grades streets by through-traffic into the OpenStreetMap hierarchy. A city this
    // size always earns the busy middle of it; the extremes, motorway and service, come and go with
    // the seed, so the invariant is the spine every large city shares.
    expect(classes.has('primary')).toBe(true)
    expect(classes.has('secondary')).toBe(true)
    expect(classes.has('tertiary')).toBe(true)
    expect(classes.has('residential')).toBe(true)
  })

  it('runs its diagonal avenues between real intersections it did not invent', () => {
    const plan = planCity(largeCity(), largeOptions())
    const avenues = plan.streets.filter(street => street.axis === 'd')
    // A tensor field lays streets at whatever angle the field turns to, so diagonals are ordinary now
    // rather than a special short cut across a grid. The invariant that survives is that a diagonal is
    // still a real edge: it joins two junctions the graph already had, and it genuinely runs at a
    // slant rather than being mislabelled.
    expect(avenues.length).toBeGreaterThan(0)
    for (const avenue of avenues) {
      const from = plan.intersections.get(avenue.fromId)
      const to = plan.intersections.get(avenue.toId)
      expect(from).toBeDefined()
      expect(to).toBeDefined()
      const run = Math.abs(avenue.toX - avenue.fromX)
      const rise = Math.abs(avenue.toZ - avenue.fromZ)
      expect(Math.min(run, rise)).toBeGreaterThan(Math.max(run, rise) * 0.25)
    }
  })

  it('carries its crossings on bridges over the river', () => {
    const plan = planCity(largeCity(), largeOptions())
    // A river worth bridging, and at least one street that crosses it and is marked as a deck. A
    // bridge is just a street whose carriageway runs over open water, so it keeps the curve the field
    // gave it rather than being redrawn straight; the invariant is that the crossing is recognised.
    expect(plan.terrain.river.length).toBeGreaterThan(2)
    const bridges = plan.streets.filter(street => street.bridge)
    expect(bridges.length).toBeGreaterThan(0)
    for (const bridge of bridges) {
      expect(bridge.path.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('draws the same city twice for the same database', () => {
    const first = planCity(largeCity(), largeOptions())
    const second = planCity(largeCity(), largeOptions())
    expect(second.streets).toEqual(first.streets)
    expect([...second.lots.entries()]).toEqual([...first.lots.entries()])
  })
})
