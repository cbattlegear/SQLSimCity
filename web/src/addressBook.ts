import type { CityPlan } from './cityPlan'
import type { Facility } from './cityInfrastructure'
import type { DatabaseCityObject, DatabaseCityQueryFamily } from './databaseCityContracts'

/**
 * The address book: one flat, searchable index of everything the map can take you to.
 *
 * A city has three kinds of destination — the query families that generate the traffic, the tables
 * those queries visit, and the infrastructure facilities where their waits end up. Splitting them
 * across three lists would make you know which list a thing lives in before you could look it up,
 * so they share one list and one search box, grouped only for legibility.
 *
 * Every entry carries an **address** derived from the city plan, which is what makes this an address
 * book rather than a table of contents: it tells you where on the map the thing actually is. An
 * entry whose object was not on the loaded page has no lot and therefore no address, and says so
 * rather than inventing a location.
 */

export type AddressKind = 'query' | 'table' | 'facility'

export interface AddressEntry {
  readonly id: string
  readonly kind: AddressKind
  /** Stable target used by the map: object id, facility kind, or query family id. */
  readonly targetId: string
  readonly name: string
  /** One-line measured summary. Never a verdict, always a quantity or an explicit unavailability. */
  readonly meta: string
  /** Where it stands, from the city plan, or null when this entry has no lot on the loaded page. */
  readonly address: string | null
  /** Lowercased haystack the search box matches against. */
  readonly searchText: string
  /** Sort key within a group. Higher sorts first. */
  readonly rank: number
}

export interface AddressGroup {
  readonly kind: AddressKind
  readonly label: string
  readonly entries: readonly AddressEntry[]
}

const GROUP_LABELS: Readonly<Record<AddressKind, string>> = {
  query: 'Query families',
  table: 'Tables and views',
  facility: 'Infrastructure',
}

/** Column letters for block addresses: 0 → A, 25 → Z, 26 → AA. Mirrors spreadsheet lettering. */
export function columnLabel(index: number): string {
  let remaining = index
  let label = ''
  do {
    label = String.fromCharCode(65 + (remaining % 26)) + label
    remaining = Math.floor(remaining / 26) - 1
  } while (remaining >= 0)
  return label
}

/**
 * A human-readable address for a world position, as `District · Block C4`.
 *
 * The block comes from the plan's own warp rather than from a division, because the blocks are traced
 * from a tensor field and no two are the same size — so `x / pitch` would name a block the map does
 * not draw there. It is a locator and carries no quantity claim.
 */
export function blockAddress(plan: CityPlan, x: number, z: number, districtName?: string): string {
  const { col, row } = plan.warp.blockAt(x, z)
  const block = `Block ${columnLabel(Math.max(0, col))}${Math.max(0, row) + 1}`
  return districtName ? `${districtName} · ${block}` : block
}

