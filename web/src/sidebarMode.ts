/**
 * What the database-city sidebar header says and does, as a pure function of what is open.
 *
 * This lives outside `DatabaseCityView.tsx` on purpose. `web/` has no React testing library — the
 * suite is vitest over pure modules, and `mobileLayout.test.ts` reads `App.css` as source text — so
 * component branch logic (which title to show, whether the back button clears the route or leaves the
 * database, whether the address book renders) cannot be exercised in a DOM. Pulling the decision into
 * this helper makes it testable in `sidebarMode.test.ts`; the component just consumes the result.
 *
 * The rule is: a query route takes the whole rail over. When one is open the header names the route,
 * its back button clears the route back to the database (it does *not* leave for the server atlas),
 * and the address book — search field, list, metric footer and both drawers — is not rendered. With
 * no route open the header is the database's own: its name, its object count, and a back button to the
 * server atlas.
 */

/** The open route's identity, reduced to what the header needs to describe it. */
export interface SidebarRouteSummary {
  /** The Query Store plan id the route was drawn from. */
  planId: string
  /** Stops actually drawn on this map (total stops minus the off-map ones). */
  placedStops: number
  /** Total stops in the itinerary, placed or not. */
  totalStops: number
  /** Stops the itinerary lists but the map could not draw. */
  offMapStops: number
}

export interface SidebarModeInput {
  /** The database whose city is open — the header title when no route is open. */
  databaseName: string
  /** The pre-formatted object total for the default subtitle, e.g. `"1,234"` or `"—"`. */
  totalObjectsLabel: string
  /** The open query route, or `null` when the sidebar is showing the database itself. */
  route: SidebarRouteSummary | null
}

export interface SidebarMode {
  /** The header's `<h1>`. */
  title: string
  /** The line under the title. */
  subtitle: string
  /** The back button's accessible label. */
  backLabel: string
  /**
   * What the back button does. `true` clears the open route back to the database; `false` leaves the
   * database for the server atlas. The component wires the matching handler.
   */
  clearsRoute: boolean
  /** Whether the address book (search, list, metric footer, drawers) is rendered. */
  showsAddressBook: boolean
}

/** The route header's title, kept in one place so the test and the component cannot drift. */
export const ROUTE_TITLE = "This query's route"

function routeSubtitle(route: SidebarRouteSummary): string {
  const tables = `${route.placedStops} of ${route.totalStops} table${route.totalStops === 1 ? '' : 's'} placed`
  const offMap = route.offMapStops > 0 ? ` · ${route.offMapStops} off-map` : ''
  return `Plan ${route.planId} · ${tables}${offMap}`
}

/**
 * Resolve the header text and the back-button behaviour from what the sidebar currently has open.
 *
 * With a route open the whole rail is the route: the address book is hidden and back clears it. With
 * no route open the header is the database's, and back leaves for the server atlas.
 */
export function resolveSidebarMode({ databaseName, totalObjectsLabel, route }: SidebarModeInput): SidebarMode {
  if (route) {
    return {
      title: ROUTE_TITLE,
      subtitle: routeSubtitle(route),
      backLabel: `Back to ${databaseName}`,
      clearsRoute: true,
      showsAddressBook: false,
    }
  }
  return {
    title: databaseName,
    subtitle: `${totalObjectsLabel} objects · database city`,
    backLabel: 'Back to the server atlas',
    clearsRoute: false,
    showsAddressBook: true,
  }
}
