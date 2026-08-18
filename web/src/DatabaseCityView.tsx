import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchDatabaseCity,
  fetchPlan,
  fetchQueryFamilies,
  fetchQueryFamily,
  subscribeToLiveIncidents,
} from './api'
import { accessibleObjectLabel, databaseCityMetricValue, formatKiB, shouldRenderRoute } from './databaseCity'
import type { DatabaseCityObject, DatabaseCityPage, DatabaseCityQueryFamily } from './databaseCityContracts'
import type { LiveIncidentResponse } from './liveContracts'
import type { LiveFeedConnectionState } from './liveIncidents'
import type { NormalizedShowplan, QueryFamilySummary } from './contracts'
import { DatabaseCityViewport } from './DatabaseCityViewport'
import { liveBlockingEdges } from './cityBlocking'
import { planCity } from './cityPlan'
import { buildCityRoute, type CityRoute } from './cityRoute'
import { CONGESTION_LABELS, gradeRoads, type RoadTraffic } from './cityTraffic'
import { FACILITY_LABELS, layoutFacilities, projectFacilities } from './cityInfrastructure'
import { projectFacilityTraffic, type FacilityTraffic } from './cityFacilityTraffic'

const metrics = ['cpu', 'duration', 'reads', 'executions'] as const
type Metric = (typeof metrics)[number]

type Props = {
  databaseId: string
  databaseName: string
  onBack: () => void
  onOpenQuery: (familyId: string) => void
}

type PlanChoice = {
  planId: string
  familyId: string
  queryHash: string
  text: string | null
  textReason: string
  executionCount: string
}