function toNumber(value: string | null): number {
  if (value === null) return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function compactCount(value: string | null): string {
  if (value === null) return 'unavailable'
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return value
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(parsed)
}

function objectEntry(object: DatabaseCityObject, plan: CityPlan): AddressEntry {
  const lot = plan.lots.get(object.objectId)
  const district = plan.districts.find(candidate => candidate.districtId === object.schemaId)
  const name = `${object.schemaName}.${object.name}`
  const size = object.sizeStatus === 'Known'
    ? `${compactCount(object.reservedPages8KiB)} reserved pages`
    : 'size unavailable'
  return {
    id: `table:${object.objectId}`,
    kind: 'table',
    targetId: object.objectId,
    name,
    meta: `${object.kind} · ${size}`,
    address: lot ? blockAddress(plan, lot.x, lot.z, district?.name) : null,
    searchText: `${name} ${object.kind} ${object.schemaName} ${object.name}`.toLowerCase(),
    rank: toNumber(object.reservedPages8KiB),
  }
}

function queryEntry(family: DatabaseCityQueryFamily, objectNames: ReadonlyMap<string, string>): AddressEntry {
  const stops = family.objectIds
    .map(id => objectNames.get(id))
    .filter((value): value is string => value !== undefined)
  // Ids that did not resolve are references to objects in *other* databases: the collector carries
  // them as three-part names it cannot place on this city's map. Distinguishing that from "no
  // reference at all" is the same distinction the collector draws between absent and cross-database
  // evidence, and collapsing both into one phrase is what made real multi-object plans read as empty.
  const unresolved = family.objectIds.length - stops.length
  let address: string
  if (stops.length > 0) {
    const visits = stops.slice(0, 3).join(', ') + (stops.length > 3 ? ` +${stops.length - 3} more` : '')
    address = unresolved > 0
      ? `Visits ${visits} (+${unresolved} in another database)`
      : `Visits ${visits}`
  } else if (family.objectIds.length > 0) {
    address = family.objectIds.length === 1
      ? 'Names one object in another database'
      : `Names ${family.objectIds.length} objects in another database`
  } else {
    address = 'Plans named no object in this database'
  }
  return {
    id: `query:${family.familyId}`,
    kind: 'query',
    targetId: family.familyId,
    name: `Query ${family.queryHash}`,
    meta: `${compactCount(family.executionCount)} executions · ${compactCount(family.totalCpuMicroseconds)} µs CPU`,
    address,
    // Search over every reference the family named, resolved names and the raw ids of the
    // cross-database ones alike, so a query stays findable by a table it touches in either database.
    searchText: `${family.queryHash} ${family.familyId} ${stops.join(' ')} ${family.objectIds.join(' ')} ${family.rationale}`.toLowerCase(),
    rank: toNumber(family.totalCpuMicroseconds),
  }
}

function facilityEntry(facility: Facility, plan: CityPlan, index: number): AddressEntry {
  const site = plan.facilities.get(facility.kind)
  return {
    id: `facility:${facility.kind}`,
    kind: 'facility',
    targetId: facility.kind,
    name: facility.label,
    meta: facility.known ? facility.headline : `${facility.status} · ${facility.headline}`,
    address: site ? blockAddress(plan, site.x, site.z) : null,
    searchText: `${facility.label} ${facility.kind} ${facility.headline}`.toLowerCase(),
    // Facilities are landmarks in a fixed order, so their rank is that order, not a measurement.
    rank: -index,
  }
}

export function buildAddressBook(
  objects: readonly DatabaseCityObject[],
  families: readonly DatabaseCityQueryFamily[],
  facilities: readonly Facility[],
  plan: CityPlan,
): AddressEntry[] {
  const objectNames = new Map(objects.map(object => [object.objectId, `${object.schemaName}.${object.name}`]))
  return [
    ...families.map(family => queryEntry(family, objectNames)),
    ...objects.map(object => objectEntry(object, plan)),
    ...facilities.map((facility, index) => facilityEntry(facility, plan, index)),
  ]
}

/**
 * Filters the book by a free-text term and groups what survives.
 *
 * Matching is a simple case-insensitive substring over each entry's own haystack — every token in
 * the term must appear somewhere, so "orders cpu" narrows rather than widens. Empty groups are
 * dropped so a search never shows a heading with nothing under it.
 */
export function searchAddressBook(entries: readonly AddressEntry[], term: string): AddressGroup[] {
  const tokens = term.toLowerCase().split(/\s+/).filter(token => token !== '')
  const matched = tokens.length === 0
    ? [...entries]
    : entries.filter(entry => tokens.every(token => entry.searchText.includes(token)))

  const order: AddressKind[] = ['query', 'table', 'facility']
  return order
    .map(kind => ({
      kind,
      label: GROUP_LABELS[kind],
      entries: matched
        .filter(entry => entry.kind === kind)
        .sort((left, right) => right.rank - left.rank || left.name.localeCompare(right.name)),
    }))
    .filter(group => group.entries.length > 0)
}
