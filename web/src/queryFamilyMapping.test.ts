import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  familyOnMap,
  placedObjectIds,
  splitQueryFamiliesByMap,
} from './queryFamilyMapping'
import { buildAddressBook, queryAddressId } from './addressBook'
import type { DatabaseCityObject, DatabaseCityQueryFamily } from './databaseCityContracts'

function family(familyId: string, objectIds: string[]): DatabaseCityQueryFamily {
  return {
    familyId,
    queryHash: `0x${familyId}`,
    executionCount: 1,
    totalCpuMicroseconds: 1,
    totalDurationMicroseconds: 1,
    totalLogicalReads8KiBPages: 1,
    objectIds,
    confidence: 'Attributed',
    rationale: 'seeded',
    evidence: { source: 'QueryStore', reason: 'seeded' },
  } as unknown as DatabaseCityQueryFamily
}

function object(objectId: string): DatabaseCityObject {
  return { objectId, name: objectId, schemaId: 's', schemaName: 's' } as unknown as DatabaseCityObject
}

const PLACED = placedObjectIds([object('a'), object('b')])

describe('familyOnMap', () => {
  it('accepts a family naming an object the page placed', () => {
    expect(familyOnMap(family('f1', ['a']), PLACED)).toBe(true)
  })

  it('rejects a family that named nothing at all', () => {
    expect(familyOnMap(family('f2', []), PLACED)).toBe(false)
  })

  /*
   * The distinction the whole filter rests on, and the one a "has any object id" test gets wrong.
   *
   * The city is paged, and `buildStops` in `cityRoute.ts` matches a showplan's references against
   * the objects this view has *loaded* -- an unmatched reference becomes an `offmap` stop, not a
   * building. So a family naming only objects from an unloaded page carries ids, passes the loose
   * test, and still draws a route with no stop on it. Measured on `SimCitySmall` at 48 published
   * families this is not a corner case: 20 families carry an id, 18 name a placed one.
   */
  it('rejects a family whose only objects are on a page this view has not loaded', () => {
    expect(familyOnMap(family('f3', ['off-page-1', 'off-page-2']), PLACED)).toBe(false)
  })

  it('accepts a family that names a placed object alongside off-page ones', () => {
    expect(familyOnMap(family('f4', ['off-page-1', 'b']), PLACED)).toBe(true)
  })
})

describe('splitQueryFamiliesByMap', () => {
  const families = [
    family('mapped-1', ['a']),
    family('mapped-2', ['b', 'off-page']),
    family('none', []),
    family('offpage-only', ['off-page']),
  ]

  it('hides the families with nothing on the map by default', () => {
    const split = splitQueryFamiliesByMap(families, PLACED, false)
    expect(split.shown.map(entry => entry.familyId)).toEqual(['mapped-1', 'mapped-2'])
    expect(split.mapped).toBe(2)
    expect(split.unmapped).toBe(2)
    expect(split.total).toBe(4)
  })

  it('lists every family when the toggle is on', () => {
    const split = splitQueryFamiliesByMap(families, PLACED, true)
    expect(split.shown).toHaveLength(4)
    // Counts are over the whole list either way: a label that stopped reporting the hidden set once
    // it was shown would leave no way to tell a filtered list from an unfiltered one.
    expect(split.unmapped).toBe(2)
  })

  it('discloses the hidden count in the toggle label rather than dropping it silently', () => {
    const off = splitQueryFamiliesByMap(families, PLACED, false)
    expect(off.toggleLabel).toContain('2 of 4')
    expect(off.toggleLabel).toMatch(/^Show /)
    const on = splitQueryFamiliesByMap(families, PLACED, true)
    expect(on.toggleLabel).toContain('2 of 4')
    expect(on.toggleLabel).toMatch(/^Showing /)
  })

  it('says the list is complete rather than implying a filter when nothing is hidden', () => {
    const split = splitQueryFamiliesByMap([family('mapped-1', ['a'])], PLACED, false)
    expect(split.unmapped).toBe(0)
    expect(split.toggleLabel).toContain('none of the 1 are hidden')
    expect(split.reason).toContain('All 1 published family')
  })

  /*
   * The house rule from `feedReason` in `liveQueryFeed.ts`: hidden data is stated, and stated with
   * the scope it was measured against, so a short list is never read as a quiet database.
   */
  it('states both the hidden count and what "on this map" was measured against', () => {
    const split = splitQueryFamiliesByMap(families, PLACED, false)
    expect(split.reason).toContain('2 of 4')
    expect(split.reason).toContain('2 objects this page has placed')
    expect(split.reason).toContain('not against every object in the database')
  })

  it('reports no families without claiming anything was filtered', () => {
    const split = splitQueryFamiliesByMap([], PLACED, false)
    expect(split.shown).toEqual([])
    expect(split.reason).toContain('No query family has been published')
  })
})

