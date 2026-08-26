// Mirrors src/SqlSimCity.Contracts/LiveIncidentContractsV1.cs exactly, property-for-property.
// Every bigint count/byte crosses the wire as a base-10 string (never a narrowed JS number), so
// this file has no numeric fields for anything the C# side declares as `string` bigint text.

export type SampleAvailability = 'Available' | 'Disappeared' | 'Unavailable' | 'Stale'

/// The four documented negative blocking_session_id sentinels; -5 is common/benign and is never
/// itself reported as a blocking "problem".
export type BlockingSentinelKind =
  | 'None'
  | 'OrphanedDistributedTransaction' // -2
  | 'DeferredRecoveryTransaction' // -3
  | 'IndeterminateLatchOwner' // -4
  | 'UntrackedLatchOwner' // -5

export type BlockingNodeKind = 'Session' | 'Sentinel'
export type ExecutionContextKind = 'Coordinator' | 'Worker'
export type PlanCollectionState = 'NotRequested' | 'Available' | 'Unavailable'
export type CounterEpochState = 'FirstSample' | 'Delta' | 'EpochReset'
export type SamplerRunState = 'Running' | 'Paused' | 'Stopped' | 'Reconnecting'
export type DataStatus = 'Available' | 'Stale' | 'Disconnected' | 'PermissionDenied' | 'Disabled' | 'Unsupported' | 'Unknown'

export interface BlockingReference {
  blockingSessionId: number | null
  sentinel: BlockingSentinelKind
}

/// Every documented `wait_resource` form. `Page` and `Rid` name a page, not an object; resolving
/// them needs `sys.dm_db_page_info` or an allocation scan, which is too costly for a realtime
/// probe, so they are reported unresolved with a reason rather than guessed.
export type LockResourceKind =
  | 'None'
  | 'Key'
  | 'Object'
  | 'Page'
  | 'Rid'
  | 'HoBt'
  | 'Table'
  | 'Extent'
  | 'File'
  | 'Application'
  | 'Metadata'
  | 'Database'
  | 'AllocationUnit'
  /**
   * `XACT` — a lock on a transaction id rather than on any object. Optimized locking (SQL Server
   * 2025, Azure SQL Database, Managed Instance, Fabric SQL) has a writer hold one lock on its own
   * transaction instead of holding every row and key lock until commit, so waiters queue on that
   * transaction. Understood in full, and names no object by design.
   */
  | 'Transaction'
  | 'Unrecognized'

export type LockResolutionStatus =
  | 'Resolved'
  | 'RequiresLookup'
  | 'NotObjectScoped'
  | 'Unresolvable'
  | 'Unrecognized'

/// Optional throughout: emitted only once the lock-resource probe has run, so the UI must treat
/// its absence as "not claimed" rather than "no lock".
export interface LockResource {
  rawResource: string
  kind: LockResourceKind
  databaseId: number | null
  objectId: number | null
  indexId: number | null
  schemaName: string | null
  objectName: string | null
  indexName: string | null
  status: LockResolutionStatus
  reason: string
}

export interface LiveRequest {
  requestId: string
  sessionId: number
  loginName: string | null
  hostName: string | null
  programName: string | null
  sessionStatus: string | null
  /**
   * `sys.dm_exec_requests.status`, or null when the row is an idle session holding no request.
   * Sampling includes idle sessions on purpose, so null here means "no request" rather than "a
   * request in some unreported state" — do not count these rows as running requests (issue #79).
   */
  requestStatus: string | null
  command: string | null
  waitType: string | null
  waitTimeMs: number | null
  waitResource: string | null
  lockResource?: LockResource | null
  blocking: BlockingReference
  requestStartTime: string | null
  totalElapsedMs: number | null
  cpuTimeMs: number | null
  reads: string | null
  writes: string | null
  logicalReads8KiBPages: string | null
  openTransactionCount: number | null
  databaseId: string | null
  databaseName: string | null
  currentStatementText: string | null
  batchText: string | null
  availability: SampleAvailability
  availabilityReason: string | null
  planState: PlanCollectionState
  planReason: string | null
}

export interface WaitingTask {
  taskId: string
  sessionId: number
  executionContext: ExecutionContextKind
  execContextId: number
  waitType: string | null
  waitDurationMs: string
  resourceDescription: string | null
  lockResource?: LockResource | null
  blocking: BlockingReference
}

export interface BlockingNode {
  nodeId: string
  kind: BlockingNodeKind
  sessionId: number | null
  sentinel: BlockingSentinelKind
  isRoot: boolean
  isIdleWithOpenTransaction: boolean
  inCycle: boolean
  directlyBlockedCount: number
}

export interface BlockingEdge {
  edgeId: string
  fromNodeId: string
  toNodeId: string
  waitType: string | null
  waitDurationMs: string | null
  executionContext: ExecutionContextKind | null
  execContextId: number | null
}

