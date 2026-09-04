import type { NormalizedShowplan, ShowplanNode, QueryFamilyDetail } from './contracts'
import type { DatabaseCityObject, DatabaseCityQueryFamily } from './databaseCityContracts'
import { matchObject, unquote } from './cityRoute'

/**
 * How many ranked query families the survey will read plans for.
 *
 * Every family costs two round trips — the family detail, then the compiled plan — so this is the
 * ceiling on the survey's whole network cost, not a display limit. Forty against the page's own
 * ranking covers the workload the city is already drawing streets for; beyond that the families are
 * ranked below anything the map gives a visible street to, so a fire found there would be attached
 * to a building nobody is looking at, for two more requests.
 *
 * The page's `topQueryFamilies` is usually shorter than this, in which case the survey reads all of
 * it and the cap never binds.
 */
export const DISASTER_SURVEY_FAMILY_LIMIT = 40

/**
 * Plan fetches in flight at once.
 *
 * The survey is background work behind a city that has already drawn itself, so it deliberately
 * does not saturate the connection pool: a burst of forty parallel Query Store reads would compete
 * with the thirty-second city refresh and the live incident poll, both of which the operator is
 * actually watching. Four keeps the survey moving without ever being the reason a foreground
 * request queued.
 */
export const DISASTER_SURVEY_CONCURRENCY = 4

/**
 * Warning kinds the parser can actually produce, which is narrower than the set of kinds SQL Server
 * documents.
 *
 * A kind is the raw Showplan element or attribute name. `SpillToTempDb` and `PlanAffectingConvert`
 * are elements; `NoJoinPredicate` is an attribute on `<Warnings>` and only became reachable once the
 * parser started reading those. Names that are neither — `HashSpill`, `SortSpill` — match nothing no
 * matter how plausible they look, so they are deliberately absent rather than kept as harmless
 * spares: a set entry that can never match is a rule that silently never fires.
 */
export const DEGRADING_WARNING_KINDS: ReadonlySet<string> = new Set([
  'spilltotempdb',
  'unmatchedindexes',
  'planaffectingconvert',
  'nojoinpredicate',
  'columnswithnostatistics',
])

/** One index the optimizer asked for, resolved against the city's loaded objects. */
export interface SurveyedMissingIndex {
  /** Null when the suggestion names a table this page does not hold. Counted, but undrawable. */
  readonly objectId: string | null
  readonly label: string
  /** The optimizer's own estimate of how much cheaper *that query* would be, 0..100. */
  readonly impactPercent: number | null
  readonly familyId: string
  readonly planId: string
}

/** One degrading warning, attributed to the table whose work carries it. */
export interface SurveyedWarning {
  /** Lower-cased raw Showplan kind, matching {@link DEGRADING_WARNING_KINDS}. */
  readonly kind: string
  /** Null when no operator in the warning's neighbourhood named a table this page holds. */
  readonly objectId: string | null
  readonly label: string
  readonly familyId: string
  readonly planId: string
}

/** What one compiled plan contributed to the survey. */
export interface PlanDisasterEvidence {
  readonly planId: string
  readonly familyId: string
  readonly missingIndexes: readonly SurveyedMissingIndex[]
  readonly warnings: readonly SurveyedWarning[]
  /**
   * False when this plan carries no missing-index evidence at all — normalized by a build that did
   * not read `<MissingIndexes>`. Distinct from an empty list, which means the optimizer asked for
   * nothing.
   */
  readonly missingIndexesObserved: boolean
}

export type DisasterSurveyStatus = 'idle' | 'running' | 'complete' | 'unavailable'

/**
 * The workload's accumulated disaster evidence.
 *
 * This is what lets the city stand lit by its own problems instead of only while a plan happens to
 * be routed. A routed plan is one query; this is every ranked family the page listed, which is the
 * same evidence the streets are already graded from.
 */
export interface DisasterSurvey {
  readonly status: DisasterSurveyStatus
  readonly missingIndexes: readonly SurveyedMissingIndex[]
  readonly warnings: readonly SurveyedWarning[]
  /** Families whose plans were successfully read. */
  readonly plansRead: number
  /** Families the survey attempted, which is the page's ranking capped at the family limit. */
  readonly familiesConsidered: number
  /**
   * Families for which Query Store retained no compiled plan. An ordinary outcome, disclosed rather
   * than hidden, because it is the difference between "no fires" and "nothing was read".
   */
  readonly familiesWithoutPlan: number
  /** True once at least one plan carried readable `<MissingIndexes>` evidence. */
  readonly missingIndexesObserved: boolean
  readonly reason: string
}

