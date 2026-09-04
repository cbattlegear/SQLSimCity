import type { Evidence } from './contracts'
import type { DatabaseCityPage } from './databaseCityContracts'
import { mergeCityPage } from './cityPaging'
import { CITY_REFRESH_INTERVAL_MS } from './cityRefresh'

export type CitySourceMode = 'live' | 'archive' | 'edge'
export type CityLoadPhase = 'idle' | 'initial' | 'backfill' | 'layout' | 'refresh' | 'continuation'
export interface CityEvidenceState {
  page: DatabaseCityPage | null
  phase: CityLoadPhase
  loadedCount: number
  error: string | null
  lastSuccessAt: string | null
  now: number
}

export const AUTO_PAGE_LIMIT = 80
type FetchCity = (databaseId: string, metric: string, token: string | null, signal: AbortSignal) => Promise<DatabaseCityPage>

export function evidenceStatus(evidence: Pick<Evidence, 'status' | 'freshUntil'>, now: number, staticSource = false) {
  if (staticSource || evidence.status !== 'Available') return evidence.status
  const deadline = evidence.freshUntil === null ? NaN : Date.parse(evidence.freshUntil)
  return Number.isFinite(deadline) && deadline <= now ? 'Stale' : evidence.status
}

export function cityEvidenceDisclosure(state: CityEvidenceState, mode: CitySourceMode) {
  const page = state.page
  if (!page) return { status: state.error ? 'Load failed' : 'Loading', observedAt: null, detail: state.error ?? 'Reading city evidence.', degraded: !!state.error }
  const staticSource = mode !== 'live' || page.evidence.source === 'ImportedArchive' || page.evidence.source === 'Fixture'
  // The catalog can be newly read while the query facts are old. Date the workload from its
  // own observations, not the successful catalog request or the browser's receipt time.
  const evidence = page.topQueryFamilies.length > 0
    ? page.topQueryFamilies.map(family => family.evidence)
    : [page.otherWorkload.evidence]
  const observations = evidence.map(item => item.observedAt)
  const observedAt = observations.some(at => at === null || !Number.isFinite(Date.parse(at)))
    ? null
    : observations.reduce<string | null>((oldest, at) => oldest === null || Date.parse(at!) < Date.parse(oldest) ? at : oldest, null)
  const statuses = [page.evidence, ...evidence].map(item => evidenceStatus(item, state.now, staticSource))
  const failure = statuses.find(status => status !== 'Available' && status !== 'Stale')
  const status = state.error ? 'Refresh failed' : failure ?? (statuses.includes('Stale') ? 'Stale' : 'Available')
  const source = mode === 'archive' ? 'Archive snapshot' : mode === 'edge' ? 'Edge sample' : page.evidence.source
  const time = observedAt ? `Workload observed ${new Date(observedAt).toLocaleString()}.` : 'Workload observation time unknown.'
  return {
    status,
    observedAt,
    degraded: status !== 'Available',
    detail: `${source} · ${status}. ${time} ${staticSource ? 'Static captured evidence, not a live reading. ' : ''}${state.error ? `${state.error} Last useful city retained. ` : ''}${evidence.find(item => item.status !== 'Available')?.reason ?? page.evidence.reason}`,
  }
}

/** One cancellable owner for every city walk; a refresh never merges into retained history. */
export class CityEvidenceController {
  private state: CityEvidenceState = { page: null, phase: 'idle', loadedCount: 0, error: null, lastSuccessAt: null, now: Date.now() }
  private listeners = new Set<() => void>()
  private request: AbortController | null = null
  private generation = 0
  private clock: ReturnType<typeof setTimeout> | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  readonly databaseId: string
  readonly metric: string
  readonly mode: CitySourceMode
  private readonly fetchCity: FetchCity
  private readonly paint: () => Promise<void>
  private readonly hidden: () => boolean