export interface BlockingGraphSummary {
  blockedSessionCount: number
  rootBlockerCount: number
  sentinelRootCount: number
  cycleCount: number
  parallelWaitTaskCount: number
  note: string
}

export interface BlockingGraph {
  nodes: BlockingNode[]
  edges: BlockingEdge[]
  rootNodeIds: string[]
  cycles: string[][]
  summary: BlockingGraphSummary
}

export interface MemoryGrant {
  sessionId: number
  requestId: number | null
  schedulerId: number | null
  dop: number | null
  requestTime: string | null
  grantTime: string | null
  isWaitingForGrant: boolean
  requestedKb: string | null
  grantedKb: string | null
  requiredKb: string | null
  usedKb: string | null
  maxUsedKb: string | null
  idealKb: string | null
  queryCost: number | null
  timeoutSec: number | null
  waitTimeMs: string | null
  batchText: string | null
}

export interface TempdbFileUsage {
  fileId: number
  totalMb: number
  allocatedMb: number
  freeMb: number
  versionStoreMb: number
  userObjectsMb: number
  internalObjectsMb: number
  mixedExtentMb: number
}

export interface TempdbSessionUsage {
  sessionId: number
  userObjectsAllocPageCount: string
  userObjectsDeallocPageCount: string
  internalObjectsAllocPageCount: string
  internalObjectsDeallocPageCount: string
}

export interface TempdbTaskUsage {
  sessionId: number
  requestId: number | null
  execContextId: number
  userObjectsAllocPageCount: string
  userObjectsDeallocPageCount: string
  internalObjectsAllocPageCount: string
  internalObjectsDeallocPageCount: string
}

export interface TempdbUsage {
  files: TempdbFileUsage[]
  sessions: TempdbSessionUsage[]
  tasks: TempdbTaskUsage[]
  status: DataStatus
  reason: string
}

export interface CounterDelta {
  state: CounterEpochState
  deltaValue: string | null
  ratePerSecond: number | null
  reason: string
}

export interface FileIoDelta {
  databaseId: number
  databaseName: string | null
  fileId: number
  typeDesc: string | null
  epochId: number
  sampleWindowMs: number | null
  readsDelta: CounterDelta
  bytesReadDelta: CounterDelta
  ioStallReadMsDelta: CounterDelta
  writesDelta: CounterDelta
  bytesWrittenDelta: CounterDelta
  ioStallWriteMsDelta: CounterDelta
}

export interface FileIoSample {
  files: FileIoDelta[]
  status: DataStatus
  reason: string
}

export interface SchedulerSample {
  schedulerId: number
  cpuId: number
  status: string | null
  isOnline: boolean
  isIdle: boolean
  currentTasksCount: number
  runnableTasksCount: number
  currentWorkersCount: number
  activeWorkersCount: number
  workQueueCount: number
  pendingDiskIoCount: number
  loadFactor: number
  epochId: number
  sampleWindowMs: number | null
  cpuUsageMsDelta: CounterDelta
  schedulerDelayMsDelta: CounterDelta
  idealWorkersLimit: number | null
}

export interface SchedulerPressure {
  schedulers: SchedulerSample[]
  status: DataStatus
  reason: string
}

export interface LogSpaceUsage {
  totalLogSizeMb: number | null
  usedLogSpaceMb: number | null
  usedLogSpacePercent: number | null
  status: DataStatus
  reason: string
}

export interface UnavailableField {
  field: string
  status: DataStatus
  reason: string
}

export interface CollectionDiagnostics {
  sequence: number
  collectedAt: string
  sourceTimestamp: string | null
  durationMs: number
  missedCycles: number
  skippedCycles: number
  unavailableFields: UnavailableField[]
}

export interface LiveIncidentTarget {
  targetId: string
  displayName: string
  platform: string
  visibilityScope: string
  unavailableServerWideEvidenceReason: string | null
}

export interface LiveIncidentSnapshot {
  schemaVersion: string
  target: LiveIncidentTarget
  sourceTimestamp: string | null
  collectedAt: string
  freshUntil: string | null
  status: DataStatus
  reason: string
  requests: LiveRequest[]
  waitingTasks: WaitingTask[]
  blockingGraph: BlockingGraph
  memoryGrants: MemoryGrant[]
  tempdb: TempdbUsage
  fileIo: FileIoSample
  scheduler: SchedulerPressure
  logSpace: LogSpaceUsage
  diagnostics: CollectionDiagnostics
}

export interface LiveCollectorStatus {
  state: SamplerRunState
  sequence: number
  lastSuccessAt: string | null
  lastAttemptAt: string | null
  consecutiveFailures: number
  nextAttemptInMs: number | null
  lastErrorReason: string | null
  missedCycles: number
  skippedCycles: number
}

export interface LiveIncidentResponse {
  snapshot: LiveIncidentSnapshot | null
  collector: LiveCollectorStatus
}