export const EMPTY_DISASTER_SURVEY: DisasterSurvey = {
  status: 'idle',
  missingIndexes: [],
  warnings: [],
  plansRead: 0,
  familiesConsidered: 0,
  familiesWithoutPlan: 0,
  missingIndexesObserved: false,
  reason: 'The workload has not been surveyed for plan-level disasters yet.',
}

function ownCost(node: ShowplanNode): number {
  return (node.estimatedCpuCost ?? 0) + (node.estimatedIoCost ?? 0)
}

/**
 * A warning's raw kind, lower-cased.
 *
 * Compared case-insensitively because the .NET vocabulary that produces these compares that way, and
 * a set that disagreed with it about case would silently miss.
 */
function warningKind(kind: string): string {
  return kind.trim().toLowerCase()
}

function referenceLabel(node: ShowplanNode): string {
  const reference = node.objectReference
  if (!reference) return 'an unnamed operator'
  const schema = unquote(reference.schema)
  const table = unquote(reference.table)
  if (table === null) return 'an unnamed operator'
  return schema === null ? table : `${schema}.${table}`
}

/**
 * Which table a warning belongs to.
 *
 * A spill or a plan-affecting convert is recorded on the operator that suffered it, and that
 * operator is very often a Sort or a Hash Match, which names no table at all. Dropping those would
 * discard most of the evidence — measured against a real workload, warnings on object-naming
 * operators are the minority — so the search widens in the same order `buildStops` widens it:
 *
 * 1. The operator's own `objectReference`, when it has one.
 * 2. The **heaviest** descendant that names one, because that is the table the warning's rows
 *    mostly came from. Heaviest by the optimizer's own estimated cost, so the choice is the plan's
 *    arithmetic rather than tree order.
 * 3. The nearest ancestor that names one, for a warning above every table it could belong to.
 *
 * A warning that resolves to nothing is still returned, with a null `objectId`. It is real, it is
 * counted in the headline, and it simply has nowhere on this map to be drawn — which is the same
 * rule the incident pins follow, and the opposite of drawing it somewhere convenient.
 */
function attributeWarnings(
  showplan: NormalizedShowplan,
  objects: readonly DatabaseCityObject[],
  databaseName: string,
  familyId: string,
): SurveyedWarning[] {
  const nodes = showplan.nodes ?? []
  if (nodes.length === 0) return []

  const byId = new Map<number, ShowplanNode>()
  for (const node of nodes) byId.set(node.nodeId, node)
  const children = new Map<number, ShowplanNode[]>()
  for (const node of nodes) {
    if (node.parentNodeId === null || !byId.has(node.parentNodeId)) continue
    const bucket = children.get(node.parentNodeId)
    if (bucket) bucket.push(node)
    else children.set(node.parentNodeId, [node])
  }

  const owner = (node: ShowplanNode): ShowplanNode | null => {
    if (node.objectReference) return node

    // Heaviest object-naming descendant. Breadth is bounded by the plan, and a plan deep enough for
    // this to matter is already far past the operator limit the parser enforces.
    let best: ShowplanNode | null = null
    const queue = [...(children.get(node.nodeId) ?? [])]
    const seen = new Set<number>([node.nodeId])
    while (queue.length > 0) {
      const candidate = queue.shift()!
      if (seen.has(candidate.nodeId)) continue
      seen.add(candidate.nodeId)
      if (candidate.objectReference && (best === null || ownCost(candidate) > ownCost(best))) {
        best = candidate
      }
      queue.push(...(children.get(candidate.nodeId) ?? []))
    }
    if (best) return best

    let ancestor = node.parentNodeId === null ? null : byId.get(node.parentNodeId) ?? null
    const walked = new Set<number>([node.nodeId])
    while (ancestor && !walked.has(ancestor.nodeId)) {
      walked.add(ancestor.nodeId)
      if (ancestor.objectReference) return ancestor
      ancestor = ancestor.parentNodeId === null ? null : byId.get(ancestor.parentNodeId) ?? null
    }
    return null
  }

  const warnings: SurveyedWarning[] = []
  for (const node of nodes) {
    for (const warning of node.warnings ?? []) {
      const kind = warningKind(warning.kind)
      if (!DEGRADING_WARNING_KINDS.has(kind)) continue
      const carrier = owner(node)
      const matched = carrier?.objectReference
        ? matchObject(carrier.objectReference, objects, databaseName)
        : null
      warnings.push({
        kind,
        objectId: matched?.objectId ?? null,
        label: matched ? `${matched.schemaName}.${matched.name}` : carrier ? referenceLabel(carrier) : 'an unplaced operator',
        familyId,
        planId: showplan.planId,
      })
    }
  }
  return warnings
}

