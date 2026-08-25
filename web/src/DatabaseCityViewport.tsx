import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { DatabaseCityObject } from './databaseCityContracts'
import {
  createDatabaseCityScene,
  type CameraNudge,
  type CityLayerToggles,
  type DatabaseCitySceneController,
} from './DatabaseCityScene'
import { CONGESTION_COLORS, CONGESTION_LABELS, type RoadTraffic } from './cityTraffic'
import { LANE_COLORS, type FacilityTraffic } from './cityFacilityTraffic'
import { FACILITY_LABELS, type Facility, type FacilityKind } from './cityInfrastructure'
import type { CityRoute } from './cityRoute'
import type { WorkloadTraffic } from './cityWorkloadTraffic'
import type { CityPlan } from './cityPlan'
import type { MapViewMode } from './mapStyle'
import {
  incidentDemandsAttention,
  incidentSummaryLabel,
  incidentSummaryTone,
  type IncidentProjection,
} from './cityIncidents'
import type { LiveFeedConnectionState } from './liveIncidents'
import { IncidentPopup, IncidentSummary } from './IncidentPopup'
import { MapTray, useNarrowViewport, type TrayItem } from './MapTray'

type Props = {
  objects: readonly DatabaseCityObject[]
  /**
   * The plan the view has already computed. Passed in rather than recomputed so the scene, the
   * address book, the route, and the traffic map all read one layout produced once.
   */
  cityPlan: CityPlan
  /** Flat basemap or oblique 3D city. Both draw the same plan and the same measurements. */
  viewMode: MapViewMode
  roads: readonly RoadTraffic[]
  /** Aggregate street load built from the workload's executions and apportioned waits. */
  traffic: WorkloadTraffic
  facilities: readonly Facility[]
  facilityTraffic: FacilityTraffic
  route: CityRoute | null
  selectedId: string | null
  selectedRoadId: string | null
  onSelect: (objectId: string) => void
  onSelectRoad: (routeId: string | null) => void
  /** One-line description per road id, shown when a road is hovered. */
  roadLabels: ReadonlyMap<string, string>
  /** Rendered into the top-left HUD slot: the object and plan finder. */
  finder?: ReactNode
  /** Rendered into the right HUD slot: object detail or turn-by-turn directions. */
  panel?: ReactNode
  liveStatus?: ReactNode
  /**
   * The live feed's own connection state, so the folded tray chip can say it.
   *
   * `liveStatus` is an opaque node, and a chip that reads "Feed" whether the feed is connected or
   * dead would hide the qualifier on every live number the map draws. This is the one fact the chip
   * needs in order not to do that.
   */
  feedState?: LiveFeedConnectionState
  /** Live blocking pins projected from the snapshot. Drawn in both view modes. */
  incidents?: IncidentProjection
}

const KEY_ACTIONS: Record<string, CameraNudge> = {
  ArrowLeft: 'panLeft',
  ArrowRight: 'panRight',
  ArrowUp: 'panUp',
  ArrowDown: 'panDown',
  '+': 'zoomIn',
  '=': 'zoomIn',
  '-': 'zoomOut',
  _: 'zoomOut',
  '[': 'rotateLeft',
  ']': 'rotateRight',
}

const COMPASS_POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

/**
 * The folded incident chip. Its wording lives in {@link incidentSummaryLabel} beside the projection
 * it describes, because on a phone this chip may be the whole blocking probe a reader sees, and what
 * it is allowed to claim is a property of the evidence rather than of the layout.
 */
/**
 * The layer checkboxes, with the hint each one carries on hover. Only layers whose behaviour is not
 * fully described by their own name need one.
 */
const LAYER_LABELS: ReadonlyArray<readonly [keyof CityLayerToggles, string, string?]> = [
  ['traffic', 'Traffic'],
  ['paths', 'Query paths'],
  ['waitLanes', 'Wait lanes'],
  ['infrastructure', 'Infrastructure'],
  ['route', 'Query route'],
  [
    'labels',
    'Labels',
    'Neighbourhood names are grown as you zoom out so they stay readable; where two would be written over each other, the smaller neighbourhood’s name is dropped. Building and facility names appear as you zoom in — largest tables first — rather than being drawn too small to read.',
  ],
]