export function DatabaseCityView({ databaseId, databaseName, onBack, onOpenQuery }: Props) {
  const [metric, setMetric] = useState<Metric>('cpu')
  const [page, setPage] = useState<DatabaseCityPage | null>(null)
  const [objects, setObjects] = useState<DatabaseCityObject[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('object'))
  const [selectedRoadId, setSelectedRoadId] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(true)
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

  useEffect(() => {
    for (const request of requests.current) request.abort()
    requests.current.clear()
    const controller = new AbortController()
    requests.current.add(controller)
    setLoading(true)
    setError(null)
    setPage(null)
    setObjects([])
    void fetchDatabaseCity(databaseId, metric, null, controller.signal)
      .then(value => {
        setPage(value)
        setObjects(value.objects)
        setSelectedId(current =>
          current && value.objects.some(object => object.objectId === current)
            ? current
            : value.objects[0]?.objectId ?? null)
      })
      .catch(reason => {
        if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError(String(reason))
      })
      .finally(() => {
        requests.current.delete(controller)
        if (!controller.signal.aborted) setLoading(false)
      })
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
  const visibleObjects = useMemo(() => {
    const term = filter.trim().toLocaleLowerCase()
    if (!term) return objects
    return objects.filter(object =>
      `${object.schemaName}.${object.name} ${object.kind} ${object.indexes.map(index => index.name).join(' ')}`
        .toLocaleLowerCase()
        .includes(term))
  }, [filter, objects])
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

  const route: CityRoute | null = useMemo(() => {
    if (!activePlan) return null
    const cityPlan = planCity(visibleObjects)
    return buildCityRoute(activePlan.showplan, {
      plan: cityPlan,
      objects: visibleObjects,
      facilities: layoutFacilities(cityPlan.civic),
      databaseName,
    })
  }, [activePlan, visibleObjects, databaseName])

  const loadMore = () => {
    if (!page?.nextPageToken) return
    const controller = new AbortController()
    requests.current.add(controller)
    setLoading(true)
    void fetchDatabaseCity(databaseId, metric, page.nextPageToken, controller.signal)
      .then(next => {
        setObjects(current => {
          const byId = new Map(current.map(object => [object.objectId, object]))
          for (const object of next.objects) byId.set(object.objectId, object)
          return [...byId.values()]
        })
        setPage(next)
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

  const finder = (
    <div className="hud-finder">
      <label className="hud-field">
        <span>Find object or index</span>
        <input
          type="search"
          value={filter}
          onChange={event => setFilter(event.target.value)}
          placeholder="dbo.Customer"
        />
      </label>
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

  const panel = route
    ? <RoutePanel route={route} plan={activePlan!} onClear={() => setActivePlan(null)} />
    : selectedRoad
      ? <RoadPanel
        road={selectedRoad}
        fromName={endpointName(selectedRoad.fromObjectId)}
        toName={endpointName(selectedRoad.toId)}
        onSelectEndpoint={selectRoadEndpoint}
        hasEndpoint={objectId => objects.some(object => object.objectId === objectId)}
        onClose={closeRoad}
      />
      : selected
        ? <BuildingPanel object={selected} metric={metric} facilityCount={facilities.length} />
        : null

  return (
    <section className="database-city" aria-labelledby="database-city-title">
      <nav className="breadcrumbs" aria-label="Atlas level">
        <button type="button" onClick={onBack}>Server atlas</button>
        <span aria-hidden="true">/</span>
        <strong>{databaseName}</strong>
        <span>database overview and object detail</span>
      </nav>

      <div className="city-heading">
        <div>
          <p className="eyebrow">Database city · factual projection</p>
          <h2 id="database-city-title" ref={headingRef} tabIndex={-1}>{databaseName}</h2>
          <p>{page?.totalObjects ?? '—'} objects · {displayedSchemas.length || '—'} schema neighborhoods loaded</p>
        </div>
        <div className="city-controls">
          <label>Rank workload
            <select value={metric} onChange={event => setMetric(event.target.value as Metric)}>
              {metrics.map(value => <option key={value}>{value}</option>)}
            </select>
          </label>
        </div>
      </div>

      {loading && <p className="source-banner" role="status">Loading bounded database evidence…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {page && <>
        <p className={`city-disclosure status-${page.evidence.status.toLowerCase()}`}>
          <strong>{page.evidence.source} · {page.evidence.status}</strong> {page.evidence.reason}
        </p>

        <DatabaseCityViewport
          objects={visibleObjects}
          roads={roads}
          facilities={facilities}
          facilityTraffic={facilityTraffic}
          route={route}
          selectedId={selectedId}
          selectedRoadId={selectedRoadId}
          onSelect={selectObject}
          onSelectRoad={selectRoad}
          roadLabels={roadLabels}
          finder={finder}
          panel={panel}
          liveStatus={liveStatus}
        />

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
          category with no facility here is listed, never folded into one, and a family naming more
          than one object is reported whole rather than divided.
          Unknown size or unavailable activity uses fixed wireframe geometry and makes no quantity
          claim. Ground labels name each building and facility and carry identity only — a label
          never restates or qualifies a measurement. Everything else — roof shapes, windows, doors,
          setbacks, crowns, sidewalks, schema neighborhood tints — is decoration seeded from each
          object&apos;s stable id and encodes nothing. Schema neighborhood tints are off by default,
          because the schema name a tint grouped by is now written on every building label; turn
          them back on from the Layers control.
        </p>

        <details className="evidence-tables" open>
          <summary>Evidence tables · the text-first equivalent of the map</summary>

          <div className="city-legend" aria-label="Database city legend">
            <span><i className="legend-direct" /> direct cumulative DMV activity</span>
            <span><i className="legend-attributed" /> attributed Query Store aggregate</span>
            <span><i className="legend-unknown">×</i> unknown, nonquantitative size</span>
            <span><i className="legend-route" /> confidence-graded co-reference, never row flow</span>
          </div>
          <div className="city-schema-strip" aria-label="Schema neighborhoods">
            {displayedSchemas.map(schema => <div key={schema.schemaId}>
              <strong>{schema.name}</strong>
              <span>{schema.objectCount} objects · neighborhood {schema.neighborhoodOrdinal + 1}</span>
            </div>)}
          </div>

          <div className="analysis-grid city-analysis">
            <section className="table-region" aria-labelledby="city-object-table">
              <div className="section-heading">
                <div><h2 id="city-object-table">Objects and attached indexes</h2><p>Text-first equivalent of the viewport</p></div>
              </div>
              <div className="table-scroll">
                <table>
                  <thead><tr><th>Object</th><th>Size</th><th>Direct activity</th><th>Attributed exposure</th></tr></thead>
                  <tbody>{visibleObjects.map(object => <tr key={object.objectId} className={selectedId === object.objectId ? 'is-selected' : undefined}>
                    <th scope="row"><button type="button" aria-label={accessibleObjectLabel(object)}
                      aria-pressed={selectedId === object.objectId} onClick={() => selectObject(object.objectId)}>
                      {object.schemaName}.{object.name}
                    </button><small>{object.kind} · {object.indexes.length} attached indexes</small></th>
                    <td>{object.reservedBytes === null ? <><strong>Unknown ×</strong><small>{object.sizeReason}</small></> :
                      <><strong>{formatKiB(object.reservedBytes)} reserved</strong><small>{formatKiB(object.usedBytes!)} used</small></>}</td>
                    <td><strong>{object.directActivity.totalOperations ?? object.directActivity.evidence.status}</strong>
                      <small>{object.directActivity.evidence.source} · {object.directActivity.evidence.reason}</small></td>
                    <td><strong>{databaseCityMetricValue(object, metric) ?? object.attributedExposure.evidence.status}</strong>
                      <small>{object.attributedExposure.confidence} · {object.attributedExposure.rationale}</small></td>
                  </tr>)}</tbody>
                </table>
              </div>
              {page.nextPageToken && <button type="button" className="load-more" onClick={loadMore}>
                Load next bounded object page
              </button>}
            </section>
            <ObjectDetail object={selected} metric={metric} />
          </div>

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

          <FacilityTrafficTable traffic={facilityTraffic} objects={visibleObjects} />

          <section className="city-workload" aria-labelledby="city-workload-title">
            <div className="section-heading">
              <div><h2 id="city-workload-title">Top query-family exposure</h2>
                <p>Backend-ranked top 12; no browser-side 100k layout</p></div>
            </div>
            <div className="table-scroll"><table>
              <thead><tr><th>Family</th><th>Executions</th><th>CPU µs</th><th>Duration µs</th><th>Reads (8-KiB)</th><th>Attribution</th><th>Map</th></tr></thead>
              <tbody>{page.topQueryFamilies.map(family => <tr key={family.familyId}>
                <th scope="row">{family.familyId.startsWith('qf:')
                  ? <button type="button" onClick={() => onOpenQuery(family.familyId)}>{family.familyId}</button>
                  : family.familyId}<small>{family.queryHash} · {family.evidence.source}</small></th>
                <td>{family.executionCount}</td><td>{family.totalCpuMicroseconds}</td>
                <td>{family.totalDurationMicroseconds}</td><td>{family.totalLogicalReads8KiBPages}</td>
                <td>{family.confidence}<small>{family.rationale}</small></td>
                <td className="map-cell"><button
                  type="button"
                  disabled={mappingFamilyId === family.familyId}
                  aria-label={`Draw the plan for ${family.familyId} on the map`}
                  onClick={() => void showFamilyOnMap(family)}
                >{mappingFamilyId === family.familyId ? 'Reading plan…' : 'Show on map'}</button>
                  {activePlan?.choice.familyId === family.familyId &&
                    <small>Drawn as plan {activePlan.choice.planId}</small>}</td>
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
                      onClick={() => selectRoad(route.routeId)}
                    >
                      {endpointName(route.fromObjectId)} ↔ {endpointName(route.toId)}
                    </button>
                    : <>{endpointName(route.fromObjectId)} ↔ {endpointName(route.toId)}</>}
                  <br />
                  {graded
                    ? `${CONGESTION_LABELS[graded.grade]} · ${graded.rationale} `
                    : 'Not drawn on the map: an endpoint is outside the loaded page or filter. '}
                  {route.rationale} · {route.evidence.status}
                </span>
              </li>
            })}</ul>
          </section>
        </details>
      </>}
    </section>
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
      {traffic.unmapped.length > 0 && <div className="source-note">
        <strong>Captured waits with no facility on this map</strong>
        <ul>{traffic.unmapped.map(entry => <li key={entry.category}>
          {entry.category}: {exact(entry.waitMilliseconds)} ms — {entry.reason}
        </li>)}</ul>
      </div>}
      {traffic.shared.length > 0 && <div className="source-note">
        <strong>Wait time from families naming more than one object</strong>
        <p>
          Query Store reports one wait total per query, not per object, so this time is reported
          whole rather than divided between the buildings the family names.
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

function RoutePanel({
  route,
  plan,
  onClear,
}: {
  route: CityRoute
  plan: { choice: PlanChoice; showplan: NormalizedShowplan }
  onClear: () => void
}) {
  return (
    <aside className="hud-slideover" aria-labelledby="city-route-title">
      <div className="detail-title">
        <h2 id="city-route-title">Route through the city</h2>
        <button type="button" onClick={onClear}>Clear</button>
      </div>
      <p className="hud-note">
        Plan {plan.choice.planId} · {route.stops.length - route.offMapStops.length} of {route.stops.length} stops
        placed on this map
        {route.offMapStops.length > 0 ? ` · ${route.offMapStops.length} off-map` : ''}
      </p>
      <ol className="route-directions">
        {route.stops.map(stop => (
          <li key={stop.ordinal} className={`stop-${stop.kind}`}>
            <strong>{stop.physicalOperation}</strong>
            <span>{stop.label}</span>
            <small>{stop.instruction}</small>
            {stop.warnings.length > 0 && <small className="is-warning">⚠ {stop.warnings.join(' · ')}</small>}
          </li>
        ))}
      </ol>
      {route.offMapStops.length > 0 && (
        <div className="source-note">
          <strong>Off-map stops</strong>
          <ul>
            {route.offMapStops.map(stop => (
              <li key={stop.ordinal}>
                {stop.physicalOperation} — {stop.unresolvedReason ?? stop.instruction}
              </li>
            ))}
          </ul>
        </div>
      )}
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
        <div><dt>{metric} attributed</dt><dd>{databaseCityMetricValue(object, metric) ?? 'Unavailable'}</dd></div>
        <div><dt>Attached indexes</dt><dd>{object.indexes.length}</dd></div>
      </dl>
      <p className="hud-note">{facilityCount} civic facilities are drawn in the infrastructure district.</p>
      <div className="source-note">
        <strong>Attributed evidence</strong>
        <p>{object.attributedExposure.confidence} · {object.attributedExposure.rationale}</p>
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
    </p></div>
  </aside>
}