/**
 * Everything one compiled plan says about the city's disasters.
 *
 * Pure, and deliberately independent of {@link ./cityPlan}: resolution needs only the loaded
 * objects and the database name, so a survey result survives a re-layout without being recomputed.
 */
export function surveyShowplan(
  showplan: NormalizedShowplan,
  {
    objects,
    databaseName,
    familyId,
  }: { objects: readonly DatabaseCityObject[]; databaseName: string; familyId: string },
): PlanDisasterEvidence {
  const suggestions = showplan.missingIndexes
  const missingIndexes: SurveyedMissingIndex[] = (suggestions ?? []).map(missing => {
    const matched = matchObject(
      { database: missing.database, schema: missing.schema, table: missing.table, index: null },
      objects,
      databaseName,
    )
    const schema = unquote(missing.schema)
    const table = unquote(missing.table)
    return {
      objectId: matched?.objectId ?? null,
      label: matched
        ? `${matched.schemaName}.${matched.name}`
        : table === null
          ? 'an unnamed table'
          : schema === null ? table : `${schema}.${table}`,
      impactPercent: missing.impactPercent,
      familyId,
      planId: showplan.planId,
    }
  })

  return {
    planId: showplan.planId,
    familyId,
    missingIndexes,
    warnings: attributeWarnings(showplan, objects, databaseName, familyId),
    missingIndexesObserved: suggestions !== undefined,
  }
}

/**
 * Folds the per-plan evidence into one survey.
 *
 * Deduplicated by plan id, because a family whose detail resolves to a plan another family already
 * contributed would otherwise count the same fire twice and make one missing index look like two.
 */
export function mergeDisasterSurvey(
  evidence: readonly PlanDisasterEvidence[],
  {
    status,
    familiesConsidered,
    familiesWithoutPlan,
    reason,
  }: {
    status: DisasterSurveyStatus
    familiesConsidered: number
    familiesWithoutPlan: number
    reason: string
  },
): DisasterSurvey {
  const seen = new Set<string>()
  const missingIndexes: SurveyedMissingIndex[] = []
  const warnings: SurveyedWarning[] = []
  let missingIndexesObserved = false
  let plansRead = 0

  for (const plan of evidence) {
    if (seen.has(plan.planId)) continue
    seen.add(plan.planId)
    plansRead += 1
    missingIndexes.push(...plan.missingIndexes)
    warnings.push(...plan.warnings)
    if (plan.missingIndexesObserved) missingIndexesObserved = true
  }

  return {
    status,
    missingIndexes,
    warnings,
    plansRead,
    familiesConsidered,
    familiesWithoutPlan,
    missingIndexesObserved,
    reason,
  }
}

export interface DisasterSurveyFetchers {
  fetchQueryFamily(familyId: string, signal?: AbortSignal): Promise<QueryFamilyDetail>
  fetchPlan(planId: string, signal?: AbortSignal): Promise<NormalizedShowplan>
}

/** One family's compiled plan, held so a later pass can re-resolve it without re-fetching it. */
export interface CachedSurveyPlan {
  readonly planId: string
  readonly showplan: NormalizedShowplan
}

/**
 * Reads the ranked families' compiled plans and accumulates what they say about the city.
 *
 * Failures are swallowed **per family**, not per survey. Query Store retaining no plan for one
 * family, or a single plan fetch failing, is an ordinary outcome that must not discard the forty
 * plans either side of it — the survey's whole purpose is to be an aggregate. An abort is the one
 * exception and propagates, because a cancelled survey has no result rather than a partial one.
 */