function swatch(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

export function DatabaseCityViewport({
  objects,
  cityPlan,
  viewMode,
  roads,
  traffic,
  facilities,
  facilityTraffic,
  route,
  selectedId,
  selectedRoadId,
  onSelect,
  onSelectRoad,
  roadLabels,
  finder,
  panel,
  liveStatus,
  feedState,
  incidents,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<DatabaseCitySceneController | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [heading, setHeading] = useState(0)
  const [hoveredRoadId, setHoveredRoadId] = useState<string | null>(null)
  const [openIncidentId, setOpenIncidentId] = useState<string | null>(null)
  const [popupAt, setPopupAt] = useState<{ x: number; y: number } | null>(null)
  const [layers, setLayers] = useState<CityLayerToggles>({
    traffic: true,
    paths: false,
    waitLanes: true,
    infrastructure: true,
    route: true,
    labels: true,
  })

  useEffect(() => {
    if (!canvasRef.current) return
    let controller: DatabaseCitySceneController
    try {
      controller = createDatabaseCityScene(canvasRef.current, {
        onSelect,
        onSelectRoad,
        onHoverRoad: setHoveredRoadId,
        onSelectIncident: setOpenIncidentId,
        onCameraChange: () => setHeading(sceneRef.current?.heading() ?? 0),
      })
    } catch {
      setUnavailable(true)
      return
    }
    sceneRef.current = controller
    return () => {
      controller.dispose()
      sceneRef.current = null
    }
  }, [onSelect, onSelectRoad])

  useEffect(() => sceneRef.current?.setObjects(objects, cityPlan), [objects, cityPlan])
  useEffect(() => sceneRef.current?.setRoads(roads), [roads])
  useEffect(() => sceneRef.current?.setTraffic(traffic), [traffic])
  useEffect(() => sceneRef.current?.setFacilities(facilities), [facilities])
  useEffect(
    () => sceneRef.current?.setFacilityLanes(facilityTraffic.lanes, facilityTraffic.sharedLanes),
    [facilityTraffic])
  useEffect(() => sceneRef.current?.setRoute(route), [route])
  useEffect(() => sceneRef.current?.setSelected(selectedId), [selectedId])
  useEffect(() => sceneRef.current?.setSelectedRoad(selectedRoadId), [selectedRoadId])
  useEffect(() => sceneRef.current?.setLayers(layers), [layers])
  useEffect(() => sceneRef.current?.setViewMode(viewMode), [viewMode])
  useEffect(() => sceneRef.current?.setIncidents(incidents?.markers ?? []), [incidents])

  /**
   * The popup is HTML over a canvas, so it has to follow the pin as the camera moves. Projecting on
   * an animation frame is what keeps it glued; the loop only runs while a popup is actually open.
   */
  useEffect(() => {
    if (!openIncidentId) {
      setPopupAt(null)
      return
    }
    let handle = 0
    const track = () => {
      const next = sceneRef.current?.incidentScreenPosition(openIncidentId) ?? null
      setPopupAt(current =>
        current && next && Math.abs(current.x - next.x) < 0.5 && Math.abs(current.y - next.y) < 0.5
          ? current
          : next)
      handle = requestAnimationFrame(track)
    }
    handle = requestAnimationFrame(track)
    return () => cancelAnimationFrame(handle)
  }, [openIncidentId])

  // A marker that disappears from the snapshot must take its popup with it.
  useEffect(() => {
    if (openIncidentId && !incidents?.markers.some(marker => marker.id === openIncidentId)) {
      setOpenIncidentId(null)
    }
  }, [incidents, openIncidentId])

  /**
   * Opening an incident from the summary list, rather than by clicking its pin.
   *
   * The popup is anchored by projecting the marker to screen, and a marker behind the camera or
   * outside the frustum projects to nothing — so a list entry that only set the id would open a
   * popup the user never sees. Centring the building first is what makes the keyboard route real.
   */
  const openIncidentFromList = useCallback((markerId: string) => {
    const marker = incidents?.markers.find(entry => entry.id === markerId) ?? null
    if (marker) sceneRef.current?.focusObject(marker.objectId)
    setOpenIncidentId(markerId)
  }, [incidents])

  const nudge = useCallback((action: CameraNudge) => {
    sceneRef.current?.nudge(action)
    setHeading(sceneRef.current?.heading() ?? 0)
  }, [])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLCanvasElement>) => {
      if (event.key === 'Home') {
        event.preventDefault()
        sceneRef.current?.resetView()
        setHeading(sceneRef.current?.heading() ?? 0)
        return
      }
      const action = KEY_ACTIONS[event.key]
      if (!action) return
      event.preventDefault()
      nudge(action)
    },
    [nudge],
  )

  const toggle = (key: keyof CityLayerToggles) =>
    setLayers(current => ({ ...current, [key]: !current[key] }))

  const narrow = useNarrowViewport()

  // Only facilities that actually received a lane are given a legend swatch, so the legend never
  // advertises a colour for traffic that was not measured.
  const laneFacilities: FacilityKind[] = [
    ...new Set([
      ...facilityTraffic.lanes.map(lane => lane.facility),
      ...facilityTraffic.sharedLanes.map(lane => lane.facility),
    ]),
  ].sort()

  const hoverLabel = hoveredRoadId === null ? null : roadLabels.get(hoveredRoadId) ?? null
  const openIncident = incidents?.markers.find(marker => marker.id === openIncidentId) ?? null

  /*
   * One legend, two homes. Wide, it lives bottom-left where a map legend belongs, folded behind its
   * own summary. Narrow, there is no bottom-left worth the name, so it moves into the tray -- and
   * the tray chip is already the disclosure, so the legend opens with it rather than asking for a
   * second tap. It used to be `display: none` under 900px, which meant the phone drawing disclosed
   * nothing about what its own colours and widths meant.
   */
  const legend = (
    <details className="hud-legend" open={narrow || undefined}>
      <summary>Legend · what encodes evidence</summary>
      <ul className="legend-encoded">
        <li>
          <i className="legend-swatch legend-footprint" /> Footprint — log₂ of exact reserved 8-KiB pages
        </li>
        <li>
          <i className="legend-swatch legend-height" /> Height — log₂ of exact used 8-KiB pages
        </li>
        <li>
          <i className="legend-swatch legend-attributed" /> Solid amber roof cap — Query Store CPU measured for this object alone
        </li>
        <li>
          <i className="legend-swatch legend-shared" /> Outlined amber cap — CPU of queries that also named other tables; not additive across buildings
        </li>
        <li>
          <i className="legend-swatch legend-direct" /> Index annex width — direct DMV operations
        </li>
        <li>
          <i className="legend-swatch legend-route" /> Road width — captured executions naming both endpoints
        </li>
        {(['low', 'medium', 'high', 'unknown'] as const).map(grade => (
          <li key={grade}>
            <i className="legend-swatch" style={{ background: swatch(CONGESTION_COLORS[grade]) }} />
            Road colour — {CONGESTION_LABELS[grade].toLowerCase()}
          </li>
        ))}
        <li>
          <i className="legend-swatch legend-solid" /> Unbroken road — confirmed reference
        </li>
        <li>
          <i className="legend-swatch legend-dashed" /> Long dashes — probable reference
        </li>
        <li>
          <i className="legend-swatch legend-sparse" /> Short dashes — inferred reference
        </li>
        <li>
          <i className="legend-swatch legend-lane" /> Wait lane width — captured Query Store wait
          milliseconds from that building to that facility
        </li>
        {laneFacilities.map(kind => (
          <li key={kind}>
            <i className="legend-swatch" style={{ background: swatch(LANE_COLORS[kind]) }} />
            Wait lane colour — queued at the {FACILITY_LABELS[kind]}
          </li>
        ))}
        <li>
          <i className="legend-swatch legend-unknown">×</i> Wireframe — unavailable evidence, no quantity claimed
        </li>
      </ul>
      <p className="legend-caveat">
        A building with no wait lane is not idle: it means no ranked query family carried Query
        Store wait-category evidence naming it. A lane that threads through several buildings
        before reaching a facility is a shared lane: it carries one multi-object family&apos;s whole
        wait total, drawn once along the objects it names, and belongs to none of them
        individually. {facilityTraffic.note}
        {facilityTraffic.unmapped.length > 0 &&
          ` ${facilityTraffic.unmapped.length} captured wait category/categories have no facility` +
          ' on this map and are listed in the evidence tables rather than folded into one.'}
      </p>
      <p className="legend-decoration">
        Roofs, windows, doors, chimneys, setbacks, crowns, and sidewalks are decoration. They are
        seeded from each object&apos;s stable id and encode nothing. A neighbourhood&apos;s hue
        says which schema owns it and nothing more: hues are handed out in catalogue order, so
        one is never warmer, larger or busier than another.
      </p>
    </details>
  )

  const trayItems: TrayItem[] = [
    // Search leads on a phone: it is the fastest way to reach an object when the map is small.
    ...(narrow && finder ? [{ id: 'find', label: 'Find', glyph: '⌕', content: finder }] : []),
    {
      id: 'layers',
      label: 'Layers',
      glyph: '≣',
      content: (
        <fieldset className="hud-layers">
          <legend>Layers</legend>
          {LAYER_LABELS.map(([key, label, hint]) => (
            <label key={key} title={hint}>
              <input type="checkbox" checked={layers[key]} onChange={() => toggle(key)} />
              {label}
            </label>
          ))}
        </fieldset>
      ),
    },
    ...(incidents
      ? [{
        id: 'incidents',
        // The chip states the finding itself, so even folded the tray cannot read as "all clear".
        label: incidentSummaryLabel(incidents),
        glyph: '⚑',
        tone: incidentSummaryTone(incidents),
        // A blocked waiter opens itself, whether or not the map could pin it, and so does a probe
        // that never reported. Those are warnings, and a warning behind a tap is a warning that was
        // not given.
        alert: incidentDemandsAttention(incidents),
        content: (
          <IncidentSummary
            projection={incidents}
            openId={openIncidentId}
            onOpen={openIncidentFromList}
          />
        ),
      }]
      : []),
    ...(liveStatus
      ? [{
        id: 'live',
        // A degraded feed is a qualifier on every live number the map draws, so the chip states the
        // connection rather than just naming the panel, and a feed that is not connected opens
        // itself the way a blocked waiter does. Ordered after incidents so that when both are
        // saying something, the one that opens itself is the blocking probe.
        label: feedState ? `Feed · ${feedState}` : 'Feed',
        glyph: '◉',
        tone: feedState && feedState !== 'connected' ? 'is-unknown' : '',
        alert: feedState !== undefined && feedState !== 'connected',
        content: liveStatus,
      }]
      : []),
    // Only narrow: wide viewports keep the legend bottom-left where a map legend belongs.
    ...(narrow ? [{ id: 'legend', label: 'Legend', glyph: '☰', content: legend }] : []),
  ]

  if (unavailable) {
    return (
      <div className="city-viewport is-unavailable">
        <div className="viewport-fallback" role="status">
          <strong>Database city viewport unavailable</strong>
          <span>
            WebGL could not start. The complete object, route, and evidence tables remain available
            below and carry exactly the same facts as the map.
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="city-viewport">
      <canvas
        ref={canvasRef}
        className="city-canvas"
        tabIndex={0}
        role="application"
        aria-label="Database city map. Drag to orbit, right-drag to pan, scroll to zoom."
        aria-describedby="city-map-help"
        onKeyDown={onKeyDown}
      />
      <p id="city-map-help" className="visually-hidden">
        Interactive three-dimensional map. Arrow keys pan, plus and minus zoom, left and right square
        brackets rotate, Home resets the view. Every fact drawn here is also listed in the evidence
        tables below this map.
      </p>

      {!narrow && finder && <div className="hud hud-top-left">{finder}</div>}

      <div className="hud hud-top-right">
        <MapTray label="Map overlays" items={trayItems} />
      </div>

      {openIncident && popupAt && (
        <IncidentPopup
          marker={openIncident}
          x={popupAt.x}
          y={popupAt.y}
          onClose={() => setOpenIncidentId(null)}
        />
      )}

      {!narrow && <div className="hud hud-bottom-left">{legend}</div>}

      <div className="hud hud-bottom-right">
        <div className="hud-compass">
          <span className="compass-needle" style={{ transform: `rotate(${-heading}deg)` }} aria-hidden="true">
            ▲
          </span>
          <span>
            {COMPASS_POINTS[Math.round(heading / 45) % 8]} · {Math.round(heading)}°
          </span>
        </div>
        <div className="hud-camera" role="group" aria-label="Camera controls">
          <button type="button" onClick={() => nudge('rotateLeft')} aria-label="Rotate left">⟲</button>
          <button type="button" onClick={() => nudge('zoomIn')} aria-label="Zoom in">＋</button>
          <button type="button" onClick={() => nudge('zoomOut')} aria-label="Zoom out">－</button>
          <button type="button" onClick={() => nudge('rotateRight')} aria-label="Rotate right">⟳</button>
          <button type="button" onClick={() => sceneRef.current?.resetView()}>Reset view</button>
          {route && <button type="button" onClick={() => sceneRef.current?.frameRoute()}>Frame route</button>}
          {selectedRoadId && (
            <button type="button" onClick={() => sceneRef.current?.frameRoad(selectedRoadId)}>Frame road</button>
          )}
        </div>
      </div>

      {hoverLabel && (
        <div className="hud hud-road-readout" aria-hidden="true">
          <strong>Road</strong>
          <span>{hoverLabel}</span>
        </div>
      )}
      <p className="visually-hidden" role="status">
        {hoverLabel ? `Road under pointer: ${hoverLabel}` : ''}
      </p>

      {panel && <div className="hud hud-panel">{panel}</div>}
    </div>
  )
}
