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

type Props = {
  objects: readonly DatabaseCityObject[]
  roads: readonly RoadTraffic[]
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
const LAYER_LABELS: ReadonlyArray<readonly [keyof CityLayerToggles, string]> = [
  ['traffic', 'Traffic'],
  ['waitLanes', 'Wait lanes'],
  ['infrastructure', 'Infrastructure'],
  ['route', 'Query route'],
  ['labels', 'Labels'],
  ['districts', 'Schema neighborhoods'],
]

function swatch(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

export function DatabaseCityViewport({
  objects,
  roads,
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
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<DatabaseCitySceneController | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [heading, setHeading] = useState(0)
  const [hoveredRoadId, setHoveredRoadId] = useState<string | null>(null)
  const [layers, setLayers] = useState<CityLayerToggles>({
    traffic: true,
    waitLanes: true,
    infrastructure: true,
    route: true,
    // Schema neighborhood tints are off until asked for: the building labels now carry the schema
    // name, so the tint adds colour without adding a fact.
    districts: false,
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

  useEffect(() => sceneRef.current?.setObjects(objects), [objects])
  useEffect(() => sceneRef.current?.setRoads(roads), [roads])
  useEffect(() => sceneRef.current?.setFacilities(facilities), [facilities])
  useEffect(
    () => sceneRef.current?.setFacilityLanes(facilityTraffic.lanes),
    [facilityTraffic])
  useEffect(() => sceneRef.current?.setRoute(route), [route])
  useEffect(() => sceneRef.current?.setSelected(selectedId), [selectedId])
  useEffect(() => sceneRef.current?.setSelectedRoad(selectedRoadId), [selectedRoadId])
  useEffect(() => sceneRef.current?.setLayers(layers), [layers])

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

  // Only facilities that actually received a lane are given a legend swatch, so the legend never
  // advertises a colour for traffic that was not measured.
  const laneFacilities: FacilityKind[] = [
    ...new Set(facilityTraffic.lanes.map(lane => lane.facility)),
  ].sort()

  const hoverLabel = hoveredRoadId === null ? null : roadLabels.get(hoveredRoadId) ?? null

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

      {finder && <div className="hud hud-top-left">{finder}</div>}

      <div className="hud hud-top-right">
        <fieldset className="hud-layers">
          <legend>Layers</legend>
          {LAYER_LABELS.map(([key, label]) => (
            <label key={key}>
              <input type="checkbox" checked={layers[key]} onChange={() => toggle(key)} />
              {label}
            </label>
          ))}
        </fieldset>
        {liveStatus}
      </div>

      <div className="hud hud-bottom-left">
        <details className="hud-legend">
          <summary>Legend · what encodes evidence</summary>
          <ul className="legend-encoded">
            <li>
              <i className="legend-swatch legend-footprint" /> Footprint — log₂ of exact reserved 8-KiB pages
            </li>
            <li>
              <i className="legend-swatch legend-height" /> Height — log₂ of exact used 8-KiB pages
            </li>
            <li>
              <i className="legend-swatch legend-attributed" /> Amber roof cap — attributed Query Store CPU
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
            Store wait-category evidence naming only that object. {facilityTraffic.note}
            {facilityTraffic.unmapped.length > 0 &&
              ` ${facilityTraffic.unmapped.length} captured wait category/categories have no facility` +
              ' on this map and are listed in the evidence tables rather than folded into one.'}
          </p>
          <p className="legend-decoration">
            Roofs, windows, doors, chimneys, setbacks, crowns, sidewalks, and district tints are
            decoration. They are seeded from each object&apos;s stable id and encode nothing.
          </p>
        </details>
      </div>

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
