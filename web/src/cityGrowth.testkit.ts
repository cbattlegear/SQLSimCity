/**
 * The fixtures behind the `cityGrowth*` specs: a synthetic database of `count` objects, and the
 * comparisons that decide whether adding one to it moved anything.
 *
 * Does the city survive the database changing under it?
 *
 * Issue #47 measured that above 75 objects, adding a single table retraced every street and moved
 * every building, so nothing a user had learned about where things are survived a schema change.
 * Those specs are that measurement, kept: they plan a city, add a table, and compare the two plans
 * street by street and building by building.
 *
 * The property under test is deliberately narrow and absolute -- *no* existing building moves --
 * because anything softer is unfalsifiable. A city that reshuffles "only a bit" is still a city you
 * have to relearn.
 *
 * Not a spec itself. The `.testkit.ts` suffix keeps it out of vitest's `*.test.ts` collection, so
 * the specs can share these fixtures without registering each other's suites a second time.
 *
 * They are separate files rather than one because planning a city is seconds of honest work and
 * vitest parallelises across files but not within one. Held together they were 36.7s of a 44s web
 * suite -- one file the other 41 waited on. Anything added here belongs in whichever spec keeps its
 * own file's cost off the critical path.
 */
import { planCity, type CityPlan, type CityPlanOptions } from './cityPlan'
import type { DatabaseCityObject, DatabaseCitySchema } from './databaseCityContracts'
import type { Evidence } from './contracts'

const evidence: Evidence = {
  source: 'CatalogSnapshot',
  status: 'Available',
  observedAt: null,
  freshUntil: null,
  reason: 'test',
}

const SCHEMA_COUNT = 3

/**
 * Sizes spanning the ones issue #47 measured, chosen to sit *between* rungs of the growth ladder,
 * because that is where almost every database sits: a rung is a 25% jump, so at a hundred tables
 * only one added table in twenty-five lands on one. The rungs themselves are asserted separately
 * rather than quietly excluded.
 */
export const GROWTH_SIZES = [5, 15, 74, 100, 200, 500]

/**
 * Each case plans two cities, and at the larger sizes both can miss the traced-network cache and
 * lay a street network from scratch, which is seconds of honest work rather than a hang. Vitest's
 * five second default sits right on that boundary, so it is stated here instead of left to decide
 * the result by how busy the machine is.
 */
export const PLAN_TIMEOUT_MS = 60_000

function schemaIdFor(index: number): string {
  return `schema:s${index % SCHEMA_COUNT}`
}

/**
 * Reserved pages for the object at `index`, spread over four orders of magnitude.
 *
 * Sizes have to vary, because the old placement matched objects to blocks by footprint rank and a
 * city of identically sized tables would hide exactly the churn being measured. Deliberately not
 * monotonic in the index, so a table added at the end is an ordinary-sized table rather than always
 * the largest or the smallest.
 */
function reservedPagesFor(index: number): string {
  return String(8 + ((index * 2654435761) % 40_000))
}

/**
 * The id the connected collector builds for an object: `{databaseId}/object/{sys.objects.object_id}`,
 * with the id written out unpadded exactly as that collector writes it.
 *
 * Unpadded on purpose. Placement hands out ground in catalogue order and relies on a newly created
 * table sorting after every table already there; compared as text an unpadded id breaks that, because
 * `object/9` sorts after `object/1234567`. Padding these in the test would hide the one property the
 * specs exist to prove. The base of 3 puts the run across both the 9-to-10 and 99-to-100
 * boundaries, where a text comparison and a numeric one disagree.
 */
export function objectIdFor(index: number): string {
  return `db:growth/object/${index + 3}`
}

function object(index: number): DatabaseCityObject {
  const schemaId = schemaIdFor(index)
  const reserved = reservedPagesFor(index)
  const used = String(Math.floor(Number(reserved) * 0.8))
  return {
    objectId: objectIdFor(index),
    schemaId,
    schemaName: schemaId.replace('schema:', ''),
    name: `t${index}`,
    kind: 'Table',
    reservedPages8KiB: reserved,
    usedPages8KiB: used,
    reservedBytes: String(BigInt(reserved) * 8192n),
    usedBytes: String(BigInt(used) * 8192n),
    sizeStatus: 'Known',
    sizeReason: null,
    layout: {
      neighborhoodOrdinal: index % SCHEMA_COUNT,
      // The connected collector numbers objects across the whole database in object-id order.
      objectOrdinal: index,
      x: 0,
      z: 0,
    },
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

function schemasFor(objects: readonly DatabaseCityObject[]): DatabaseCitySchema[] {
  const counts = new Map<string, number>()
  for (const item of objects) counts.set(item.schemaId, (counts.get(item.schemaId) ?? 0) + 1)
  return [...counts.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : 1))
    .map(([schemaId, count], index) => ({
      schemaId,
      name: schemaId.replace('schema:', ''),
      neighborhoodOrdinal: index,
      objectCount: String(count),
      evidence,
    }))
}

/** The city a database of `count` objects reports, exactly as a completed page walk would carry it. */
export function cityOf(count: number): { objects: DatabaseCityObject[]; options: CityPlanOptions } {
  const objects = Array.from({ length: count }, (_, index) => object(index))
  return {
    objects,
    options: {
      seed: 'db:growth',
      totalObjects: String(count),
      schemas: schemasFor(objects),
    },
  }
}

export function planOf(count: number): CityPlan {
  const { objects, options } = cityOf(count)
  return planCity(objects, options)
}

/** Every street's identity and drawn shape, so a retraced network cannot compare equal to the old one. */
export function streetSignature(plan: CityPlan): string {
  return plan.streets
    .map(street =>
      [
        street.id,
        street.streetClass,
        ...street.path.map(point => `${point.x.toFixed(2)},${point.z.toFixed(2)}`),
      ].join('|'),
    )
    .sort()
    .join('\n')
}

export function lotsOf(plan: CityPlan): Map<string, string> {
  const lots = new Map<string, string>()
  for (const [objectId, lot] of plan.lots) lots.set(objectId, lot.blockId)
  return lots
}

/** How many buildings present in both plans stand on a different block in the second. */
export function movedBuildings(before: CityPlan, after: CityPlan): string[] {
  const first = lotsOf(before)
  const second = lotsOf(after)
  const moved: string[] = []
  for (const [objectId, blockId] of first) {
    const now = second.get(objectId)
    if (now !== undefined && now !== blockId) moved.push(objectId)
  }
  return moved
}
