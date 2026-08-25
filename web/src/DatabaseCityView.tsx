import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  fetchDatabaseCity,
  fetchPlan,
  fetchQueryFamilies,
  fetchQueryFamily,
} from './api'
import { subscribeToLiveIncidents } from './liveFeed'
import { accessibleObjectLabel, attributedAbsenceLabel, databaseCityMetricValue, databaseCitySharedMetricValue, formatKiB, shouldRenderRoute } from './databaseCity'
import type { DatabaseCityObject, DatabaseCityPage, DatabaseCityQueryFamily } from './databaseCityContracts'
import type { LiveIncidentResponse } from './liveContracts'
import type { LiveFeedConnectionState } from './liveIncidents'
import type { NormalizedShowplan, QueryFamilySummary } from './contracts'
import { DatabaseCityViewport } from './DatabaseCityViewport'
import { liveBlockingEdges, type LiveBlockingSummary } from './cityBlocking'
import { mergeCityPage } from './cityPaging'
import { neighborhoodSwatch, planCity, type CityPlanOptions } from './cityPlan'
import { buildCityRoute, type CityRoute } from './cityRoute'
import { assignWorkloadTraffic } from './cityWorkloadTraffic'
import { attributedWaits, type WaitAttributionTotals } from './cityWaitAttribution'
import { CONGESTION_LABELS, gradeRoads, type RoadTraffic } from './cityTraffic'
import { FACILITY_LABELS, projectFacilities, type Facility, type FacilityKind } from './cityInfrastructure'
import { projectFacilityTraffic, type FacilityTraffic } from './cityFacilityTraffic'
import { AddressBook } from './AddressPanel'
import { buildAddressBook, type AddressEntry } from './addressBook'
import { resolveSidebarMode } from './sidebarMode'
import { CityLoadingScreen } from './CityLoadingScreen'
import { MapShell, SidebarHeader, StatusChip, ViewModeTile, type MapViewMode } from './MapShell'
import { projectIncidents } from './cityIncidents'

const metrics = ['cpu', 'duration', 'reads', 'executions'] as const
type Metric = (typeof metrics)[number]

/**
 * Resolves once the browser has actually put the current render on screen.
 *
 * Two frames, not one. A state change only queues a render; the frame callback after that render is
 * the first moment its pixels exist. Anything scheduled before that point is invisible if the main
 * thread then blocks, which is exactly the situation this is used to avoid.
 */
