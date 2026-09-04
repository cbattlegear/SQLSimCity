import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const view = source('DatabaseCityView.tsx')

describe('city evidence and navigation surface wiring', () => {
  it('uses one city owner and renders observation, failed-refresh retention and retry', () => {
    expect(view).toContain('useCityEvidence(databaseId, metric, sourceMode)')
    expect(view).not.toContain('fetchDatabaseCity(')
    expect(view).toContain('observationTime(disclosure.observedAt)')
    expect(view).toContain('Last useful city retained.')
    expect(view).toContain('void city.refresh()')
  })
  it('preserves source mode through the city and selected route', () => {
    expect(source('App.tsx')).toContain("sourceMode={archiveInfo ? 'archive' : edgeInfo ? 'edge' : 'live'}")
    expect(view).toContain('<CityRouteEvidence choice={plan.choice} now={now} sourceMode={sourceMode} />')
  })
  it('exposes bounded search continuation rather than treating the first subset as complete', () => {
    expect(view).toContain("Partial search; absence is not proved.")
    expect(view).toContain('void finder.more()')
    expect(view).toContain('search.choices.slice(0, visiblePlanCount)')
  })
  it('keys both async owners by full city and mapped namespace and disables an unproven finder', () => {
    const hook = source('useCityPlans.ts')
    expect(hook.match(/\[databaseId, queryStoreDatabaseId, directPlanIds, reason/g)).toHaveLength(2)
    expect(view.includes("disabled={!queryScope.databaseId || search.status === 'loading'}")).toBe(true)
    expect(view.includes('{queryScope.reason}')).toBe(true)
  })
  it('gives both road and route the full place card instead of competing with the rail', () => {
    expect(view).toContain("route || selectedRoad ? ' is-full' : ''")
    expect(view).toContain('sidebarMode.showsAddressBook && !selectedRoad && (')
    expect(view).toContain('sidebarMode.showsAddressBook && !selectedRoad && liveQueryFeed')
  })
  it('restores the selected contributor even beyond the first bounded group', () => {
    expect(view).toContain('Math.max(contributorCount, selectedIndex + 1)')
    expect(view.includes('data-contributor-id={id}')).toBe(true)
    expect(view).toContain('restoreNavigationFocus(')
    expect(view).toContain('if (target) target.focus()')
  })
  it('cancels a pending contributor request before closing its road without restoring contributor focus', () => {
    const start = view.indexOf('const closeRoad =')
    const end = view.indexOf('const selectRoadEndpoint =', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(view.slice(start, end)).toContain('navigation.clear(false)')
  })
})