  constructor(
    databaseId: string,
    metric: string,
    mode: CitySourceMode,
    fetchCity: FetchCity,
    paint: () => Promise<void> = () => Promise.resolve(),
    hidden: () => boolean = () => false,
  ) {
    this.databaseId = databaseId
    this.metric = metric
    this.mode = mode
    this.fetchCity = fetchCity
    this.paint = paint
    this.hidden = hidden
  }

  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private update(update: Partial<CityEvidenceState>) {
    this.state = { ...this.state, ...update, ...('page' in update ? { now: Date.now() } : {}) }
    this.listeners.forEach(listener => listener())
    if ('page' in update) this.scheduleExpiry()
  }
  private scheduleExpiry() {
    if (this.clock !== null) clearTimeout(this.clock)
    this.clock = null
    const page = this.state.page
    if (!page) return
    if (this.mode !== 'live' || page.evidence.source === 'Fixture' || page.evidence.source === 'ImportedArchive') {
      if (this.poll !== null) clearInterval(this.poll)
      this.poll = null
      return
    }
    const now = Date.now()
    const deadlines = [page.evidence, page.otherWorkload.evidence, ...page.topQueryFamilies.map(family => family.evidence)]
      .filter(evidence => evidence.status === 'Available')
      .map(evidence => evidence.freshUntil === null ? NaN : Date.parse(evidence.freshUntil))
      .filter(deadline => Number.isFinite(deadline) && deadline > now)
    if (deadlines.length === 0) return
    this.clock = setTimeout(() => {
      this.clock = null
      this.update({ now: Date.now() })
      this.scheduleExpiry()
    }, Math.min(2_147_483_647, Math.max(1, Math.min(...deadlines) - now)))
  }

  start() {
    void this.load('initial')
    if (this.mode === 'live') {
      this.poll = setInterval(() => {
        if (!this.hidden() && !this.request && this.state.page?.evidence.source !== 'ImportedArchive' && this.state.page?.evidence.source !== 'Fixture') void this.refresh()
      }, CITY_REFRESH_INTERVAL_MS)
    }
  }

  dispose() {
    this.cancel()
    if (this.clock !== null) clearTimeout(this.clock)
    if (this.poll !== null) clearInterval(this.poll)
    this.clock = this.poll = null
  }

  cancel = () => {
    this.generation += 1
    this.request?.abort()
    this.request = null
    this.update({ phase: 'idle' })
  }
  refresh = () => this.load(this.state.page ? 'refresh' : 'initial')
  loadMore = () => {
    if (this.request || !this.state.page?.nextPageToken) return Promise.resolve()
    return this.load('continuation')
  }

  private async load(kind: 'initial' | 'refresh' | 'continuation') {
    this.cancel()
    const generation = this.generation
    const controller = new AbortController()
    this.request = controller
    const current = () => generation === this.generation && !controller.signal.aborted
    let merged = kind === 'continuation' ? this.state.page : null
    let token = merged?.nextPageToken ?? null
    let pages = 0
    this.update({ phase: kind, ...(this.state.page ? {} : { error: null }) })
    try {
      do {
        const page = await this.fetchCity(this.databaseId, this.metric, token, controller.signal)
        if (!current()) return
        if (page.databaseId !== this.databaseId || page.metric.toLowerCase() !== this.metric.toLowerCase()) {
          throw new Error('The city response belongs to a different database or workload ranking. Retry the city read.')
        }
        pages += 1
        merged = merged ? mergeCityPage(merged, page) : page
        token = page.nextPageToken
        this.update({ loadedCount: merged.objects.length })
        if (kind === 'initial' && pages === 1) {
          this.update({ page: merged, lastSuccessAt: new Date().toISOString(), phase: token ? 'backfill' : 'idle' })
        }
      } while (token && pages < (kind === 'continuation' ? 1 : AUTO_PAGE_LIMIT))
      if (!current() || !merged) return
      if (kind === 'initial' && pages > 1) {
        this.update({ phase: 'layout' })
        await this.paint()
        if (!current()) return
      }
      this.update({ page: merged, lastSuccessAt: new Date().toISOString(), error: null })
    } catch (reason) {
      if (current()) this.update({ error: reason instanceof Error ? reason.message : String(reason) })
    } finally {
      if (current()) {
        this.request = null
        this.update({ phase: 'idle', now: Date.now() })
      }
    }
  }
}
