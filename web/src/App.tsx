import { Suspense, lazy, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { fetchArchiveInfo, fetchAtlas, fetchDeploymentNotice, fetchEdgeSourceInfo } from './api'
import { accessibleDatabaseLabel, collectorDisplayState, collectorSummary, evidenceText, formatBytes, formatDecimalCount, formatFill, metric } from './atlas'
import { ChunkErrorBoundary } from './ChunkErrorBoundary'
import {
  FloatingCard,
  MapShell,
  SearchField,
  SidebarHeader,
  StatusChip,
  ViewModeTile,
  type MapViewMode,
} from './MapShell'
import type { ArchiveInfo, AtlasSnapshot, DatabaseAtlasItem, EdgeSourceInfo } from './contracts'
import './App.css'

const AtlasViewport = lazy(() => import('./AtlasViewport').then(m => ({ default: m.AtlasViewport })))
const DatabaseCityView = lazy(() => import('./DatabaseCityView').then(m => ({ default: m.DatabaseCityView })))

/**
 * The map is the application.
 *
 * There are two levels — the server atlas and one database city — and each fills the window with a
 * single canvas and puts everything else in a sidebar beside it or on a card floating over it.
 * Levels own their own {@link MapShell} rather than receiving slots from here, because the sidebar
 * of a city is a different thing from the sidebar of an atlas and pretending otherwise would mean
 * threading half of each level's state back up through this component.
 */
export default function App() {
  const [snapshot, setSnapshot] = useState<AtlasSnapshot | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [cityDatabaseId, setCityDatabaseId] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('view') === 'city' ? params.get('database') : null
  })
  // Persisted to the URL so a shared link keeps the look it was shared in.
  const [viewMode, setViewMode] = useState<MapViewMode>(() =>
    new URLSearchParams(window.location.search).get('mode') === 'city' ? 'city' : 'map')
  const [archiveInfo, setArchiveInfo] = useState<ArchiveInfo | null>(null)
  const [edgeInfo, setEdgeInfo] = useState<EdgeSourceInfo | null>(null)
  // Starts false so the notice draws until the server actually says it was
  // acknowledged. A slow or failed read shows the warning; it never hides it.
  const [noticeAcknowledged, setNoticeAcknowledged] = useState(false)
  const [noticeDismissed, setNoticeDismissed] = useState(false)
  const [provenanceDismissed, setProvenanceDismissed] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    void fetchDeploymentNotice(controller.signal).then(setNoticeAcknowledged)
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let refreshTimer: number | undefined
    let loaded = false
    let archiveDetected = false
    const load = () => Promise.all([
      fetchAtlas(controller.signal),
      fetchArchiveInfo(controller.signal),
      fetchEdgeSourceInfo(controller.signal),
    ])
      .then(([atlas, archive, edge]) => {
        setSnapshot(atlas)
        setArchiveInfo(archive)
        setEdgeInfo(edge)
        archiveDetected = archive !== null
        loaded = true
        setSelectedId(current => current && atlas.databases.some(database => database.databaseId === current)
          ? current
          : atlas.databases[0]?.databaseId ?? null)
        setError(null)
        setRefreshError(null)
      })
      .catch(reason => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        const message = reason instanceof Error ? reason.message : 'The atlas could not be loaded'
        if (!loaded) setError(message)
        else setRefreshError(message)
      })
      .finally(() => {
        if (!controller.signal.aborted && !archiveDetected) refreshTimer = window.setTimeout(load, 30_000)
      })
    void load()
    return () => {
      controller.abort()
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
    }
  }, [])

  const selectDatabase = useCallback((databaseId: string) => setSelectedId(databaseId), [])
  const hoverDatabase = useCallback((databaseId: string | null) => setHoveredId(databaseId), [])
  const cityDatabase = snapshot?.databases.find(database => database.databaseId === cityDatabaseId) ?? null

  const changeViewMode = useCallback((mode: MapViewMode) => {
    setViewMode(mode)
    const url = new URL(window.location.href)
    url.searchParams.set('mode', mode)
    window.history.replaceState(null, '', url)
  }, [])

  const enterDatabase = useCallback((databaseId: string) => {
    setCityDatabaseId(databaseId)
    const url = new URL(window.location.href)
    url.searchParams.set('view', 'city')
    url.searchParams.set('database', databaseId)
    url.searchParams.delete('object')
    window.history.replaceState(null, '', url)
  }, [])

  const leaveDatabase = useCallback(() => {
    setCityDatabaseId(null)
    const url = new URL(window.location.href)
    url.searchParams.delete('view')
    url.searchParams.delete('database')
    url.searchParams.delete('object')
    window.history.replaceState(null, '', url)
  }, [])

  const banners = (
    <div className="floating-stack">
      {!noticeAcknowledged && !noticeDismissed && (
        <FloatingCard tone="warning" title="Deployment notice" onDismiss={() => setNoticeDismissed(true)}>
          <p>
            SQLSimCity has <strong>no built-in login or authentication</strong>. Anyone who can reach
            this page sees all evidence. Serve it only on a trusted network or behind an
            authenticating reverse proxy, and set <code>AllowedHosts</code> to the exact host(s) it is
            served on.
          </p>
        </FloatingCard>
      )}
      {!provenanceDismissed && archiveInfo && (
        <FloatingCard tone="info" title="ImportedArchive · static offline evidence" onDismiss={() => setProvenanceDismissed(true)}>
          <ArchiveInfoPanel info={archiveInfo} />
        </FloatingCard>
      )}
      {!provenanceDismissed && edgeInfo && (
        <FloatingCard tone="info" title={`EdgeConnector · ${edgeInfo.state}`} onDismiss={() => setProvenanceDismissed(true)}>
          <EdgeSourcePanel info={edgeInfo} />
        </FloatingCard>
      )}
    </div>
  )

  if (cityDatabase) {
    return (
      <LazySurface label="Database city" fallback={<ShellFallback label="Loading database city…" />}>
        <DatabaseCityView
          databaseId={cityDatabase.databaseId}
          databaseName={cityDatabase.name}
          onBack={leaveDatabase}
          viewMode={viewMode}
          onViewModeChange={changeViewMode}
          banners={banners}
        />
      </LazySurface>
    )
  }

  return (
    <AtlasLevel
      snapshot={snapshot}
      error={error}
      refreshError={refreshError}
      selectedId={selectedId}
      hoveredId={hoveredId}
      viewMode={viewMode}
      banners={banners}
      onViewModeChange={changeViewMode}
      onSelect={selectDatabase}
      onHover={hoverDatabase}
      onEnterDatabase={enterDatabase}
    />
  )
}