function nextPaint(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return Promise.resolve()
  return new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

type Props = {
  databaseId: string
  databaseName: string
  onBack: () => void
  /** Flat map or 3D city. Owned by the shell so the whole app shares one look. */
  viewMode: MapViewMode
  onViewModeChange: (mode: MapViewMode) => void
  /** Deployment and provenance cards, floated over the map by the shell. */
  banners: ReactNode
}

type PlanChoice = {
  planId: string
  familyId: string
  queryHash: string
  text: string | null
  textReason: string
  executionCount: string
}

/**
 * How many object pages the view will walk on its own before handing back to the button.
 *
 * A stop exists so that opening a very large database cannot turn into an unbounded burst of
 * requests at a live instance. At the API's 50-object ceiling this covers a 4,000-object database,
 * which is past the point where every table is legible on one map anyway; beyond it the manual
 * "load more" control comes back and the user decides whether to keep going.
 */
const AUTO_PAGE_LIMIT = 80

export function DatabaseCityView({ databaseId, databaseName, onBack, viewMode, onViewModeChange, banners }: Props) {
  const [metric, setMetric] = useState<Metric>('cpu')
  const [page, setPage] = useState<DatabaseCityPage | null>(null)
  const [objects, setObjects] = useState<DatabaseCityObject[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('object'))
  const [selectedRoadId, setSelectedRoadId] = useState<string | null>(null)
  const [addressTerm, setAddressTerm] = useState('')
  const [loading, setLoading] = useState(true)
  /** True while pages after the first are still being walked in the background. */
  const [backfilling, setBackfilling] = useState(false)
  /**
   * True while the whole database is being laid out at once.
   *
   * Its own flag rather than a variant of `loading` because the map is already on screen by then,
   * and the layout it is about to run blocks the main thread for as long as it takes. Nothing can be
   * painted once that starts, so the screen that covers it has to be up a frame early.
   */
  const [relayouting, setRelayouting] = useState(false)
  /** Objects fetched so far, tracked separately so progress can move while the layout is held. */
  const [loadedCount, setLoadedCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<LiveIncidentResponse | null>(null)
  const [feedState, setFeedState] = useState<LiveFeedConnectionState>('disconnected')
  const [planQuery, setPlanQuery] = useState('')
  const [planChoices, setPlanChoices] = useState<PlanChoice[]>([])
  const [planSearchState, setPlanSearchState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [planSearchError, setPlanSearchError] = useState<string | null>(null)
  const [activePlan, setActivePlan] = useState<{ choice: PlanChoice; showplan: NormalizedShowplan } | null>(null)
  const [mappingFamilyId, setMappingFamilyId] = useState<string | null>(null)
  const [routeError, setRouteError] = useState<string | null>(null)
  const requests = useRef(new Set<AbortController>())
  const headingRef = useRef<HTMLHeadingElement>(null)
  const roadInvokerRef = useRef<HTMLElement | null>(null)

  /** Hands a merged page to the map. Every consumer reads one accumulated page, never a raw one. */
  const publish = useCallback((value: DatabaseCityPage) => {
    setPage(value)
    setObjects(value.objects)
  }, [])

  useEffect(() => {
    for (const request of requests.current) request.abort()
    requests.current.clear()
    const controller = new AbortController()
    requests.current.add(controller)
    setLoading(true)
    setBackfilling(false)
    setRelayouting(false)
    setLoadedCount(0)
    setError(null)
    setPage(null)
    setObjects([])
    /*
     * Walk the cursor to the end rather than stopping at the first page.
     *
     * Object inventory arrives in bounded pages, and the view used to draw the first one and wait
     * for a click. That is the wrong default: a city is a database, and a database that had loaded
     * 24 of its 75 tables was missing two thirds of its buildings. Everything keyed on a building
     * silently lost those objects with it — most visibly the query paths, where a stop on a table
     * that had simply not been fetched yet reported itself as unplaceable and the route line
     * skipped straight over it.
     *
     * Pages are still requested one at a time, so the bound the API is defending is untouched; the
     * only change is who asks for the next one. Each page is merged as it lands, so the city draws
     * from the first response and fills in behind it instead of blocking on the whole walk.
     */
    void (async () => {
      let token: string | null = null
      let pages = 0
      let merged: DatabaseCityPage | null = null
      try {
        do {
          const value = await fetchDatabaseCity(databaseId, metric, token, controller.signal)
          if (controller.signal.aborted) return
          pages += 1
          merged = merged ? mergeCityPage(merged, value) : value
          token = value.nextPageToken ?? null
          if (pages === 1) {
            // The first page is enough to draw and interact with. The rest backfills behind it.
            publish(merged)
            setSelectedId(current =>
              current && merged!.objects.some(object => object.objectId === current)
                ? current
                : merged!.objects[0]?.objectId ?? null)
            setLoading(false)
            setBackfilling(Boolean(token))
          }
          setLoadedCount(merged.objects.length)
        } while (token && pages < AUTO_PAGE_LIMIT)
        /*
         * One re-layout at the end rather than one per page.
         *
         * Every published page re-plans the city, and a schema gaining a member re-ranks that
         * schema's buildings by footprint, so a mid-walk publish visibly reshuffles blocks. Holding
         * the pages and publishing once means the city is drawn twice however large the database is:
         * the first page, then the whole thing.
         *
         * That second draw is the expensive one — a large database traces its whole street network
         * here — and it runs synchronously, so the browser cannot paint again until it finishes.
         * Raising the loading screen and waiting for it to actually reach the glass before starting
         * is the only way it is ever seen; set it in the same tick and the user gets a frozen map
         * instead.
         */
        if (merged && pages > 1) {
          setRelayouting(true)
          await nextPaint()
          if (controller.signal.aborted) return
          publish(merged)
        }
      } catch (reason) {
        if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError(String(reason))
      } finally {
        requests.current.delete(controller)
        if (!controller.signal.aborted) {
          setLoading(false)
          setBackfilling(false)
          setRelayouting(false)
        }
      }
    })()
    return () => {
      controller.abort()
      requests.current.delete(controller)
    }
  }, [databaseId, metric])

  useEffect(() => () => {
    for (const request of requests.current) request.abort()
    requests.current.clear()
  }, [])

  useEffect(() => subscribeToLiveIncidents(setSnapshot, setFeedState), [])

  useEffect(() => {
    headingRef.current?.focus()
  }, [databaseId])

  const selectObject = useCallback((objectId: string) => {
    setSelectedId(objectId)
    // A building click answers a different question than a road click, so it takes over the panel.
    setSelectedRoadId(null)
    const url = new URL(window.location.href)
    url.searchParams.set('object', objectId)
    window.history.replaceState(null, '', url)
  }, [])

  const selectRoad = useCallback((routeId: string | null) => {
    // Remember what opened the panel. Its own controls unmount it, so closing has to hand focus
    // back deliberately instead of dropping the reader on document.body, where Tab restarts at
    // the top of the page.
    if (routeId) {
      const active = document.activeElement
      roadInvokerRef.current = active instanceof HTMLElement && active !== document.body ? active : null
    }
    setSelectedRoadId(routeId)
  }, [])

  const restoreRoadFocus = useCallback(() => {
    const invoker = roadInvokerRef.current
    roadInvokerRef.current = null
    if (invoker?.isConnected) invoker.focus()
    else headingRef.current?.focus()
  }, [])

  const closeRoad = useCallback(() => {
    setSelectedRoadId(null)
    restoreRoadFocus()
  }, [restoreRoadFocus])

  const selectRoadEndpoint = useCallback((objectId: string) => {
    selectObject(objectId)
    restoreRoadFocus()
  }, [selectObject, restoreRoadFocus])

  // Escape closes the road panel from anywhere, because selecting a road on the map leaves focus
  // outside the panel entirely.
  useEffect(() => {
    if (!selectedRoadId) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRoad()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [selectedRoadId, closeRoad])

  const selected = objects.find(object => object.objectId === selectedId) ?? null
  /**
   * The map always draws every object that has loaded.
   *
   * Searching used to remove buildings from the city. On a map that is the wrong behaviour — you
   * search to find a place, not to delete the places you did not search for. The address book
   * narrows the *list* instead, and selecting an entry flies the camera to it.
   */
  const visibleObjects = objects
  const displayedSchemas = useMemo(() => {
    const byId = new Map<string, { schemaId: string; name: string; neighborhoodOrdinal: number; objectCount: number }>()
    for (const object of objects) {
      const existing = byId.get(object.schemaId)
      if (existing) existing.objectCount += 1
      else byId.set(object.schemaId, {
        schemaId: object.schemaId,
        name: object.schemaName,
        neighborhoodOrdinal: object.layout.neighborhoodOrdinal,
        objectCount: 1,
      })
    }
    return [...byId.values()].sort((left, right) =>
      left.neighborhoodOrdinal - right.neighborhoodOrdinal || left.schemaId.localeCompare(right.schemaId))
  }, [objects])

  const facilities = useMemo(() => projectFacilities(snapshot?.snapshot ?? null), [snapshot])
  const blocking = useMemo(
    () => liveBlockingEdges(snapshot?.snapshot ?? null, visibleObjects),
    [snapshot, visibleObjects])
  const incidents = useMemo(
    () => projectIncidents(snapshot?.snapshot ?? null, visibleObjects),
    [snapshot, visibleObjects])
  const families = page?.topQueryFamilies ?? []
  const facilityTraffic = useMemo(
    () => projectFacilityTraffic(families, visibleObjects),
    [families, visibleObjects])

  // Roads are graded here rather than inside the scene so the map, the hover readout, the road
  // panel, and the evidence table are all reading one set of numbers.
  const roads = useMemo(() => {
    if (!page) return [] as RoadTraffic[]
    const visible = new Set(visibleObjects.map(object => object.objectId))
    return gradeRoads(
      page.routes.filter(candidate => shouldRenderRoute(candidate, visible)),
      page.topQueryFamilies,
      blocking.edges,
    )
  }, [page, visibleObjects, blocking.edges])

  /** Schema-qualified name for an endpoint, falling back to the raw id for anything off this map. */
  const endpointName = useCallback((objectId: string) => {
    const object = objects.find(candidate => candidate.objectId === objectId)
    return object ? `${object.schemaName}.${object.name}` : objectId
  }, [objects])

  const roadLabels = useMemo(() => {
    const labels = new Map<string, string>()
    for (const road of roads) {
      const volume = road.executions === null
        ? 'volume unavailable'
        : `${road.executions.toLocaleString()} executions`
      labels.set(
        road.routeId,
        `${endpointName(road.fromObjectId)} ↔ ${endpointName(road.toId)} · ${volume} · ${CONGESTION_LABELS[road.grade]}`,
      )
    }
    return labels
  }, [roads, endpointName])

  const selectedRoad = roads.find(road => road.routeId === selectedRoadId) ?? null
  useEffect(() => {
    // A road that filtering or a refresh removed must not leave a stale panel behind.
    if (selectedRoadId !== null && !roads.some(road => road.routeId === selectedRoadId)) setSelectedRoadId(null)
  }, [roads, selectedRoadId])

  /**
   * Everything `planCity` needs to lay the city out the same way every time: the database id as the
   * scatter seed, and the full totals so the grid is sized for the whole database rather than for
   * whichever pages happen to have arrived.
   */
  const planOptions: CityPlanOptions = useMemo(
    () => ({ seed: databaseId, totalObjects: page?.totalObjects ?? null, schemas: page?.schemas }),
    [databaseId, page?.totalObjects, page?.schemas],
  )

  const cityPlan = useMemo(
    () => planCity(visibleObjects, planOptions),
    [visibleObjects, planOptions],
  )

  const route: CityRoute | null = useMemo(() => {
    if (!activePlan) return null
    return buildCityRoute(activePlan.showplan, {
      plan: cityPlan,
      objects: visibleObjects,
      databaseName,
    })
  }, [activePlan, cityPlan, visibleObjects, databaseName])

  /**
   * The traffic map: every ranked family driven through the tables its plans read, once per captured
   * execution, accumulated onto the streets. This is what the map shows standing back, in place of one
   * ribbon per pair of tables — a picture of the workload's shape rather than of its traffic.
   */
  const workloadTraffic = useMemo(
    () => assignWorkloadTraffic(cityPlan, families),
    [cityPlan, families],
  )

  /** Measured wait time apportioned to each building by its plans' estimated cost share. */
  const waitAttribution = useMemo(
    () => attributedWaits(families, new Set(visibleObjects.map(object => object.objectId))),
    [families, visibleObjects],
  )

  const loadMore = () => {
    if (!page?.nextPageToken) return
    const current = page
    const controller = new AbortController()
    requests.current.add(controller)
    setLoading(true)
    void fetchDatabaseCity(databaseId, metric, current.nextPageToken, controller.signal)
      .then(next => {
        const merged = mergeCityPage(current, next)
        publish(merged)
        setLoadedCount(merged.objects.length)
      })
      .catch(reason => {
        if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError(String(reason))
      })
      .finally(() => {
        requests.current.delete(controller)
        if (!controller.signal.aborted) setLoading(false)
      })
  }

  const searchPlans = useCallback(async () => {
    const term = planQuery.trim().toLocaleLowerCase()
    setPlanSearchState('loading')
    setPlanSearchError(null)
    const controller = new AbortController()
    requests.current.add(controller)
    try {
      const familyPage = await fetchQueryFamilies(metric, null, controller.signal)
      const matches = familyPage.items
        .filter(family => !term || familyMatches(family, term))
        .slice(0, 8)
      const details = await Promise.all(
        matches.map(family =>
          fetchQueryFamily(family.familyId, controller.signal)
            .then(detail => ({ family, detail }))
            .catch(() => null)))
      const choices: PlanChoice[] = []
      for (const entry of details) {
        if (!entry) continue
        for (const plan of entry.detail.plans) {
          choices.push({
            planId: plan.planId,
            familyId: entry.family.familyId,
            queryHash: entry.family.queryHash,
            text: entry.family.text.normalizedText,
            textReason: entry.family.text.reason,
            executionCount: entry.family.executionCount,
          })
        }
      }
      const planTermMatches = term
        ? choices.filter(choice =>
          choice.planId.toLocaleLowerCase().includes(term) ||
          choice.familyId.toLocaleLowerCase().includes(term) ||
          choice.queryHash.toLocaleLowerCase().includes(term) ||
          (choice.text ?? '').toLocaleLowerCase().includes(term))
        : []
      setPlanChoices(planTermMatches.length > 0 ? planTermMatches : choices)
      setPlanSearchState('ready')
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return
      setPlanSearchError(String(reason))
      setPlanSearchState('error')
    } finally {
      requests.current.delete(controller)
    }
  }, [metric, planQuery])

  const choosePlan = useCallback(async (choice: PlanChoice) => {
    setRouteError(null)
    const controller = new AbortController()
    requests.current.add(controller)
    try {
      const showplan = await fetchPlan(choice.planId, controller.signal)
      setActivePlan({ choice, showplan })
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return
      setRouteError(String(reason))
    } finally {
      requests.current.delete(controller)
    }
  }, [])

  /**
   * Draws a ranked family's own plan on the map. The family row already carries the workload
   * evidence; this reads the one plan behind it so the same evidence becomes a route through the
   * buildings it named, instead of requiring the operator to rediscover it in the plan finder.
   */
  const showFamilyOnMap = useCallback(async (family: DatabaseCityQueryFamily) => {
    setRouteError(null)
    setMappingFamilyId(family.familyId)
    const controller = new AbortController()
    requests.current.add(controller)
    try {
      const detail = await fetchQueryFamily(family.familyId, controller.signal)
      // Prefer a plan whose runtime is counted; a dispatcher plan carries no operator tree to walk.
      const plan = detail.plans.find(candidate => candidate.runtimeCounted) ?? detail.plans[0]
      if (!plan) {
        setRouteError(
          `Query Store retains no compiled plan for ${family.familyId}, so this family cannot be drawn as a route.`)
        return
      }
      const showplan = await fetchPlan(plan.planId, controller.signal)
      setActivePlan({
        choice: {
          planId: plan.planId,
          familyId: family.familyId,
          queryHash: family.queryHash,
          text: detail.family.text.normalizedText,
          textReason: detail.family.text.reason,
          executionCount: family.executionCount,
        },
        showplan,
      })
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return
      setRouteError(String(reason))
    } finally {
      requests.current.delete(controller)
      setMappingFamilyId(current => (current === family.familyId ? null : current))
    }
  }, [])

  const addressEntries = useMemo(
    () => buildAddressBook(visibleObjects, page?.topQueryFamilies ?? [], facilities, cityPlan),
    [visibleObjects, page?.topQueryFamilies, facilities, cityPlan],
  )

  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null)

  /**
   * One click on an address does what that kind of address means: a table selects its building, a
   * query draws its plan across the city, and a facility selects the facility. All three then show
   * their place card over the list, which is the pattern every web map uses.
   */
  const openAddress = useCallback((entry: AddressEntry) => {
    setSelectedAddressId(entry.id)
    if (entry.kind === 'table') {
      selectObject(entry.targetId)
      return
    }
    if (entry.kind === 'query') {
      const family = page?.topQueryFamilies.find(candidate => candidate.familyId === entry.targetId)
      if (family) void showFamilyOnMap(family)
    }
  }, [page?.topQueryFamilies, selectObject, showFamilyOnMap])

  const selectedFacility = selectedAddressId?.startsWith('facility:')
    ? facilities.find(facility => `facility:${facility.kind}` === selectedAddressId) ?? null
    : null

  /**
   * Close an open query route and return to the database. The route was opened from a query address,
   * so its list row is still selected; clearing that too keeps the address list from coming back with
   * a stale `is-selected` row highlighted.
   */
  const clearRoute = useCallback(() => {
    setActivePlan(null)
    setSelectedAddressId(null)
    setRouteError(null)
  }, [])

  const planFinder = (
    <details className="sidebar-drawer">
      <summary>Route a captured query plan</summary>
      <div className="sidebar-drawer-body">
        <form
          className="hud-field"
          onSubmit={event => {
            event.preventDefault()
            void searchPlans()
          }}
        >
          <label>
            <span>Find a query plan</span>
            <input
              type="search"
              value={planQuery}
              onChange={event => setPlanQuery(event.target.value)}
              placeholder="plan id, family id, query hash, or text"
            />
          </label>
          <button type="submit">Route it</button>
        </form>
        {planSearchState === 'loading' && <p className="hud-note" role="status">Searching captured plans…</p>}
        {planSearchState === 'error' && <p className="hud-note is-error" role="alert">{planSearchError}</p>}
        {planSearchState === 'ready' && planChoices.length === 0 && (
          <p className="hud-note">No captured plan matches. Query Store only returns plans it captured.</p>
        )}
        {planChoices.length > 0 && (
          <ul className="hud-results">
            {planChoices.slice(0, 12).map(choice => (
              <li key={`${choice.familyId}:${choice.planId}`}>
                <button
                  type="button"
                  aria-pressed={activePlan?.choice.planId === choice.planId}
                  onClick={() => void choosePlan(choice)}
                >
                  <strong>{choice.planId}</strong>
                  <small>{choice.text ?? choice.textReason}</small>
                  <small>{choice.familyId} · {choice.executionCount} executions</small>
                </button>
              </li>
            ))}
          </ul>
        )}
        {routeError && <p className="hud-note is-error" role="alert">{routeError}</p>}
      </div>
    </details>
  )

  const liveStatus = (
    <div className={`hud-live feed-${feedState}`}>
      <span className="live-dot" aria-hidden="true" />
      <span>Live feed {feedState}</span>
      {blocking.probeReported
        ? <small>{blocking.edges.length} object(s) with blocked waiters</small>
        : <small>No lock-resource evidence reported</small>}
    </div>
  )

  /** The place card: whatever the map is currently pointing at, rendered over the address list. */
  const placeCard = route
    ? <RoutePanel route={route} plan={activePlan!} />
    : selectedRoad
      ? <RoadPanel
        road={selectedRoad}
        fromName={endpointName(selectedRoad.fromObjectId)}
        toName={endpointName(selectedRoad.toId)}
        onSelectEndpoint={selectRoadEndpoint}
        hasEndpoint={objectId => objects.some(object => object.objectId === objectId)}
        onClose={closeRoad}
      />
      : selectedFacility
        ? <FacilityPanel facility={selectedFacility} onClose={() => setSelectedAddressId(null)} />
        : selected
          ? <BuildingPanel object={selected} metric={metric} facilityCount={facilities.length} />
          : null

  const sidebarMode = resolveSidebarMode({
    databaseName,
    // `totalObjects` is a decimal string because it can exceed `Number.MAX_SAFE_INTEGER`, so it is
    // passed through as it arrives rather than being routed through a lossy `Number`.
    totalObjectsLabel: page?.totalObjects ?? '—',
    route: route
      ? {
        planId: activePlan!.choice.planId,
        placedStops: route.stops.length - route.offMapStops.length,
        totalStops: route.stops.length,
        offMapStops: route.offMapStops.length,
      }
      : null,
  })

  const sidebar = (
    <>
      <SidebarHeader
        brand={<div className="sidebar-brand"><span className="sidebar-mark" aria-hidden="true" />SQLSimCity</div>}
        title={sidebarMode.title}
        subtitle={sidebarMode.subtitle}
        onBack={sidebarMode.clearsRoute ? clearRoute : onBack}
        backLabel={sidebarMode.backLabel}
      />

      {placeCard && (
        <div className={`sidebar-place-card${route ? ' is-full' : ''}`}>{placeCard}</div>
      )}

      {sidebarMode.showsAddressBook && (
        <AddressBook
          entries={addressEntries}
          term={addressTerm}
          onTermChange={setAddressTerm}
          selectedId={selectedAddressId}
          onSelect={openAddress}
          footer={
            <>
              <div className="sidebar-metric">
                <label>Rank workload
                  <select value={metric} onChange={event => setMetric(event.target.value as Metric)}>
                    {metrics.map(value => <option key={value}>{value}</option>)}
                  </select>
                </label>
                {backfilling && (
                  /*
                   * Not a live region any more. The loading screen is up for the whole backfill and its
                   * progressbar already announces the same count; leaving `role="status"` here made a
                   * long walk fire up to eighty announcements of a number nobody asked to hear.
                   */
                  <p className="load-progress">
                    Loading the rest of the city… {loadedCount.toLocaleString()} of{' '}
                    {Number(page?.totalObjects ?? loadedCount).toLocaleString()} objects placed.
                  </p>
                )}
                {!backfilling && page?.nextPageToken && (
                  <button type="button" className="load-more" onClick={loadMore}>
                    Load next bounded object page
                  </button>
                )}
              </div>
              {/*
                * One shared height budget, not two independent caps.
                *
                * Both drawers are capped, and a flex item's automatic minimum is its content clamped
                * by its own `max-height`, so two flat `46vh` caps floor at 46vh each and no shrink
                * pressure can take either lower. Measured at 1115x800 with a populated plan finder,
                * that left 167px of the column unreachable and squeezed the address list to 0px.
                * The wrapper owns the budget and hands each drawer its share; see `.sidebar-drawers`.
                *
                * It has to be a real element: everything between here and `.map-sidebar` is a
                * fragment, so without it both drawers are direct flex children of the rail.
                */}
              <div className="sidebar-drawers">
                {planFinder}
                {page && <LegendDrawer
                  page={page}
                  objects={visibleObjects}
                  metric={metric}
                  selectedId={selectedId}
                  selectedRoadId={selectedRoadId}
                  onSelectObject={selectObject}
                  onSelectRoad={selectRoad}
                  endpointName={endpointName}
                  roads={roads}
                  facilities={facilities}
                  facilityTraffic={facilityTraffic}
                  waitAttribution={waitAttribution}
                  blocking={blocking}
                  displayedSchemas={displayedSchemas}
                  activePlanFamilyId={activePlan?.choice.familyId ?? null}
                  mappingFamilyId={mappingFamilyId}
                  onShowFamily={showFamilyOnMap}
                  selectedObject={selected}
                />}
              </div>
            </>
          }
        />
      )}
    </>
  )

  return (
    <MapShell sidebar={sidebar}>
      {/*
        * Up for the whole walk, not just its ends.
        *
        * The obvious wiring — cover the first fetch, uncover, then cover the final layout — puts the
        * screen on twice with a partly-built city flashing between them, and wastes the measured bar
        * entirely: it would appear at an unknown total, vanish, and come back at 100%. Holding it
        * across the backfill instead gives the bar the one job it has, filling from the first page to
        * the last, and the status line carries the handover to the layout pass.
        */}
      {((loading && !page) || backfilling || relayouting) && (
        <CityLoadingScreen
          title={databaseName}
          status={
            relayouting
              ? 'Laying out the whole city — streets, blocks and lots'
              : 'Reading bounded pages of the database catalogue'
          }
          loaded={loadedCount}
          total={page?.totalObjects != null ? Number(page.totalObjects) : null}
        />
      )}
      {error && <section className="stage-message error" role="alert">{error}</section>}

      {page && (
        <DatabaseCityViewport
          objects={visibleObjects}
          planOptions={planOptions}
          viewMode={viewMode}
          roads={roads}
          traffic={workloadTraffic}
          facilities={facilities}
          facilityTraffic={facilityTraffic}
          route={route}
          selectedId={selectedId}
          selectedRoadId={selectedRoadId}
          onSelect={selectObject}
          onSelectRoad={selectRoad}
          roadLabels={roadLabels}
          liveStatus={liveStatus}
          feedState={feedState}
          incidents={incidents}
        />
      )}

      {page && (
        <StatusChip degraded={page.evidence.status !== 'Available'} title={page.evidence.reason}>
          {page.evidence.source} · {page.evidence.status}
        </StatusChip>
      )}

      <ViewModeTile mode={viewMode} onChange={onViewModeChange} />
      {banners}
    </MapShell>
  )
}

/**
 * Everything the map draws, written out as text.
 *
 * This is not an appendix. It is the accessible and auditable equivalent of the city, and the only
 * place some facts can appear at all — wait time with no facility to queue at, workload naming no
 * loaded object, lock waits that resolved to nothing. It lives behind a disclosure because the map
 * is the page now, not because any of it is optional.
 */
function LegendDrawer({
  page,
  objects,
  metric,
  selectedId,
  selectedRoadId,
  onSelectObject,
  onSelectRoad,
  endpointName,
  roads,
  facilities,
  facilityTraffic,
  waitAttribution,
  blocking,
  displayedSchemas,
  activePlanFamilyId,
  mappingFamilyId,
  onShowFamily,
  selectedObject,
}: {
  page: DatabaseCityPage
  objects: readonly DatabaseCityObject[]
  metric: Metric
  selectedId: string | null
  selectedRoadId: string | null
  onSelectObject: (objectId: string) => void
  onSelectRoad: (routeId: string) => void
  endpointName: (objectId: string) => string
  roads: readonly RoadTraffic[]
  facilities: readonly Facility[]
  facilityTraffic: FacilityTraffic
  waitAttribution: WaitAttributionTotals
  blocking: LiveBlockingSummary
  displayedSchemas: ReadonlyArray<{ schemaId: string; name: string; neighborhoodOrdinal: number; objectCount: number }>
  activePlanFamilyId: string | null
  mappingFamilyId: string | null
  onShowFamily: (family: DatabaseCityQueryFamily) => void | Promise<void>
  selectedObject: DatabaseCityObject | null
}) {
  return (
    <details className="sidebar-drawer">
      <summary>Legend &amp; evidence</summary>
      <div className="sidebar-drawer-body">
        <div className="city-legend" aria-label="Database city legend">
          <span><i className="legend-direct" /> direct cumulative DMV activity</span>
          <span><i className="legend-attributed" /> attributed Query Store aggregate</span>
          <span><i className="legend-unknown">×</i> unknown, nonquantitative size</span>
          <span><i className="legend-route" /> confidence-graded co-reference, never row flow</span>
        </div>

        <p className="mapping-note">
          <strong>What encodes evidence.</strong> Building footprint maps exact reserved 8-KiB pages
          logarithmically and height maps exact used pages, so a one-page table is a house and a
          multi-gigabyte table is a skyscraper for a measured reason. Amber roof-cap height maps
          attributed Query Store CPU; index annex width maps direct DMV operations, and indexes stay
          attached to their parent. Road width maps the executions of query families naming both
          endpoints; road colour maps captured wait share, upgraded to red only where a resolved live
          lock names that object; route line pattern maps co-reference confidence, never row flow.
          Wait-lane width maps the captured Query Store wait milliseconds a building&apos;s workload
          spent queued at one infrastructure facility, and lane colour names that destination; a
          category with no facility here is listed, never folded into one. A query family naming
          several objects draws one shared lane threaded through each of them before reaching the
          facility: that lane carries the family&apos;s whole captured wait, drawn once, so it is
          neither divided between those buildings nor counted inside any of their own totals.
          Unknown size or unavailable activity uses fixed wireframe geometry and makes no quantity
          claim. Ground labels name each building and facility and carry identity only — a label
          never restates or qualifies a measurement. Names are set in a few sizes and appear as you
          zoom in, largest first, so the busiest ground is not lettered all at once; that ordering
          follows building height but is clamped into a range narrower than a factor of two, so it is
          a reading order and not a quantity. Footprint and height remain the only things that state
          how large a table is.
        </p>

        <p className="mapping-note">
          <strong>Neighbourhoods are real; addresses are not.</strong> Each schema holds one
          contiguous quarter of the city, so two tables in the same schema are always near each
          other and a building&apos;s neighbourhood is a catalogue fact you can check. Inside that
          quarter, buildings fill outward from the middle in catalogue order, so a building nearer
          the centre of its neighbourhood was created before one on the fringe — an order, and the
          only thing a position states. Nothing else about a block is sorted: how roomy it is, which
          street it fronts and which buildings surround it are drawn from a generator seeded with the
          database id, so neighbouring buildings are <em>not</em> related by being neighbours, and how
          far apart two schemas sit is an accident of the seed rather than a measure of how related
          they are. The same database always produces the same city on every machine while two
          databases of identical shape produce different ones. A neighbourhood&apos;s hue and the
          label across its ground name the schema and nothing more; hues are handed out in catalogue
          order, so none is warmer, larger or busier than another. A larger schema does claim more
          ground, but only roughly — borders land wherever two neighbourhoods happen to meet, so read
          the counts beside each name rather than the area. Infrastructure facilities are scattered at
          least two blocks apart so they act as landmarks rather than one civic corner. Street class,
          roof shapes, windows, setbacks, crowns and sidewalks are decoration and encode nothing.
        </p>

        <p className="mapping-note">
          <strong>The city has room it is not using.</strong> A map is only useful if it is the same
          map tomorrow, so this city is not sized from the database exactly — it is sized from the
          next rung of a ladder above it, roughly a quarter larger, and each neighbourhood is given
          about half again the ground its schema currently needs. Create a table and it takes one of
          those empty plots: it appears on the fringe of its own schema&apos;s quarter and every
          building already standing stays exactly where it is. Drop a table and its plot falls vacant,
          and the table created after it moves up into the gap. The city is only rebuilt when the
          database outgrows its rung, and then it is genuinely redrawn — the same database will not
          look the same after it has grown by a quarter. So the open ground is not a measurement:
          empty plots are not unused space, idle capacity, dropped tables or room the database has
          reserved. They are simply the map leaving itself somewhere to put the next table.
        </p>

        <p className="mapping-note">
          <strong>The scenery is not evidence.</strong> The landscape this city sits in is drawn, not
          measured. The river and its banks, the ground relief, every land-use area — parks,
          woodland, orchards, plazas, parking, yards and open water — the trees, hedges, streetlights,
          benches, parked cars and other street furniture, the architecture of the six infrastructure
          facilities, and the whole palette are all generated from the same database-id seed as the
          block layout. The sky, the sun and the shadows are not even seeded: they follow the clock
          on the machine you are reading this on, so the city is lit as morning, day, evening or
          night to match your own hour, and lit identically for a healthy instance and a failing one.
          None of it is derived from any measurement, so none of it can be read as one: a park is not
          idle space, a wooded edge is not a cold table, a district with few streets is not a sparse
          schema, and a dark city is not an idle one.
        </p>

        <p className="mapping-note">
          <strong>The street plan is drawn too.</strong> This city is deliberately not a grid, and
          none of what replaces the grid means anything. Where each junction sits, the shape and
          width of every block, the class of each street from motorway down to service lane and the
          speed limit that class carries, how far apart the arterials run, where the squares open
          out, which pattern of streets fills each district, the curve of every road, the ring
          boulevard and the avenues radiating from the squares — all of it comes from the seed. So do
          the T-junctions and dead ends: roughly one junction in seven is left as a cul-de-sac and
          most of the rest meet three streets rather than four, because that is the shape of a real
          street network, not because anything about the database ended there. A big block is not a
          big table, a fast road is not a busy one, a dead end is not a table nothing reaches, a
          square is not a hotspot, and two buildings on the same curve have nothing to do with each
          other.
        </p>

        <p className="mapping-note">
          <strong>The traffic is measured; the streets carrying it are not.</strong> A street&apos;s
          width is the captured executions of every query family whose journey runs along it, and its
          colour is the waiting those executions carried, in milliseconds per execution. Both numbers
          come from Query Store. What is invented is the geography: SQL Server has no streets, so the
          route each family takes between the tables it reads is modelled on those seeded speed
          limits, and the busiest families fan out onto parallel streets rather than stacking on one
          road. Read a red street as &ldquo;queries that touch these tables wait a lot&rdquo;, never as
          &ldquo;this stretch of road is slow&rdquo;.
        </p>

        <p className="mapping-note">
          <strong>Which table a wait belongs to is an estimate.</strong> Query Store measures one wait
          total per query family and says nothing about which of the tables it read did the waiting.
          To place that time on buildings, it is divided by the share of the compiled plan&apos;s
          <em> estimated</em> cost each table accounts for — the optimizer&apos;s own arithmetic about
          work it expected to do. The milliseconds are real and the division is reproducible, but it
          is a model, not a measurement, and it is kept separate from the strict attributed exposure
          above, which is only ever assigned when a family named one object and nothing else. Cost the
          plan spent on tables this page does not draw, or on no table at all, is never handed to a
          building; it is reported as unplaced.
        </p>

        <div className="city-schema-strip" aria-label="Neighbourhoods">
          {displayedSchemas.map(schema => <div key={schema.schemaId}>
            <strong>
              <i className="legend-swatch" style={{ background: neighborhoodSwatch(schema.neighborhoodOrdinal) }} aria-hidden="true" />
              {schema.name}
            </strong>
            <span>{schema.objectCount} objects</span>
          </div>)}
        </div>

        <section className="table-region" aria-labelledby="city-object-table">
          <div className="section-heading">
            <div><h2 id="city-object-table">Objects and attached indexes</h2><p>Text-first equivalent of the viewport</p></div>
          </div>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Object</th><th>Size</th><th>Direct activity</th><th>Attributed exposure</th></tr></thead>
              <tbody>{objects.map(object => <tr key={object.objectId} className={selectedId === object.objectId ? 'is-selected' : undefined}>
                <th scope="row"><button type="button" aria-label={accessibleObjectLabel(object)}
                  aria-pressed={selectedId === object.objectId} onClick={() => onSelectObject(object.objectId)}>
                  {object.schemaName}.{object.name}
                </button><small>{object.kind} · {object.indexes.length} attached indexes</small></th>
                <td>{object.reservedBytes === null ? <><strong>Unknown ×</strong><small>{object.sizeReason}</small></> :
                  <><strong>{formatKiB(object.reservedBytes)} reserved</strong><small>{formatKiB(object.usedBytes!)} used</small></>}</td>
                <td><strong>{object.directActivity.totalOperations ?? object.directActivity.evidence.status}</strong>
                  <small>{object.directActivity.evidence.source} · {object.directActivity.evidence.reason}</small></td>
                <td><strong>{databaseCityMetricValue(object, metric) ?? attributedAbsenceLabel(object)}</strong>
                  {object.attributedExposure.shared &&
                    <span>shared {databaseCitySharedMetricValue(object, metric)} across {object.attributedExposure.shared.familyCount} joined quer{object.attributedExposure.shared.familyCount === '1' ? 'y' : 'ies'}</span>}
                  <small>{object.attributedExposure.confidence} · {object.attributedExposure.rationale}
                    {object.attributedExposure.shared ? ` ${object.attributedExposure.shared.rationale}` : ''}</small></td>
              </tr>)}</tbody>
            </table>
          </div>
        </section>

        <ObjectDetail object={selectedObject} metric={metric} />

        <section className="city-infrastructure-table" aria-labelledby="city-infrastructure-title">
          <div className="section-heading">
            <div><h2 id="city-infrastructure-title">Civic infrastructure</h2>
              <p>CPU, memory, storage, tempdb, log, and lock facilities from the live snapshot</p></div>
          </div>
          <ul className="facility-list">
            {facilities.map(facility => <li key={facility.kind} className={facility.known ? undefined : 'is-unknown'}>
              <strong>{FACILITY_LABELS[facility.kind]}</strong>
              <span>{facility.headline}</span>
              <small>{facility.status} · {facility.reason}</small>
              {facility.units.length > 0 && <ul>
                {facility.units.slice(0, 8).map(unit => <li key={unit.id}>
                  {unit.label}: {unit.detail}{unit.alert ? ' ⚠' : ''}
                </li>)}
              </ul>}
            </li>)}
          </ul>
          {blocking.unresolved.length > 0 && <p className="hud-note">
            {blocking.unresolved.length} live lock wait(s) could not be resolved to an object:
            {' '}{blocking.unresolved[0].reason}
          </p>}
          {blocking.offPageCount > 0 && <p className="hud-note">
            {blocking.offPageCount} resolved lock wait(s) name an object outside this bounded page.
          </p>}
        </section>

        <FacilityTrafficTable traffic={facilityTraffic} objects={objects} />

        <WaitAttributionTable totals={waitAttribution} objects={objects} />

        <section className="city-workload" aria-labelledby="city-workload-title">
          <div className="section-heading">
            <div><h2 id="city-workload-title">Top query-family exposure</h2>
              <p>Backend-ranked top 12; no browser-side 100k layout</p></div>
          </div>
          <div className="table-scroll"><table>
            <thead><tr><th>Family</th><th>Executions</th><th>CPU µs</th><th>Duration µs</th><th>Reads (8-KiB)</th><th>Attribution</th><th>Map</th></tr></thead>
            <tbody>{page.topQueryFamilies.map(family => <tr key={family.familyId}>
              <th scope="row">{family.familyId}<small>{family.queryHash} · {family.evidence.source}</small></th>
              <td>{family.executionCount}</td><td>{family.totalCpuMicroseconds}</td>
              <td>{family.totalDurationMicroseconds}</td><td>{family.totalLogicalReads8KiBPages}</td>
              <td>{family.confidence}<small>{family.rationale}</small></td>
              <td className="map-cell"><button
                type="button"
                disabled={mappingFamilyId === family.familyId}
                aria-label={`Draw the plan for ${family.familyId} on the map`}
                onClick={() => void onShowFamily(family)}
              >{mappingFamilyId === family.familyId ? 'Reading plan…' : 'Show on map'}</button>
                {activePlanFamilyId === family.familyId && <small>Drawn on the map</small>}</td>
            </tr>)}</tbody>
            <tfoot><tr><th scope="row">Other workload ({page.otherWorkload.familyCount ?? 'count unavailable'} families)</th>
              <td>{page.otherWorkload.executionCount ?? 'Unavailable'}</td><td>{page.otherWorkload.totalCpuMicroseconds ?? 'Unavailable'}</td>
              <td>{page.otherWorkload.totalDurationMicroseconds ?? 'Unavailable'}</td>
              <td>{page.otherWorkload.totalLogicalReads8KiBPages ?? 'Unavailable'}</td>
              <td>Aggregate only<small>{page.otherWorkload.evidence.reason}</small></td>
              <td>Not a single query<small>An aggregate has no one plan to draw.</small></td></tr></tfoot>
          </table></div>
        </section>

        <section className="topology city-routes" aria-labelledby="city-routes-title">
          <div className="section-heading"><div><h2 id="city-routes-title">Evidence-labeled routes</h2>
            <p>Confidence is encoded by pattern and text; routes do not claim row flow</p></div></div>
          <ul>{page.routes.map(route => {
            const graded = roads.find(road => road.routeId === route.routeId) ?? null
            return <li key={route.routeId} className={route.routeId === selectedRoadId ? 'is-selected' : undefined}>
              <span className={`edge-mark edge-${route.confidence.toLowerCase()}`} aria-hidden="true" />
              <strong>{route.kind} · {route.confidence}</strong>
              <span>
                {graded
                  ? <button
                    type="button"
                    className="route-endpoints"
                    aria-pressed={route.routeId === selectedRoadId}
                    onClick={() => onSelectRoad(route.routeId)}
                  >
                    {endpointName(route.fromObjectId)} ↔ {endpointName(route.toId)}
                  </button>
                  : <>{endpointName(route.fromObjectId)} ↔ {endpointName(route.toId)}</>}
                <br />
                {graded
                  ? `${CONGESTION_LABELS[graded.grade]} · ${graded.rationale} `
                  : 'Not drawn on the map: an endpoint is outside the loaded page. '}
                {route.rationale} · {route.evidence.status}
              </span>
            </li>
          })}</ul>
        </section>
      </div>
    </details>
  )
}

/** Place card for one infrastructure facility, opened from the address book. */
function FacilityPanel({ facility, onClose }: { facility: Facility; onClose: () => void }) {
  return (
    <aside className="detail place-card" aria-labelledby="facility-panel-title">
      <div className="detail-title">
        <h2 id="facility-panel-title">{FACILITY_LABELS[facility.kind]}</h2>
        <button type="button" onClick={onClose} aria-label="Close facility detail">✕</button>
      </div>
      <p className={facility.known ? undefined : 'is-unknown'}>{facility.headline}</p>
      {facility.units.length > 0 && (
        <dl>
          {facility.units.slice(0, 10).map(unit => (
            <div key={unit.id}><dt>{unit.label}</dt><dd>{unit.detail}{unit.alert ? ' ⚠' : ''}</dd></div>
          ))}
        </dl>
      )}
      <div className="source-note">
        <strong>{facility.status}</strong>
        <p>{facility.reason}</p>
      </div>
    </aside>
  )
}

function familyMatches(family: QueryFamilySummary, term: string): boolean {
  return (
    family.familyId.toLocaleLowerCase().includes(term) ||
    family.queryHash.toLocaleLowerCase().includes(term) ||
    (family.text.normalizedText ?? '').toLocaleLowerCase().includes(term)
  )
}

/**
 * Where the waiting is modelled to have happened. Kept deliberately apart from the facility lanes
 * above, which report each family's captured total whole: this table is the one place a query-level
 * measurement is divided, and the caption says on what basis and what that costs in certainty.
 */
function WaitAttributionTable({
  totals,
  objects,
}: {
  totals: WaitAttributionTotals
  objects: readonly DatabaseCityObject[]
}) {
  const nameOf = (objectId: string) => {
    const object = objects.find(item => item.objectId === objectId)
    return object ? `${object.schemaName}.${object.name}` : objectId
  }
  const rows = [...totals.byObject.values()]
    .filter(entry => entry.milliseconds > 0n)
    .sort((a, b) => (b.milliseconds === a.milliseconds
      ? a.objectId.localeCompare(b.objectId)
      : b.milliseconds > a.milliseconds ? 1 : -1))
  return (
    <section className="city-wait-attribution" aria-labelledby="city-wait-attribution-title">
      <div className="section-heading">
        <div>
          <h2 id="city-wait-attribution-title">Waiting placed on buildings — modelled</h2>
          <p>Measured Query Store wait time divided by each table&apos;s estimated plan cost share</p>
        </div>
      </div>
      <p className="hud-note">{totals.note}</p>
      {rows.length > 0 && <div className="table-scroll"><table>
        <caption>
          Every millisecond below was measured, but the decision to put it on <em>this</em> building
          rather than another the same query read is the optimizer&apos;s cost estimate, not an
          observation. Treat the ordering as a strong hint about where to look and the exact figures
          as approximate. These numbers are not part of attributed exposure and must not be added to
          it.
        </caption>
        <thead><tr>
          <th>Building</th><th>Apportioned wait (ms)</th><th>Query families</th>
        </tr></thead>
        <tbody>{rows.map(entry => <tr key={entry.objectId}>
          <th scope="row">{nameOf(entry.objectId)}</th>
          <td>{entry.milliseconds.toLocaleString()}</td>
          <td>{entry.familyIds.join(' · ')}</td>
        </tr>)}</tbody>
      </table></div>}
      {totals.unattributed > 0n && <div className="source-note">
        <strong>Wait time no building was given</strong>
        <p>
          {totals.unattributed.toLocaleString()} ms of the {totals.measured.toLocaleString()} ms
          measured across these families sat on plan operators that name no table on this page —
          off-page or cross-database reads, sorts, aggregates and other pure computation, or plans
          that reported no cost at all. It is reported here rather than pushed onto whichever
          building happened to be nearby.
        </p>
      </div>}
    </section>
  )
}

/**
 * Text-first equivalent of the wait-lane layer. Everything the map draws is listed here, plus the
 * three things the map deliberately cannot draw: categories with no facility, wait time shared by
 * families naming several objects, and wait time from families naming no loaded object.
 */
function FacilityTrafficTable({
  traffic,
  objects,
}: {
  traffic: FacilityTraffic
  objects: readonly DatabaseCityObject[]
}) {
  const nameOf = (objectId: string) => {
    const object = objects.find(item => item.objectId === objectId)
    return object ? `${object.schemaName}.${object.name}` : objectId
  }
  // Captured milliseconds are lossless base-10 strings, so they are grouped as BigInt: rendering an
  // exact counter through a double would round it, and the saturation note promises exactness.
  const exact = (milliseconds: string) => BigInt(milliseconds).toLocaleString()
  return (
    <section className="city-wait-lanes" aria-labelledby="city-wait-lanes-title">
      <div className="section-heading">
        <div>
          <h2 id="city-wait-lanes-title">Waits as traffic to infrastructure</h2>
          <p>Captured Query Store wait categories routed to the facility that owns the resource</p>
        </div>
      </div>
      <p className="hud-note">{traffic.note}</p>
      {traffic.lanes.length > 0 && <div className="table-scroll"><table>
        <thead><tr>
          <th>Building</th><th>Facility</th><th>Captured wait (ms)</th>
          <th>Categories</th><th>Attribution</th>
        </tr></thead>
        <tbody>{traffic.lanes.map(lane => <tr key={lane.laneId}>
          <th scope="row">{nameOf(lane.objectId)}<small>{lane.familyIds.join(' · ')}</small></th>
          <td>{lane.facilityLabel}</td>
          <td>{exact(lane.waitMilliseconds)}
            {lane.saturated && <small>Wider than the map can draw; this figure is exact, the lane
              width is a floor.</small>}</td>
          <td>{lane.categories
            .map(total => `${total.category} ${exact(total.waitMilliseconds)}`)
            .join(' · ')}</td>
          <td>{lane.confidence}<small>{lane.rationale}</small></td>
        </tr>)}</tbody>
      </table></div>}
      {traffic.sharedLanes.length > 0 && <div className="table-scroll"><table>
        <caption>
          Shared lanes — one multi-object query family each, drawn once through every object it
          names. Each figure is the family&apos;s whole captured wait: it is not divided between these
          buildings, is not part of any building&apos;s total above, and must not be summed with them.
        </caption>
        <thead><tr>
          <th>Query family</th><th>Buildings it threads</th><th>Facility</th>
          <th>Captured wait (ms)</th><th>Categories</th><th>Attribution</th>
        </tr></thead>
        <tbody>{traffic.sharedLanes.map(lane => <tr key={lane.laneId}>
          <th scope="row">{lane.familyId}</th>
          <td>{lane.objectIds.map(nameOf).join(' · ')}
            {lane.offPageObjectCount > 0 && <small>{lane.offPageObjectCount} further named
              object/objects are not on this page, so the drawn path is shorter than the
              relationship.</small>}</td>
          <td>{lane.facilityLabel}</td>
          <td>{exact(lane.waitMilliseconds)}
            {lane.saturated && <small>Wider than the map can draw; this figure is exact, the lane
              width is a floor.</small>}</td>
          <td>{lane.categories
            .map(total => `${total.category} ${exact(total.waitMilliseconds)}`)
            .join(' · ')}</td>
          <td>{lane.confidence}<small>{lane.rationale}</small></td>
        </tr>)}</tbody>
      </table></div>}
      {traffic.unmapped.length > 0 && <div className="source-note">
        <strong>Captured waits with no facility on this map</strong>
        <ul>{traffic.unmapped.map(entry => <li key={entry.category}>
          {entry.category}: {exact(entry.waitMilliseconds)} ms — {entry.reason}
        </li>)}</ul>
      </div>}
      {traffic.shared.length > 0 && <div className="source-note">
        <strong>Wait time from multi-object families with nothing on this page</strong>
        <p>
          Query Store reports one wait total per query, not per object. These families name only
          objects absent from this page, so there is no honest path to thread a shared lane through;
          the time is reported whole here rather than divided or handed to a building that the
          family never named.
        </p>
        <ul>{traffic.shared.map(entry => <li key={entry.category}>
          {entry.category}: {exact(entry.waitMilliseconds)} ms
        </li>)}</ul>
      </div>}
      {traffic.unattributed.length > 0 && <div className="source-note">
        <strong>Wait time from families naming no object on this page</strong>
        <ul>{traffic.unattributed.map(entry => <li key={entry.category}>
          {entry.category}: {exact(entry.waitMilliseconds)} ms
        </li>)}</ul>
      </div>}
    </section>
  )
}

function formatShare(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '—'
  const percent = share * 100
  return percent < 0.1 ? '<0.1%' : `${percent.toFixed(percent < 10 ? 1 : 0)}%`
}

const RESOURCE_TAGS: Readonly<Record<FacilityKind, string>> = {
  cpu: 'CPU',
  memory: 'memory grant',
  storage: 'I/O',
  tempdb: 'tempdb',
  log: 'log',
  lock: 'locks',
}

function RoutePanel({
  route,
  plan,
}: {
  route: CityRoute
  plan: { choice: PlanChoice; showplan: NormalizedShowplan }
}) {
  return (
    <aside className="hud-slideover" aria-label={`This query's route · plan ${plan.choice.planId}`}>
      <ol className="route-directions">
        {route.stops.map(stop => (
          <li key={stop.ordinal} className={`stop-${stop.kind}`}>
            <strong>
              <span className="route-stop-ordinal" aria-hidden="true">{stop.ordinal}</span>
              {stop.label}
            </strong>
            <span className="route-stop-share">
              {formatShare(stop.estimatedCostShare)} of estimated plan cost
            </span>
            {stop.kind === 'offmap' && (
              <small className="is-warning">
                Not on this map — {stop.unresolvedReason ?? 'this object is outside the loaded page'}
              </small>
            )}
            <ul className="route-stop-ops">
              {stop.operations.map(operation => (
                <li key={operation.nodeId} className={operation.readsHere ? 'reads-here' : undefined}>
                  <code>{operation.physicalOperation}</code>
                  <span className="route-op-resource">{RESOURCE_TAGS[operation.resource]}</span>
                  <small>{operation.instruction}</small>
                </li>
              ))}
            </ul>
            {stop.warnings.length > 0 && <small className="is-warning">⚠ {stop.warnings.join(' · ')}</small>}
          </li>
        ))}
      </ol>
      {route.unplacedOperations.length > 0 && (
        <div className="source-note">
          <strong>Belongs to no table</strong>
          <ul>
            {route.unplacedOperations.map(operation => (
              <li key={operation.nodeId}>{operation.instruction}</li>
            ))}
          </ul>
        </div>
      )}
      {route.offMapStops.length > 0 && (
        <div className="source-note">
          <strong>{route.offMapStops.length} stop{route.offMapStops.length === 1 ? '' : 's'} could
            not be drawn</strong>
          <p>
            The itinerary above lists them in place so the sequence stays whole, but the line on the
            map skips them: it joins the stops either side, which is shorter than the journey the
            query actually makes.
          </p>
        </div>
      )}
      <div className="source-note">
        <strong>The stops are where the tables are; the split between them is estimated</strong>
        <p>
          A query does not drive to a wait facility, so this route stops only at tables. Every operator
          still appears, listed at the table whose rows it worked on, and the share beside each stop is
          the optimizer&rsquo;s estimated cost — what it expected to do, not what it measured.
          {route.estimatedCostUnattributed > 0.001
            ? ` ${formatShare(route.estimatedCostUnattributed)} of the estimate reached no building on this map.`
            : ''}
        </p>
      </div>
      <div className="source-note">
        <strong>Compiled plan shape only</strong>
        <p>{route.runtimeOverlayCaveat}</p>
      </div>
    </aside>
  )
}

function RoadPanel({
  road,
  fromName,
  toName,
  onSelectEndpoint,
  hasEndpoint,
  onClose,
}: {
  road: RoadTraffic
  fromName: string
  toName: string
  onSelectEndpoint: (objectId: string) => void
  hasEndpoint: (objectId: string) => boolean
  onClose: () => void
}) {
  const endpoint = (objectId: string, name: string) =>
    hasEndpoint(objectId)
      ? <button type="button" className="link-button" onClick={() => onSelectEndpoint(objectId)}>{name}</button>
      : <span>{name} <small>(not on this map)</small></span>

  return (
    <aside className="hud-slideover" aria-labelledby="city-road-title">
      <div className="detail-title">
        <h2 id="city-road-title">Road</h2>
        <button type="button" onClick={onClose}>Close</button>
      </div>
      <p className="road-endpoints">
        {endpoint(road.fromObjectId, fromName)}
        <span aria-hidden="true"> ↔ </span>
        <span className="visually-hidden">is referenced together with</span>
        {endpoint(road.toId, toName)}
      </p>
      <dl>
        <div><dt>Reference</dt><dd>{road.kind} · {road.confidence}</dd></div>
        <div><dt>Executions</dt><dd>{road.executions?.toLocaleString() ?? 'Unavailable'}</dd></div>
        <div><dt>Query families</dt><dd>{road.familyIds.length}</dd></div>
        <div><dt>Wait share</dt><dd>
          {road.waitShare === null ? 'Unavailable' : `${(road.waitShare * 100).toFixed(1)}%`}
        </dd></div>
        <div><dt>Congestion</dt><dd>{CONGESTION_LABELS[road.grade]}</dd></div>
      </dl>
      <div className="source-note">
        <strong>Why this road looks like this</strong>
        <p>{road.rationale}</p>
      </div>
      <p className="hud-note">
        Width maps captured executions naming both endpoints; colour maps captured wait share. The
        road follows the street grid and claims a reference between these two objects, never row flow.
      </p>
    </aside>
  )
}

function BuildingPanel({
  object,
  metric,
  facilityCount,
}: {
  object: DatabaseCityObject
  metric: Metric
  facilityCount: number
}) {
  // Shared totals are query-level and repeat on every object the query named, so they are shown on
  // their own row and never substituted for the attributed figure above them.
  const shared = databaseCitySharedMetricValue(object, metric)
  return (
    <aside className="hud-slideover" aria-labelledby="city-building-title">
      <div className="detail-title">
        <h2 id="city-building-title">{object.schemaName}.{object.name}</h2>
        <span>{object.kind}</span>
      </div>
      <dl>
        <div><dt>Reserved pages</dt><dd>{object.reservedPages8KiB ?? object.sizeReason}</dd></div>
        <div><dt>Used pages</dt><dd>{object.usedPages8KiB ?? object.sizeReason}</dd></div>
        <div><dt>Direct operations</dt><dd>{object.directActivity.totalOperations ?? object.directActivity.evidence.status}</dd></div>
        <div><dt>{metric} attributed</dt><dd>{databaseCityMetricValue(object, metric) ?? attributedAbsenceLabel(object)}</dd></div>
        {shared && <div className="is-shared">
          <dt>{metric} shared</dt>
          <dd>{shared} <small>across {object.attributedExposure.shared!.familyCount} joined quer{object.attributedExposure.shared!.familyCount === '1' ? 'y' : 'ies'}</small></dd>
        </div>}
        <div><dt>Attached indexes</dt><dd>{object.indexes.length}</dd></div>
      </dl>
      <p className="hud-note">{facilityCount} infrastructure facilities are scattered across the block grid.</p>
      <div className="source-note">
        <strong>Attributed evidence</strong>
        <p>{object.attributedExposure.confidence} · {object.attributedExposure.rationale}</p>
        {object.attributedExposure.shared && <p>{object.attributedExposure.shared.rationale}</p>}
      </div>
    </aside>
  )
}

function ObjectDetail({ object, metric }: { object: DatabaseCityObject | null; metric: Metric }) {
  if (!object) return <aside className="detail"><p>No object matches this page and filter.</p></aside>
  return <aside className="detail city-object-detail" aria-labelledby="city-object-detail-title">
    <div className="detail-title"><h2 id="city-object-detail-title">{object.schemaName}.{object.name}</h2><span>{object.kind}</span></div>
    <dl>
      <div><dt>Stable ID</dt><dd>{object.objectId}</dd></div>
      <div><dt>Reserved pages / bytes</dt><dd>{object.reservedPages8KiB ?? 'Unavailable'} / {object.reservedBytes ?? 'Unavailable'}</dd></div>
      <div><dt>Used pages / bytes</dt><dd>{object.usedPages8KiB ?? 'Unavailable'} / {object.usedBytes ?? 'Unavailable'}</dd></div>
      <div><dt>Direct operations</dt><dd>{object.directActivity.totalOperations ?? object.directActivity.evidence.status}</dd></div>
      <div><dt>Reset epoch</dt><dd>{object.directActivity.resetEpochToken ?? 'Unavailable'}</dd></div>
      <div><dt>{metric} attributed</dt><dd>{databaseCityMetricValue(object, metric) ?? 'Unavailable'}</dd></div>
      {object.attributedExposure.shared && <div className="is-shared">
        <dt>{metric} shared</dt>
        <dd>{databaseCitySharedMetricValue(object, metric)} across {object.attributedExposure.shared.familyCount} joined quer{object.attributedExposure.shared.familyCount === '1' ? 'y' : 'ies'}</dd>
      </div>}
    </dl>
    <h3>Attached indexes</h3>
    {object.indexes.length === 0 ? <p>None reported.</p> : <ul className="attached-indexes">
      {object.indexes.map(index => <li key={index.indexId}><strong>{index.name}</strong>
        <span>{index.kind} · direct operations {index.directActivity.totalOperations ?? index.directActivity.evidence.status}</span>
        <small>{index.directActivity.evidence.source}: {index.directActivity.evidence.reason}</small></li>)}
    </ul>}
    <div className="source-note"><strong>Direct evidence</strong><p>
      {object.directActivity.evidence.source} · {object.directActivity.evidence.status} · {object.directActivity.evidence.reason}
    </p></div>
    <div className="source-note"><strong>Attributed evidence</strong><p>
      {object.attributedExposure.evidence.source} · {object.attributedExposure.confidence} · {object.attributedExposure.rationale}
    </p>
    {object.attributedExposure.shared && <p>{object.attributedExposure.shared.rationale}</p>}
    </div>
  </aside>
}
