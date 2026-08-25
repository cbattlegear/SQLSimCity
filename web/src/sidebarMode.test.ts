import { describe, expect, it } from 'vitest'
import { resolveSidebarMode, ROUTE_TITLE, type SidebarRouteSummary } from './sidebarMode'

const route: SidebarRouteSummary = { planId: '42', placedStops: 3, totalStops: 4, offMapStops: 1 }

describe('resolveSidebarMode with no route open', () => {
  const mode = resolveSidebarMode({ databaseName: 'AdventureWorks', totalObjectsLabel: '1,234', route: null })

  it('titles the header with the database name', () => {
    expect(mode.title).toBe('AdventureWorks')
  })

  it('subtitles with the object count and city label', () => {
    expect(mode.subtitle).toBe('1,234 objects · database city')
  })

  it('sends the back button to the server atlas without touching a route', () => {
    expect(mode.backLabel).toBe('Back to the server atlas')
    expect(mode.clearsRoute).toBe(false)
  })

  it('renders the address book', () => {
    expect(mode.showsAddressBook).toBe(true)
  })
})

describe('resolveSidebarMode with a route open', () => {
  const mode = resolveSidebarMode({ databaseName: 'AdventureWorks', totalObjectsLabel: '1,234', route })

  it('renames the header to the route', () => {
    expect(mode.title).toBe(ROUTE_TITLE)
    expect(mode.title).not.toBe('AdventureWorks')
  })

  it('carries the plan id and placed/total stop count in the subtitle', () => {
    expect(mode.subtitle).toBe('Plan 42 · 3 of 4 tables placed · 1 off-map')
  })

  it('turns the back button into a clear-route control back to the database', () => {
    expect(mode.backLabel).toBe('Back to AdventureWorks')
    expect(mode.clearsRoute).toBe(true)
  })

  it('collapses the address book so the route fills the rail', () => {
    expect(mode.showsAddressBook).toBe(false)
  })
})

describe('resolveSidebarMode subtitle detail', () => {
  it('singularises a one-table route and omits off-map when there is none', () => {
    const mode = resolveSidebarMode({
      databaseName: 'db',
      totalObjectsLabel: '9',
      route: { planId: '7', placedStops: 1, totalStops: 1, offMapStops: 0 },
    })
    expect(mode.subtitle).toBe('Plan 7 · 1 of 1 table placed')
  })

  it('reports every stop off-map when none could be drawn', () => {
    const mode = resolveSidebarMode({
      databaseName: 'db',
      totalObjectsLabel: '9',
      route: { planId: '7', placedStops: 0, totalStops: 2, offMapStops: 2 },
    })
    expect(mode.subtitle).toBe('Plan 7 · 0 of 2 tables placed · 2 off-map')
  })
})