export async function runDisasterSurvey(
  families: readonly DatabaseCityQueryFamily[],
  context: {
    objects: readonly DatabaseCityObject[]
    databaseName: string
    fetchers: DisasterSurveyFetchers
    signal?: AbortSignal
    /**
     * Plans already fetched, keyed by family id, so a refresh re-reads nothing over the network.
     *
     * The **showplan** is cached rather than the evidence extracted from it. Object ids are resolved
     * against the object list the caller passes, and that list grows as the city pages in — so
     * caching the resolved evidence would freeze every family's answer against however much of the
     * city had arrived when it was first read, and a table that paged in later would never catch
     * fire. Caching the plan keeps re-resolution free and correct.
     */
    cache?: Map<string, CachedSurveyPlan | null>
    onProgress?: (survey: DisasterSurvey) => void
  },
): Promise<DisasterSurvey> {
  const { objects, databaseName, fetchers, signal, cache, onProgress } = context
  const considered = families.slice(0, DISASTER_SURVEY_FAMILY_LIMIT)
  if (considered.length === 0) {
    return mergeDisasterSurvey([], {
      status: 'unavailable',
      familiesConsidered: 0,
      familiesWithoutPlan: 0,
      reason: 'The page listed no ranked query family, so no compiled plan was read and no plan-level disaster is claimed either way.',
    })
  }

  const evidence: PlanDisasterEvidence[] = []
  let withoutPlan = 0
  let cursor = 0

  const publish = (status: DisasterSurveyStatus) => {
    onProgress?.(mergeDisasterSurvey(evidence, {
      status,
      familiesConsidered: considered.length,
      familiesWithoutPlan: withoutPlan,
      reason: describeSurvey(status, evidence.length, considered.length, withoutPlan),
    }))
  }

  const worker = async () => {
    for (;;) {
      if (signal?.aborted) return
      const index = cursor
      cursor += 1
      const family = considered[index]
      if (!family) return

      const cached = cache?.get(family.familyId)
      if (cached !== undefined) {
        if (cached === null) withoutPlan += 1
        // Re-resolved rather than replayed: see the note on `cache` above.
        else evidence.push(surveyShowplan(cached.showplan, {
          objects,
          databaseName,
          familyId: family.familyId,
        }))
        publish('running')
        continue
      }

      try {
        const detail = await fetchers.fetchQueryFamily(family.familyId, signal)
        // A dispatcher plan carries no operator tree to read, so prefer one whose runtime is counted.
        const plan = detail.plans.find(candidate => candidate.runtimeCounted) ?? detail.plans[0]
        if (!plan) {
          withoutPlan += 1
          cache?.set(family.familyId, null)
          publish('running')
          continue
        }
        const showplan = await fetchers.fetchPlan(plan.planId, signal)
        const read = surveyShowplan(showplan, { objects, databaseName, familyId: family.familyId })
        evidence.push(read)
        cache?.set(family.familyId, { planId: plan.planId, showplan })
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === 'AbortError') throw reason
        if (signal?.aborted) throw reason
        // One family's plan being unreadable is not the survey failing. It is left out of
        // `plansRead`, which is what the disclosure is computed from, and never cached as a
        // negative — a transient failure must not become a permanent absence of evidence.
        withoutPlan += 1
      }
      publish('running')
    }
  }

  const workers = Array.from(
    { length: Math.min(DISASTER_SURVEY_CONCURRENCY, considered.length) },
    () => worker(),
  )
  await Promise.all(workers)

  const status: DisasterSurveyStatus = evidence.length > 0 ? 'complete' : 'unavailable'
  const survey = mergeDisasterSurvey(evidence, {
    status,
    familiesConsidered: considered.length,
    familiesWithoutPlan: withoutPlan,
    reason: describeSurvey(status, evidence.length, considered.length, withoutPlan),
  })
  onProgress?.(survey)
  return survey
}

function describeSurvey(
  status: DisasterSurveyStatus,
  plansRead: number,
  considered: number,
  withoutPlan: number,
): string {
  if (status === 'unavailable' && plansRead === 0) {
    return withoutPlan > 0
      ? `Query Store retained no readable compiled plan for any of the ${considered} ranked family(ies), so no plan-level disaster is claimed either way.`
      : 'No compiled plan was read, so no plan-level disaster is claimed either way.'
  }
  const tail = withoutPlan > 0
    ? ` ${withoutPlan} family(ies) had no readable retained plan and contribute no evidence.`
    : ''
  return status === 'running'
    ? `Reading compiled plans for the ${considered} top-ranked query family(ies); ${plansRead} read so far.${tail}`
    : `Read ${plansRead} of ${considered} top-ranked query family(ies)' compiled plans.${tail}`
}
