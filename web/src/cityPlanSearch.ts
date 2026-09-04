import type { NormalizedShowplan, QueryFamilyDetail, QueryFamilyPage, QueryFamilySummary } from './contracts'
import type { DatabaseCityQueryFamily } from './databaseCityContracts'
import { QueryStoreRequestError } from './api'

export interface PlanChoice {
  planId: string
  familyId: string | null
  queryHash: string | null
  text: string | null
  textReason: string
  executionCount: string | null
  family: QueryFamilySummary | null
  cityFamily?: DatabaseCityQueryFamily
  showplan?: NormalizedShowplan
}
export interface PlanFetchers {
  fetchFamilies: (metric: string, token: string | null, signal: AbortSignal, databaseId: string) => Promise<QueryFamilyPage>
  fetchFamily: (id: string, signal: AbortSignal) => Promise<QueryFamilyDetail>
  fetchPlan: (id: string, signal: AbortSignal) => Promise<NormalizedShowplan>
}
export type PlanSearchMode = 'family' | 'plan'
export interface PlanSearchState {
  status: 'idle' | 'loading' | 'partial' | 'exhausted' | 'error' | 'limited'
  choices: PlanChoice[]
  searched: number
  failures: string[]
  error: string | null
  canContinue: boolean
}
const FAMILY_READ_LIMIT = 8
const RESULT_LIMIT = 200
const INITIAL: PlanSearchState = { status: 'idle', choices: [], searched: 0, failures: [], error: null, canContinue: false }

export function planChoice(detail: QueryFamilyDetail, planId: string, cityFamily?: DatabaseCityQueryFamily): PlanChoice {
  return {
    planId, familyId: detail.family.familyId, queryHash: detail.family.queryHash,
    text: detail.family.text.normalizedText, textReason: detail.family.text.reason,
    executionCount: detail.family.executionCount, family: detail.family, cityFamily,
  }
}
function matches(family: QueryFamilySummary, term: string) {
  return [family.familyId, family.queryHash, family.text.normalizedText ?? ''].some(value => value.toLocaleLowerCase().includes(term))
}
/** Numeric connected IDs are qualified before any lookup; opaque IDs need membership evidence. */
export function scopedPlanId(databaseId: string, value: string) {
  const id = value.trim()
  return /^\d+$/.test(id) ? `${databaseId}:${id}` : id
}

export class CityPlanSearch {
  private state: PlanSearchState = INITIAL
  private listeners = new Set<() => void>()
  private controller: AbortController | null = null
  private generation = 0
  private term = ''
  private mode: PlanSearchMode = 'family'
  private token: string | null = null
  private started = false
  private pending: QueryFamilySummary[] = []
  private direct: NormalizedShowplan | null = null

  private databaseId: string
  private metric: string
  private api: PlanFetchers
  constructor(databaseId: string, metric: string, api: PlanFetchers) {
    this.databaseId = databaseId
    this.metric = metric
    this.api = api
  }
  getSnapshot = () => this.state
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  private update(patch: Partial<PlanSearchState>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach(fn => fn())
  }
  cancel = () => { this.generation += 1; this.controller?.abort(); this.controller = null }
  search = async (term: string, mode: PlanSearchMode) => {
    this.cancel()
    this.term = term.trim()
    this.mode = mode
    this.token = null
    this.started = false
    this.pending = []
    this.direct = null
    this.update({ ...INITIAL })
    await this.more()
  }
  more = async () => {
    if (this.controller || this.state.status === 'exhausted' || this.state.status === 'limited') return
    const controller = new AbortController()
    this.controller = controller
    const generation = this.generation
    const current = () => generation === this.generation && !controller.signal.aborted
    this.update({ status: 'loading', error: null })
    try {
      const id = scopedPlanId(this.databaseId, this.term)
      if (!this.started && this.mode === 'plan') {
        if (!this.term) throw new Error('Enter a captured plan ID.')
        try {
          const plan = await this.api.fetchPlan(id, controller.signal)
          if (!current()) return
          if (plan.planId !== id) throw new Error('The returned plan does not match the requested plan ID.')
          this.direct = plan
        } catch (reason) {
          if (!(reason instanceof QueryStoreRequestError && reason.status === 404)) throw reason
          if (!current()) return
          this.update({ failures: [`Plan ${id} is absent or unavailable from this source.`] })
        }
        if (!current()) return
        if (this.direct && id.startsWith(`${this.databaseId}:`) && /^\d+$/.test(id.slice(this.databaseId.length + 1))) {
          this.update({ choices: [{
            planId: id, familyId: null, queryHash: null, text: null,
            textReason: 'Family context not yet located. Continue the bounded search to attach its SQL and measurements.',
            executionCount: null, family: null, showplan: this.direct,
          }] })
        }
      }
      if (this.pending.length === 0 && (!this.started || this.token)) {
        const page = await this.api.fetchFamilies(this.metric, this.token, controller.signal, this.databaseId)
        if (!current()) return
        if (page.items.some(family => family.databaseId !== this.databaseId)) throw new Error('The search response belongs to another database.')
        this.pending = page.items
        this.token = page.nextPageToken
        this.started = true
      }
      let reads = 0
      while (this.pending.length > 0 && reads < FAMILY_READ_LIMIT && this.state.choices.length < RESULT_LIMIT) {
        const family = this.pending[0]
        if (this.mode === 'family' && !matches(family, this.term.toLocaleLowerCase())) {
          this.pending.shift()
          this.update({ searched: this.state.searched + 1 })
          continue
        }
        reads += 1
        try {
          const detail = await this.api.fetchFamily(family.familyId, controller.signal)
          if (!current()) return
          if (detail.family.databaseId !== this.databaseId) throw new Error('Family evidence belongs to another database.')
          const plans = this.mode === 'plan' ? detail.plans.filter(plan => plan.planId === id) : detail.plans
          const choices = new Map(this.state.choices.map(choice => [choice.planId, choice]))
          for (const plan of plans) {
            if (choices.size >= RESULT_LIMIT && !choices.has(plan.planId)) break
            choices.set(plan.planId, { ...planChoice(detail, plan.planId), ...(this.direct?.planId === plan.planId ? { showplan: this.direct } : {}) })
          }
          const failures = plans.length === 0 && this.mode === 'family'
            ? [...this.state.failures, `${family.familyId}: no retained compiled plan.`] : this.state.failures
          this.update({ choices: [...choices.values()], failures })
        } catch (reason) {
          if (!current()) return
          this.update({ failures: [...this.state.failures, `${family.familyId}: ${reason instanceof Error ? reason.message : String(reason)}`] })
        }
        this.pending.shift()
        this.update({ searched: this.state.searched + 1 })
      }
      if (!current()) return
      const canContinue = this.pending.length > 0 || this.token !== null
      this.update({
        canContinue,
        status: this.state.choices.length >= RESULT_LIMIT ? 'limited' : canContinue || this.state.failures.length > 0 ? 'partial' : 'exhausted',
      })
    } catch (reason) {
      if (current()) this.update({ status: 'error', error: reason instanceof Error ? reason.message : String(reason), canContinue: true })
    } finally {
      if (current()) this.controller = null
    }
  }
}