/**
 * The server atlas as a map: every database is a city on one canvas, and the sidebar is the index
 * of those cities.
 */
function AtlasLevel({
  snapshot,
  error,
  refreshError,
  selectedId,
  hoveredId,
  viewMode,
  banners,
  onViewModeChange,
  onSelect,
  onHover,
  onEnterDatabase,
}: {
  snapshot: AtlasSnapshot | null
  error: string | null
  refreshError: string | null
  selectedId: string | null
  hoveredId: string | null
  viewMode: MapViewMode
  banners: ReactNode
  onViewModeChange: (mode: MapViewMode) => void
  onSelect: (databaseId: string) => void
  onHover: (databaseId: string | null) => void
  onEnterDatabase: (databaseId: string) => void
}) {
  const [term, setTerm] = useState('')
  const selected = snapshot?.databases.find(database => database.databaseId === selectedId) ?? null
  const hovered = snapshot?.databases.find(database => database.databaseId === hoveredId) ?? null
  const sourceState = collectorDisplayState(snapshot?.collection, refreshError !== null)

  const matches = useMemo(() => {
    if (!snapshot) return []
    const needle = term.trim().toLocaleLowerCase()
    if (needle === '') return snapshot.databases
    return snapshot.databases.filter(database =>
      database.name.toLocaleLowerCase().includes(needle) ||
      database.databaseId.toLocaleLowerCase().includes(needle))
  }, [snapshot, term])

  const sidebar = (
    <>
      <SidebarHeader
        brand={
          <div className="sidebar-brand">
            <span className="sidebar-mark" aria-hidden="true" />
            <span className="sidebar-brand-name">SQLSimCity</span>
            <a
              className="sidebar-brand-link"
              href="https://github.com/cbattlegear/SQLSimCity"
              target="_blank"
              rel="noreferrer noopener"
              title="SQLSimCity on GitHub"
            >
              <span aria-hidden="true">↗</span>
              <span className="visually-hidden">SQLSimCity on GitHub (opens in a new tab)</span>
            </a>
          </div>
        }
        title={snapshot?.target.displayName ?? 'Server atlas'}
        subtitle={snapshot ? `${snapshot.target.platform} · ${snapshot.databases.length} databases` : 'Loading…'}
      />
      <div className="sidebar-search">
        <SearchField
          value={term}
          onChange={setTerm}
          label="Search databases"
          placeholder="Search databases"
        />
      </div>

      {selected ? (
        <div className="sidebar-scroll">
          <DetailPanel database={selected} onEnterDatabase={onEnterDatabase} />
        </div>
      ) : (
        <div className="sidebar-scroll">
          <p className="sidebar-empty">Select a database to inspect its exact evidence.</p>
        </div>
      )}

      <div className="sidebar-scroll">
        <ul className="address-list">
          {matches.map(database => (
            <li key={database.databaseId}>
              <button
                type="button"
                className={`address-entry ${database.databaseId === selectedId ? 'is-selected' : ''}`}
                aria-label={accessibleDatabaseLabel(database)}
                aria-pressed={database.databaseId === selectedId}
                onClick={() => onSelect(database.databaseId)}
                onDoubleClick={() => onEnterDatabase(database.databaseId)}
              >
                <span className="address-icon" aria-hidden="true">▦</span>
                <span className="address-text">
                  <strong>{database.name}</strong>
                  <span>{formatBytes(database.allocated)} allocated</span>
                  <small>{database.liveActivity.evidence.status} live · {database.queryStore.capability} Query Store</small>
                </span>
              </button>
            </li>
          ))}
          {snapshot && matches.length === 0 && (
            <li className="address-empty">No database matches “{term}”.</li>
          )}
        </ul>
      </div>

      <details className="sidebar-drawer">
        <summary>Legend &amp; evidence</summary>
        <div className="sidebar-drawer-body">
          <div className="legend" aria-label="Atlas legend">
            <span><i className="legend-plot" /> town ground = allocated</span>
            <span><i className="legend-tower" /> tallest tower = used</span>
            <span><i className="legend-live" /> fresh live sample</span>
            <span><i className="legend-unknown">×</i> unknown size</span>
          </div>
          <p className="mapping-note">
            Each database is a town. The <strong>area</strong> its outline encloses is allocated KiB: t = min(1,
            log₂(1 + A) / 50), area = 144 + 9072t. The tallest tower uses used KiB: log₂(1 + U) × 2.6, so zero used
            bytes is zero height. Buildings follow that ground at one fixed block size, so their count reads as area
            and nothing else. An × town has unknown allocated size and carries no quantity; a fenced town has unknown
            used size and claims no height. Road confidence is the only thing a road between two towns encodes:
            solid = confirmed, long dash = probable, short dash = weaker.
          </p>
          <p className="mapping-note">
            <strong>Scenery is not evidence.</strong> The shape of a town&rsquo;s edge, its ring road and radial
            streets, and the river, lakes and woodland between towns are decoration. Town shapes are seeded from the
            database id; the landscape is seeded from a fixed constant and is byte-identical every session. None of it
            moves when a database grows, appears or is dropped, and none of it can be read as a measurement.
          </p>
          {snapshot && (
            <>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr><th>Database</th><th>Allocated</th><th>Live activity</th><th>Query Store</th></tr>
                  </thead>
                  <tbody>
                    {snapshot.databases.map(database => (
                      <tr key={database.databaseId} className={database.databaseId === selectedId ? 'is-selected' : undefined}>
                        <th scope="row">
                          <button
                            type="button"
                            aria-label={accessibleDatabaseLabel(database)}
                            aria-pressed={database.databaseId === selectedId}
                            onClick={() => onSelect(database.databaseId)}
                          >{database.name}</button>
                        </th>
                        <td>{formatBytes(database.allocated)}</td>
                        <td><StatusCell database={database} kind="live" /></td>
                        <td><StatusCell database={database} kind="query" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <section className="topology" aria-labelledby="topology-title">
                <div className="section-heading">
                  <h2 id="topology-title">Cross-database evidence</h2>
                  <p>Line pattern and text both communicate confidence</p>
                </div>
                <ul>
                  {snapshot.edges.map(edge => (
                    <li key={edge.edgeId}>
                      <span className={`edge-mark edge-${edge.confidence.toLowerCase()}`} aria-hidden="true" />
                      <strong>{nameFor(snapshot, edge.fromDatabaseId)} → {nameFor(snapshot, edge.toDatabaseId)}</strong>
                      <span>{edge.confidence}: {edge.rationale}</span>
                    </li>
                  ))}
                </ul>
              </section>
              {snapshot.collection && (
                <div className="source-note">
                  <strong>{snapshot.collection.mode} source · {snapshot.collection.state}</strong>
                  <p>{collectorSummary(snapshot.collection)} {snapshot.collection.reason}</p>
                </div>
              )}
            </>
          )}
        </div>
      </details>
    </>
  )

  return (
    <MapShell sidebar={sidebar}>
      {error ? (
        <section className="stage-message error" role="alert">
          <h2>Atlas unavailable</h2>
          <p>{error}. Confirm the ASP.NET API is running, then reload this page.</p>
        </section>
      ) : !snapshot ? (
        <section className="stage-message loading" aria-live="polite">
          <span className="loading-mark" aria-hidden="true" /> Loading atlas from the API…
        </section>
      ) : (
        <ChunkErrorBoundary label="3D atlas">
          <Suspense fallback={<div className="stage-message loading" role="status"><strong>Loading atlas…</strong></div>}>
            <AtlasViewport
              snapshot={snapshot}
              selectedId={selectedId}
              viewMode={viewMode}
              onHover={onHover}
              onSelect={onSelect}
              onOpen={onEnterDatabase}
            />
          </Suspense>
        </ChunkErrorBoundary>
      )}

      {snapshot && (
        <StatusChip
          degraded={sourceState.degraded || refreshError !== null}
          title={refreshError
            ? `Atlas refresh failed: ${refreshError}. The last successful snapshot is retained and may be stale.`
            : snapshot.collection?.reason}
        >
          {snapshot.collection?.mode ?? 'Fixture'} · {sourceState.state} ·{' '}
          {new Date(snapshot.generatedAt).toLocaleTimeString()}
        </StatusChip>
      )}

      <p className="hover-readout" aria-live="polite">
        {hovered
          ? `${hovered.name} — click to inspect exact evidence, double-click to enter its city`
          : 'Move across a city, or pick one from the list'}
      </p>

      <ViewModeTile mode={viewMode} onChange={onViewModeChange} />
      {banners}
    </MapShell>
  )
}

function ArchiveInfoPanel({ info }: { info: ArchiveInfo }) {
  return (
    <>
      <p>
        Created {new Date(info.createdAt).toLocaleString()} by producer {info.producerVersion}.
        Original target alias: {info.target.displayAlias}. This installation makes no SQL Server connection.
      </p>
      <p>
        Sections: {info.includedSections.join(', ')}. {info.entryCount} bounded entries,{' '}
        {new Intl.NumberFormat().format(info.archiveBytes)} bytes. Policy {info.redaction.policyVersion};
        protected identifiers {info.redaction.protectedIdentifiersIncluded ? 'included by explicit operator opt-in' : 'excluded'}.
      </p>
      <p>
        Schema {info.schemaVersion}. Features: {info.features.join(', ') || 'none'}.
        Capabilities: {info.capabilities.join(', ') || 'none'}.
      </p>
      <p>Excluded by export policy: {info.redaction.excludedFields.join(', ') || 'none declared'}.</p>
    </>
  )
}

function EdgeSourcePanel({ info }: { info: EdgeSourceInfo }) {
  return (
    <>
      <dl className="edge-source-facts">
        <div><dt>Target</dt><dd>{info.targetId}</dd></div>
        <div><dt>Connector</dt><dd>{info.connectorId ?? 'not connected'}</dd></div>
        <div><dt>Generation</dt><dd>{info.sequence ?? 'awaiting first complete batch'}</dd></div>
        <div><dt>Captured</dt><dd>{info.capturedAt ? new Date(info.capturedAt).toLocaleString() : 'not yet'}</dd></div>
        <div><dt>Sections</dt><dd>{info.sections.join(', ') || 'awaiting a complete generation'}</dd></div>
      </dl>
      <p>{info.qualification}</p>
    </>
  )
}

function StatusCell({ database, kind }: { database: DatabaseAtlasItem; kind: 'live' | 'query' }) {
  if (kind === 'query') {
    return <><strong>{database.queryStore.capability}</strong><small>{database.queryStore.reason}</small></>
  }
  return <><strong>{database.liveActivity.evidence.status}</strong><small>{database.liveActivity.evidence.reason}</small></>
}

function DetailPanel({ database, onEnterDatabase }: {
  database: DatabaseAtlasItem
  onEnterDatabase: (databaseId: string) => void
}) {
  return (
    <aside className="detail place-card" aria-labelledby="detail-title">
      <div className="detail-title"><h2 id="detail-title">{database.name}</h2><span>exact record</span></div>
      <button className="enter-database" type="button" onClick={() => onEnterDatabase(database.databaseId)}>
        Enter database city
      </button>
      <dl>
        <div><dt>Stable ID</dt><dd>{database.databaseId}</dd></div>
        <div><dt>Allocated</dt><dd>{formatBytes(database.allocated)}</dd></div>
        <div><dt>Used</dt><dd>{formatBytes(database.used)}</dd></div>
        <div><dt>Data fill</dt><dd>{formatFill(database.used, database.allocated)}</dd></div>
        {database.logAllocated && <div><dt>Log allocated</dt><dd>{formatBytes(database.logAllocated)}</dd></div>}
        {database.logUsed && <div><dt>Log used</dt><dd>{formatBytes(database.logUsed)}</dd></div>}
        <div><dt>State / compatibility</dt><dd>{database.state ?? 'Unavailable'} / {database.compatibilityLevel ?? 'Unavailable'}</dd></div>
        <div><dt>Active sessions</dt><dd>{metric(database.liveActivity.activeSessions)}</dd></div>
        <div><dt>Running requests</dt><dd>{metric(database.liveActivity.runningRequests)}</dd></div>
        <div><dt>Blocked sessions</dt><dd>{metric(database.liveActivity.blockedSessions)}</dd></div>
        <div><dt>Batch requests/sec</dt><dd>{metric(database.liveActivity.batchRequestsPerSecond)}</dd></div>
        <div><dt>Query executions</dt><dd>{formatDecimalCount(database.queryStore.executionCount)}</dd></div>
        <div><dt>Aborted executions</dt><dd>{formatDecimalCount(database.queryStore.abortedExecutionCount ?? null)}</dd></div>
        <div><dt>Exception executions</dt><dd>{formatDecimalCount(database.queryStore.exceptionExecutionCount ?? null)}</dd></div>
        <div><dt>Logical reads (8-KiB pages)</dt><dd>{formatDecimalCount(database.queryStore.logicalReads8KiBPages)}</dd></div>
        <div><dt>Average duration</dt><dd>{metric(database.queryStore.averageDurationMicroseconds, ' µs')}</dd></div>
        <div><dt>Total duration</dt><dd>{formatDecimalCount(database.queryStore.totalDurationMicroseconds ?? null)} µs</dd></div>
        <div><dt>Total CPU</dt><dd>{formatDecimalCount(database.queryStore.totalCpuMicroseconds ?? null)} µs</dd></div>
        <div><dt>Query Store state</dt><dd>{database.queryStore.desiredState ?? 'Unavailable'} → {database.queryStore.health}</dd></div>
        <div><dt>Capture mode</dt><dd>{database.queryStore.captureMode ?? 'Unavailable'}</dd></div>
        {database.queryStore.currentStorageBytes && <div><dt>Query Store storage</dt><dd>
          {formatBytes({ bytes: database.queryStore.currentStorageBytes, status: 'Known', reason: null, evidence: database.queryStore.evidence })}
        </dd></div>}
        <div><dt>Query Store window</dt><dd>{database.queryStore.windowStart && database.queryStore.windowEnd
          ? `${new Date(database.queryStore.windowStart).toLocaleString()} – ${new Date(database.queryStore.windowEnd).toLocaleString()}`
          : 'Unavailable'}</dd></div>
        <div><dt>I/O read rate</dt><dd>{formatDecimalCount(database.fileIo?.readBytesPerSecond ?? null)} bytes/s</dd></div>
        <div><dt>I/O write rate</dt><dd>{formatDecimalCount(database.fileIo?.writeBytesPerSecond ?? null)} bytes/s</dd></div>
      </dl>
      <div className="source-note"><strong>Live source</strong><p>{evidenceText(database.liveActivity.evidence)}</p></div>
      <div className="source-note"><strong>Historical source</strong><p>{evidenceText(database.queryStore.evidence)}</p></div>
    </aside>
  )
}

function nameFor(snapshot: AtlasSnapshot, id: string): string {
  return snapshot.databases.find(database => database.databaseId === id)?.name ?? id
}

function ShellFallback({ label }: { label: string }) {
  return (
    <div className="map-shell">
      <div className="map-sidebar" />
      <div className="map-stage">
        <section className="stage-message loading" aria-live="polite">
          <span className="loading-mark" aria-hidden="true" /> {label}
        </section>
      </div>
    </div>
  )
}

function LazySurface({ label, fallback, children }: { label: string; fallback: ReactNode; children: ReactNode }) {
  return (
    <ChunkErrorBoundary label={label}>
      <Suspense fallback={fallback}>{children}</Suspense>
    </ChunkErrorBoundary>
  )
}
