import { describe, expect, it } from 'vitest'
import { blockAddress, buildAddressBook, columnLabel, searchAddressBook } from './addressBook'
import { planCity, type CityPlan } from './cityPlan'
import { FACILITY_ORDER, type Facility } from './cityInfrastructure'
import type {
  DatabaseCityObject,
  DatabaseCityQueryFamily,
  DatabaseCitySchema,
} from './databaseCityContracts'
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
  name: string,
  neighborhoodOrdinal: number,
  objectOrdinal: number,
  reservedPages: string | null = '4096',
): DatabaseCityObject {
  return {
    objectId,
    schemaId,
    schemaName: schemaId.replace('schema:', ''),
    name,
    kind: 'Table',
    reservedPages8KiB: reservedPages,
    usedPages8KiB: reservedPages === null ? null : '2048',
    reservedBytes: reservedPages === null ? null : String(BigInt(reservedPages) * 8192n),
    usedBytes: reservedPages === null ? null : String(2048n * 8192n),
    sizeStatus: reservedPages === null ? 'Unknown' : 'Known',
    sizeReason: reservedPages === null ? 'sys.allocation_units returned no row' : null,
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

function family(
  familyId: string,
  queryHash: string,
  objectIds: string[],
  cpu = '5000',
): DatabaseCityQueryFamily {
  return {
    familyId,
    queryHash,
    objectIds,
    executionCount: '120',
    totalCpuMicroseconds: cpu,
    totalDurationMicroseconds: '9000',
    totalLogicalReads8KiBPages: '400',
    totalWaitMilliseconds: '80',
    waitMillisecondsByCategory: {},
    confidence: 'Probable',
    rationale: 'plan references both objects',
    waitCategories: [],
    evidence,
  } as unknown as DatabaseCityQueryFamily
}

function facility(kind: Facility['kind'], label: string, known = true): Facility {
  return {
    kind,
    label,
    known,
    headline: known ? '42% utilised' : 'not sampled',
    status: known ? 'Available' : 'Unknown',
    reason: known ? 'live snapshot' : 'the DMV returned no row',
    units: [],
    alertCount: 0,
  }
}

const objects = [
  object('object:dbo:100', 'schema:dbo', 'Customer', 0, 0, '8192'),
  object('object:dbo:101', 'schema:dbo', 'Orders', 0, 1, '4096'),
  object('object:rep:300', 'schema:reporting', 'DailyTotals', 1, 0, null),
]

const schemas: DatabaseCitySchema[] = [
  { schemaId: 'schema:dbo', name: 'dbo', neighborhoodOrdinal: 0, objectCount: '2', evidence },
  { schemaId: 'schema:reporting', name: 'reporting', neighborhoodOrdinal: 1, objectCount: '1', evidence },
]

const families = [
  family('family:1', '0xAABBCC', ['object:dbo:100', 'object:dbo:101'], '90000'),
  family('family:2', '0xDDEEFF', ['object:rep:300'], '1000'),
]

const facilities = FACILITY_ORDER.map((kind, index) => facility(kind, `Facility ${index}`))

function samplePlan(): CityPlan {
  return planCity(objects, { seed: 'db:sales', totalObjects: '3', schemas })
}

describe('columnLabel', () => {
  it('letters columns the way a spreadsheet does', () => {
    expect(columnLabel(0)).toBe('A')
    expect(columnLabel(25)).toBe('Z')
    expect(columnLabel(26)).toBe('AA')
    expect(columnLabel(27)).toBe('AB')
    expect(columnLabel(51)).toBe('AZ')
    expect(columnLabel(52)).toBe('BA')
  })
})

describe('blockAddress', () => {
  it('names the block a position stands on, and prefixes the district when there is one', () => {
    const plan = samplePlan()
    // A block is a face of the street graph now, so the letter is the block's own id and the row is
    // fixed at one; the address is whatever the plan's warp says stands at that point.
    const { col } = plan.warp.blockAt(0, 0)
    const expected = `Block ${columnLabel(col)}1`
    expect(blockAddress(plan, 0, 0)).toBe(expected)
    expect(blockAddress(plan, 0, 0, 'dbo')).toBe(`dbo · ${expected}`)
  })

  it('gives each block its own letter, with the row fixed at one now the grid is gone', () => {
    const plan = samplePlan()
    const ids = [...new Set([...plan.lots.values()].map(lot => lot.blockCol))]
    expect(ids.length).toBeGreaterThan(1)
    for (const id of ids) {
      const centre = plan.warp.blockCenter(id, 0)
      const { col, row } = plan.warp.blockAt(centre.x, centre.z)
      // Row is no longer a coordinate — every block sits on row zero and reads as one.
      expect(row).toBe(0)
      expect(blockAddress(plan, centre.x, centre.z)).toBe(`Block ${columnLabel(col)}1`)
    }
  })

  it('never produces a negative block for a position far outside the city', () => {
    const plan = samplePlan()
    // The nearest block is named rather than a negative one invented, so the label is always valid.
    expect(blockAddress(plan, -9999, -9999)).toMatch(/^Block [A-Z]+1$/)
  })
})

describe('buildAddressBook', () => {
  it('carries all three kinds in one flat list', () => {
    const entries = buildAddressBook(objects, families, facilities, samplePlan())
    expect(entries.filter(entry => entry.kind === 'query')).toHaveLength(families.length)
    expect(entries.filter(entry => entry.kind === 'table')).toHaveLength(objects.length)
    expect(entries.filter(entry => entry.kind === 'facility')).toHaveLength(facilities.length)
  })

  it('gives every table an address on the map it is drawn on', () => {
    const plan = samplePlan()
    const entries = buildAddressBook(objects, families, facilities, plan)
    for (const entry of entries.filter(candidate => candidate.kind === 'table')) {
      const lot = plan.lots.get(entry.targetId)!
      expect(entry.address).toBe(blockAddress(plan, lot.x, lot.z, entry.address!.split(' · ')[0]))
      expect(entry.address).toMatch(/Block [A-Z]+\d+$/)
    }
  })

  it('says an unknown size is unavailable rather than calling it zero', () => {
    const entries = buildAddressBook(objects, families, facilities, samplePlan())
    const unknown = entries.find(entry => entry.targetId === 'object:rep:300')!
    expect(unknown.meta).toContain('size unavailable')
    expect(unknown.meta).not.toContain('0 reserved')
  })

  it('names the objects a query visits, and distinguishes the two kinds of silence', () => {
    // One id that resolves to nothing is a reference into another database, not an absence of one.
    const otherDatabase = buildAddressBook(objects, [
      family('family:3', '0x112233', ['object:elsewhere:1']),
    ], facilities, samplePlan())
    expect(otherDatabase[0].address).toBe('Names one object in another database')

    const otherDatabaseMany = buildAddressBook(objects, [
      family('family:4', '0x445566', ['object:elsewhere:1', 'object:elsewhere:2']),
    ], facilities, samplePlan())
    expect(otherDatabaseMany[0].address).toBe('Names 2 objects in another database')

    // A family whose plans named no object at all says exactly that, not that one is elsewhere.
    const nowhere = buildAddressBook(objects, [
      family('family:5', '0x778899', []),
    ], facilities, samplePlan())
    expect(nowhere[0].address).toBe('Plans named no object in this database')

    const visiting = buildAddressBook(objects, families, facilities, samplePlan())
      .find(entry => entry.targetId === 'family:1')!
    expect(visiting.address).toContain('dbo.Customer')
    expect(visiting.address).toContain('dbo.Orders')
  })

  it('counts the cross-database references alongside the tables a query does visit', () => {
    // A plan that touches a local table and one in another database gets both truths: the local
    // stop by name, and a count of what it reached across the boundary the map cannot draw.
    const mixed = buildAddressBook(objects, [
      family('family:6', '0xAA00BB', ['object:dbo:100', 'object:elsewhere:9']),
    ], facilities, samplePlan())
    expect(mixed[0].address).toBe('Visits dbo.Customer (+1 in another database)')
    // The cross-database id stays in the haystack so the query is still findable by it.
    expect(mixed[0].searchText).toContain('object:elsewhere:9')
  })

  it('reports an unsampled facility with its status rather than hiding it', () => {
    const partial = [facility(FACILITY_ORDER[0], 'CPU', false), ...facilities.slice(1)]
    const entries = buildAddressBook(objects, families, partial, samplePlan())
    const cpu = entries.find(entry => entry.id === `facility:${FACILITY_ORDER[0]}`)!
    expect(cpu.meta).toContain('Unknown')
    expect(cpu.meta).toContain('not sampled')
  })
})

describe('searchAddressBook', () => {
  const entries = buildAddressBook(objects, families, facilities, samplePlan())
  const groupOf = (term: string, kind: 'query' | 'table' | 'facility') =>
    searchAddressBook(entries, term).find(group => group.kind === kind)?.entries ?? []

  it('groups in a fixed order and drops empty groups', () => {
    expect(searchAddressBook(entries, '').map(group => group.kind))
      .toEqual(['query', 'table', 'facility'])
    expect(searchAddressBook(entries, 'utilised').map(group => group.kind)).toEqual(['facility'])
  })

  it('finds a table by schema, by name, and by qualified name', () => {
    expect(groupOf('dbo', 'table').map(entry => entry.name)).toEqual(['dbo.Customer', 'dbo.Orders'])
    expect(groupOf('orders', 'table').map(entry => entry.name)).toEqual(['dbo.Orders'])
    expect(groupOf('dbo.customer', 'table').map(entry => entry.name)).toEqual(['dbo.Customer'])
  })

  it('finds a query by its hash, its rationale, and the tables it visits', () => {
    expect(groupOf('0xaabbcc', 'query').map(entry => entry.targetId)).toEqual(['family:1'])
    expect(groupOf('plan references', 'query')).toHaveLength(families.length)
    // Searching a table name surfaces the queries that drive traffic to it, which is the point of
    // one unified list: you look up a place, not a category.
    expect(groupOf('customer', 'query').map(entry => entry.targetId)).toEqual(['family:1'])
  })

  it('finds a facility by its label', () => {
    expect(groupOf('facility 0', 'facility')).toHaveLength(1)
  })

  it('narrows with every token rather than widening', () => {
    const wide = searchAddressBook(entries, 'dbo').flatMap(group => group.entries)
    const narrow = searchAddressBook(entries, 'dbo orders').flatMap(group => group.entries)
    expect(narrow.length).toBeLessThan(wide.length)
    expect(narrow.map(entry => entry.name)).toContain('dbo.Orders')
  })

  it('is case-insensitive', () => {
    expect(groupOf('CUSTOMER', 'table').map(entry => entry.name)).toEqual(['dbo.Customer'])
  })

  it('returns nothing rather than everything when nothing matches', () => {
    expect(searchAddressBook(entries, 'no-such-thing-anywhere')).toEqual([])
  })

  it('ranks the heaviest first within a group', () => {
    expect(groupOf('', 'table')[0].name).toBe('dbo.Customer')
    expect(groupOf('', 'query')[0].targetId).toBe('family:1')
  })

  it('keeps facilities in their fixed landmark order, not a measured one', () => {
    expect(groupOf('', 'facility').map(entry => entry.targetId)).toEqual([...FACILITY_ORDER])
  })
})

/*
 * Where the ordering lives.
 *
 * The order within a group never depends on the search term, so it is established once when the
 * book is built and carried through by `filter`, which is stable. These two tests pin the halves of
 * that contract from opposite sides: the book comes out ordered, and the search does not re-order.
 * Together they are what stops the comparator being moved back into the typing path.
 */
describe('where the address book is ordered', () => {
  // Deliberately not in rank order, so an implementation that returns the input untouched fails.
  const unsorted = [
    object('object:dbo:1', 'schema:dbo', 'Small', 0, 0, '10'),
    object('object:dbo:2', 'schema:dbo', 'Largest', 0, 1, '9000'),
    object('object:dbo:3', 'schema:dbo', 'Middling', 0, 2, '500'),
  ]
  const unsortedFamilies = [
    family('family:cheap', '0x111111', [], '10'),
    family('family:dear', '0x222222', [], '99000'),
  ]

  it('hands back a book that is already in order, so searching never has to sort', () => {
    const plan = planCity(unsorted, {
      seed: 'db:order',
      totalObjects: '3',
      schemas: [{ schemaId: 'schema:dbo', name: 'dbo', neighborhoodOrdinal: 0, objectCount: '3', evidence }],
    })
    const built = buildAddressBook(unsorted, unsortedFamilies, facilities, plan)

    expect(built.filter(entry => entry.kind === 'table').map(entry => entry.name))
      .toEqual(['dbo.Largest', 'dbo.Middling', 'dbo.Small'])
    expect(built.filter(entry => entry.kind === 'query').map(entry => entry.targetId))
      .toEqual(['family:dear', 'family:cheap'])
    expect(built.filter(entry => entry.kind === 'facility').map(entry => entry.targetId))
      .toEqual([...FACILITY_ORDER])
  })

  it('preserves the order it was given rather than sorting on every keystroke', () => {
    const plan = samplePlan()
    // Reversed on the way in. A search that sorts would put Customer back on top; one that only
    // filters must hand back exactly the order it received.
    const reversed = [...buildAddressBook(objects, families, facilities, plan)].reverse()
    const tables = searchAddressBook(reversed, 'dbo').find(group => group.kind === 'table')?.entries ?? []
    expect(tables.map(entry => entry.name)).toEqual(['dbo.Orders', 'dbo.Customer'])
  })
})