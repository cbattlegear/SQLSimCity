import * as THREE from 'three'
import { createDatabaseCityScene } from '../../../web/src/DatabaseCityScene'
import { planCity } from '../../../web/src/cityPlan'
import type { DatabaseCityObject, DatabaseCityQueryFamily } from '../../../web/src/databaseCityContracts'
import type { LiveQueryEvent } from '../../../web/src/liveQueryFeed'
import type { Evidence } from '../../../web/src/contracts'

// An explicit controller fixture, not fabricated connected evidence. The separate connected smoke
// exercises the real API. This fixture deterministically overlaps every animation and drains it.
const evidence: Evidence = {
  source: 'CatalogSnapshot', status: 'Available', observedAt: null, freshUntil: null, reason: 'Browser controller fixture',
}
const objects: DatabaseCityObject[] = Array.from({ length: 12 }, (_, i) => ({
  objectId: `object:${i}`, schemaId: 'dbo', schemaName: 'dbo', name: `Table${i}`, kind: 'Table',
  reservedPages8KiB: '4096', usedPages8KiB: '2048', reservedBytes: '33554432', usedBytes: '16777216',
  sizeStatus: 'Known', sizeReason: null,
  layout: { neighborhoodOrdinal: 0, objectOrdinal: i, x: 0, z: 0 }, indexes: [],
  directActivity: { totalOperations: '100', resetEpochToken: null, evidence },
  attributedExposure: {
    executionCount: '10', totalCpuMicroseconds: '100', totalDurationMicroseconds: '1000',
    totalLogicalReads8KiBPages: '20', confidence: 'Confirmed', rationale: 'Browser fixture', evidence,
  },
}))
const family: DatabaseCityQueryFamily = {
  familyId: 'family:1', queryHash: 'AABBCCDDEEFF0011', executionCount: '10',
  totalCpuMicroseconds: '100', totalDurationMicroseconds: '1000', totalLogicalReads8KiBPages: '20',
  totalWaitMilliseconds: '1', waitMillisecondsByCategory: { CPU: '1' }, objectIds: ['object:0', 'object:1'],
  confidence: 'Confirmed', rationale: 'Browser fixture', evidence,
  planDataVolume: { estimatedBytesPerExecution: '1048576', byObject: [], plansRead: 1, rationale: 'Browser fixture' },
}
const now = Date.now()
const events: LiveQueryEvent[] = [{
  id: 'fixture:51', source: 'sampled-request', executions: 1, executionsEstimated: false, ordinal: 1,
  sessionId: 51, requestId: 'fixture:51', startedAt: new Date(now).toISOString(), firstSeenAt: now,
  lastSeenAt: now, endedAt: null, databaseName: 'Fixture', command: 'SELECT', text: null,
  textReason: 'Controller fixture', queryHash: family.queryHash, familyId: family.familyId,
  hashReported: true, blocked: false, waitType: null, elapsedMs: 100, cpuMs: null,
}]

const host = window as typeof window & {
  __measure: { renderTotal: number; currentFrame: { renders: number } | null }
  __sceneFixture: object
}
// Scene.onBeforeRender runs once per full-scene submission, including submissions with shadows.
// It is installed only on this fixture's prototype; no shipped renderer instrumentation is needed.
const original = THREE.Scene.prototype.onBeforeRender
THREE.Scene.prototype.onBeforeRender = function (...args) {
  host.__measure.renderTotal += 1
  if (host.__measure.currentFrame) host.__measure.currentFrame.renders += 1
  original.apply(this, args)
}
const canvas = document.querySelector('canvas')!
let moving = 0
let tour = false
const controller = createDatabaseCityScene(canvas, {
  onSelect() {},
  onVehicleRoster(roster) { moving = roster.vehicles.filter(vehicle => vehicle.blockedAt === null).length },
  onTour(update) { tour = update.active },
})
controller.setObjects(objects, planCity(objects, {
  seed: 'frame-fixture', totalObjects: '12',
  schemas: [{ schemaId: 'dbo', name: 'dbo', neighborhoodOrdinal: 0, objectCount: '12', evidence }],
}))
controller.setRoads([{
  routeId: 'route:1', fromObjectId: 'object:0', toId: 'object:1', kind: 'ObjectReference',
  confidence: 'Confirmed', pattern: 'solid', width: 5.2, grade: 'free', color: 0x39c46b,
  executions: 10, waitShare: 0.1, delayPerExecution: 0.1, familyIds: [family.familyId], rationale: 'Fixture',
}])
host.__sceneFixture = {
  start() {
    controller.setVehicles(events, [family])
    controller.setFireObjects(['object:0'])
    controller.setWaterMainBreaks(['object:1'])
    // Start during the residual orbit damping from the preceding trusted drag.
    controller.setTour(true, 'Controller fixture')
  },
  stop() {
    controller.setVehicles([], [family])
    controller.setFireObjects([])
    controller.setWaterMainBreaks([])
    controller.setTour(false, 'Controller fixture')
  },
  invalidate() { controller.setSelected('object:2') },
  mode(mode: 'city' | 'map') { controller.setViewMode(mode) },
  state() { return { moving, tour, heading: controller.heading() } },
  dispose() { controller.dispose() },
}
