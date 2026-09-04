import type { NormalizedShowplan } from './contracts'
import type { DatabaseCityQueryFamily } from './databaseCityContracts'
import { planChoice, type PlanChoice, type PlanFetchers } from './cityPlanSearch'
import { queryAddressId } from './addressBook'
import type { TrafficBasis } from './cityTrafficWindow'
import type { PlanScopePolicy } from './cityQueryScope'

export interface ActiveCityPlan { choice: PlanChoice; showplan: NormalizedShowplan }
export interface CityNavigationState {
  activePlan: ActiveCityPlan | null
  selectedAddressId: string | null
  mappingFamilyId: string | null
  loading: boolean
  error: string | null
}
export class CityPlanNavigation {
  private state: CityNavigationState = { activePlan: null, selectedAddressId: null, mappingFamilyId: null, loading: false, error: null }
  private listeners = new Set<() => void>()
  private request: AbortController | null = null
  private generation = 0
  private returnFocus: (() => void) | null = null
  private databaseId: string | null
  private api: Pick<PlanFetchers, 'fetchFamily' | 'fetchPlan'>
  private policy: PlanScopePolicy
  constructor(databaseId: string | null, api: Pick<PlanFetchers, 'fetchFamily' | 'fetchPlan'>, policy: PlanScopePolicy = { directPlanIds: true, reason: null }) {
    this.databaseId = databaseId
    this.api = api
    this.policy = policy
  }
  getSnapshot = () => this.state
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  private update(patch: Partial<CityNavigationState>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach(fn => fn())
  }
  cancel = () => { this.generation += 1; this.request?.abort(); this.request = null }
  selectAddress = (id: string | null) => this.update({ selectedAddressId: id })
  clear = (restoreFocus = true) => {
    this.cancel()
    this.update({ activePlan: null, selectedAddressId: null, mappingFamilyId: null, loading: false, error: null })
    if (restoreFocus) this.returnFocus?.()
    this.returnFocus = null
  }
  openFamily = async (family: DatabaseCityQueryFamily, returnFocus?: () => void, trafficBasis?: TrafficBasis) => {
    await this.open(async signal => {
      if (this.databaseId === null) throw new Error(this.policy.reason ?? 'The query database scope is unavailable.')
      const detail = await this.api.fetchFamily(family.familyId, signal)
      if (detail.family.databaseId !== this.databaseId) throw new Error('This query family belongs to another database.')
      const plan = detail.plans.find(candidate => candidate.runtimeCounted) ?? detail.plans[0]
      if (!plan) throw new Error(`Query Store retains no compiled plan for ${family.familyId}. The family may have retired; its measured evidence is still shown on the road.`)
      return { ...planChoice(detail, plan.planId, family), trafficBasis }
    }, family.familyId, returnFocus)
  }
  openPlan = async (choice: PlanChoice, returnFocus?: () => void) => {
    await this.open(async () => {
      if (this.databaseId === null) throw new Error(this.policy.reason ?? 'The query database scope is unavailable.')
      const scopedId = this.policy.directPlanIds && choice.planId.startsWith(`${this.databaseId}:`) && /^\d+$/.test(choice.planId.slice(this.databaseId.length + 1))
      if (choice.family ? choice.family.databaseId !== this.databaseId : !scopedId) throw new Error('This plan has not been located in the selected database. Continue the bounded search.')
      return choice
    }, choice.familyId, returnFocus)
  }
  private async open(resolve: (signal: AbortSignal) => Promise<PlanChoice>, familyId: string | null, returnFocus?: () => void) {
    this.cancel()
    const generation = this.generation
    const controller = new AbortController()
    this.request = controller
    this.returnFocus = returnFocus ?? null
    const current = () => generation === this.generation && !controller.signal.aborted
    this.update({ selectedAddressId: familyId ? queryAddressId(familyId) : null, mappingFamilyId: familyId, loading: true, error: null })
    try {
      const choice = await resolve(controller.signal)
      if (!current()) return
      const showplan = choice.showplan ?? await this.api.fetchPlan(choice.planId, controller.signal)
      if (!current()) return
      if (showplan.planId !== choice.planId) throw new Error('The returned plan does not match the selected plan ID.')
      this.update({ activePlan: { choice, showplan } })
    } catch (reason) {
      if (current()) this.update({ error: reason instanceof Error ? reason.message : String(reason) })
    } finally {
      if (current()) {
        this.request = null
        this.update({ mappingFamilyId: null, loading: false })
      }
    }
  }
}