/*
 * Read as source text because `web/` has no DOM harness: there is no jsdom and no testing-library
 * here, so a rendered assertion is not available. The guards below are the same shape as
 * `shadowInvalidation.test.ts`, which pins a rule about `DatabaseCityScene.ts` the same way.
 */
const view = readFileSync(fileURLToPath(new URL('./DatabaseCityView.tsx', import.meta.url)), 'utf8')
/** Comments stripped first, so a doc comment *explaining* a rule does not read as a use of it. */
const code = view
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

describe('feed and address-book clicks select the same family', () => {
  /*
   * The fix for the divergence, pinned at its cause rather than its symptom.
   *
   * `showFamilyOnMap` has three callers -- the address book, the live query feed and the ranked
   * families table -- and only the address book used to set the selection, so the other two left
   * the rail in a different state for the same family. Setting it inside the shared function is
   * what makes the three identical; asserting that each *caller* sets it would pass just as well
   * against the arrangement that drifted.
   */
  it('sets the selected address inside showFamilyOnMap, not in each caller', () => {
    const start = code.indexOf('const showFamilyOnMap = useCallback')
    expect(start).toBeGreaterThan(-1)
    const body = code.slice(start, code.indexOf('const addressEntries = useMemo', start))
    expect(body).toContain('navigation.openFamily(')
    const owner = readFileSync(new URL('./cityPlanNavigation.ts', import.meta.url), 'utf8')
    expect(owner).toContain('selectedAddressId: familyId ? queryAddressId(familyId) : null')
  })

  it('has openAddress delegate the query case rather than selecting it separately', () => {
    const start = code.indexOf('const openAddress = useCallback')
    expect(start).toBeGreaterThan(-1)
    const body = code.slice(start, code.indexOf('const selectedFacility', start))
    expect(body).toContain('void showFamilyOnMap(family)')
    /*
     * The precise thing that was wrong, and the reason this is an assertion about the *first*
     * statement rather than about the presence of a call.
     *
     * `openAddress` used to open with an unconditional `setSelectedAddressId(entry.id)` and then
     * branch, so the query case selected the row here and `showFamilyOnMap` selected nothing.
     * That is what let the feed and the list diverge, and it is what would silently come back:
     * selecting in both places works today and re-creates the drift the moment either side
     * changes. Asserting only that the delegation exists passes against the broken arrangement,
     * because the broken arrangement delegated too.
     */
    expect(body).not.toMatch(/useCallback\(\(entry: AddressEntry\) => \{\s*setSelectedAddressId\(entry\.id\)/)
    expect(body).toMatch(/useCallback\(\(entry: AddressEntry\) => \{\s*if \(entry\.kind === 'query'\)/)
  })

  it('routes every showFamilyOnMap caller through the one function', () => {
    // Directory, live feed, ranked families and road contributors all use the same owner.
    expect(code.match(/onShowFamily=\{showFamilyOnMap\}/g) ?? []).toHaveLength(3)
    expect(code).toContain('showFamilyOnMap(family)')
  })
})

describe('queryAddressId', () => {
  /*
   * The id template is shared rather than written twice, and this is what makes that load-bearing:
   * `showFamilyOnMap` selects by it while `buildAddressBook` mints it, and a drift between the two
   * would not fail loudly -- the row would simply never highlight.
   */
  it('is the id buildAddressBook actually mints for a query family', () => {
    const entries = buildAddressBook(
      [],
      [family('QF-7', ['a'])],
      [],
      { facilities: new Map(), blocks: new Map() } as never,
    )
    const entry = entries.find(candidate => candidate.kind === 'query')
    expect(entry?.id).toBe(queryAddressId('QF-7'))
  })

  it('is imported by the view rather than re-inlined there', () => {
    expect(code).toContain("queryAddressId, type AddressEntry } from './addressBook'")
    expect(code).not.toMatch(/setSelectedAddressId\(`query:\$\{/)
  })
})

describe('the families table filter is wired to the shared split', () => {
  it('renders the split rather than the raw family list', () => {
    expect(code).toContain('familySplit.shown.map(family =>')
    expect(code).not.toContain('page.topQueryFamilies.map(family =>')
  })

  it('defaults the toggle to off', () => {
    expect(code).toContain('useState(false)')
    expect(code).toMatch(/const \[showUnmappedFamilies, setShowUnmappedFamilies\] = useState\(false\)/)
  })

  it('shows the hidden count in the label and the scope under the table', () => {
    expect(code).toContain('{familySplit.toggleLabel}')
    expect(code).toContain('{familySplit.reason}')
  })

  it('no longer claims a fixed top 12', () => {
    // The published count is configurable via `DatabaseCity:TopQueryFamilyCount` and defaults to 48.
    expect(code).not.toContain('Backend-ranked top 12')
    expect(code).toContain('Backend-ranked top {page.topQueryFamilies.length}')
  })

  it('offers no "Show on map" control for a family that would draw no stop', () => {
    expect(code).toContain('familyOnMap(family, placedIds) ?')
    expect(code).toContain('Nothing on this map')
  })
})
