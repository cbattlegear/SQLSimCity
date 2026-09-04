import { describe, expect, it, vi } from 'vitest'
import type { NormalizedShowplan, QueryFamilyDetail, ShowplanNode } from './contracts'
import type { DatabaseCityObject, DatabaseCityQueryFamily } from './databaseCityContracts'
import {
  DEGRADING_WARNING_KINDS,
  DISASTER_SURVEY_FAMILY_LIMIT,
  EMPTY_DISASTER_SURVEY,
  mergeDisasterSurvey,
  runDisasterSurvey,
  surveyShowplan,
  type CachedSurveyPlan,
  type PlanDisasterEvidence,
} from './cityDisasterSurvey'

/*
 * Why this module exists at all, restated because it is what these tests are protecting.
 *
 * Three of the four disasters `cityDisasters.ts` can report need plan-level evidence — a missing
 * index, or a degrading warning — and that evidence lives only inside a compiled showplan. Before
 * the survey, the only showplan the city ever held was the one a reader had explicitly routed, so
 * a fire could not exist until somebody went looking for the query that caused it. That is exactly
 * backwards: the point of the city is to show you where to look.
 *
 * The survey reads the ranked families' plans in the background so the city can stand lit by its
 * own workload. Everything below is about not lying while doing it.
 */

function node(overrides: Partial<ShowplanNode> = {}): ShowplanNode {
  return {
    nodeId: 1,
    parentNodeId: null,
    logicalOperation: 'Inner Join',
    physicalOperation: 'Nested Loops',
    estimatedRows: 100,
    estimatedCpuCost: 0.1,
    estimatedIoCost: 0,
    estimatedTotalSubtreeCost: 0.1,
    parallel: false,
    objectReference: null,
    predicate: null,
    warnings: [],
    ...overrides,
  }
}

function showplan(overrides: Partial<NormalizedShowplan> = {}): NormalizedShowplan {
  return {
    planId: 'p1',
    showplanVersion: '1.539',
    cardinalityEstimatorVersion: '160',
    serialDesiredMemoryKiB: null,
    serialRequiredMemoryKiB: null,
    optimization: 'None',
    dispatcherExpression: null,
    structuralFingerprint: 'fp',
    runtimeOverlayCaveat: '',
    nodes: [],
    ...overrides,
  }
}

function cityObject(overrides: Partial<DatabaseCityObject> = {}): DatabaseCityObject {
  const evidence = {
    source: 'NotProbed',
    status: 'Unknown',
    observedAt: null,
    freshUntil: null,
    reason: 'n/a',
  } as const
  return {
    objectId: 'o1',
    schemaId: 's1',
    schemaName: 'app1',
    name: 'orders',
    kind: 'Table',
    reservedPages8KiB: '10',
    usedPages8KiB: '10',
    reservedBytes: '81920',
    usedBytes: '81920',
    sizeStatus: 'Known',
    sizeReason: null,
    layout: { neighborhoodOrdinal: 0, objectOrdinal: 0, x: 0, z: 0 },
    indexes: [],
    directActivity: { totalOperations: null, resetEpochToken: null, evidence },
    attributedExposure: {
      executionCount: null,
      totalCpuMicroseconds: null,
      totalDurationMicroseconds: null,
      totalLogicalReads8KiBPages: null,
      confidence: 'Unknown',
      rationale: 'n/a',
      evidence,
    },
    ...overrides,
  }
}

const OBJECTS = [
  cityObject({ objectId: 'o1', schemaName: 'app1', name: 'orders' }),
  cityObject({ objectId: 'o2', schemaName: 'app1', name: 'invoices' }),
]

function family(familyId: string): DatabaseCityQueryFamily {
  return { familyId } as unknown as DatabaseCityQueryFamily
}

function detail(planIds: readonly string[], counted = true): QueryFamilyDetail {
  return {
    plans: planIds.map(planId => ({ planId, runtimeCounted: counted })),
  } as unknown as QueryFamilyDetail
}

function evidenceFor(overrides: Partial<PlanDisasterEvidence> = {}): PlanDisasterEvidence {
  return {
    planId: 'p1',
    familyId: 'f1',
    missingIndexes: [],
    warnings: [],
    missingIndexesObserved: true,
    ...overrides,
  }
}

describe('surveyShowplan resolves a plan against the city that is actually loaded', () => {
  it('attaches a missing index to the building it names', () => {
    const read = surveyShowplan(
      showplan({
        missingIndexes: [
          { database: 'SimCity', schema: 'app1', table: 'orders', impactPercent: 91.5, equalityColumns: ['a'], inequalityColumns: [], includedColumns: [] },
        ],
      }),
      { objects: OBJECTS, databaseName: 'SimCity', familyId: 'f1' },
    )
    expect(read.missingIndexes).toHaveLength(1)
    expect(read.missingIndexes[0].objectId).toBe('o1')
    expect(read.missingIndexes[0].label).toBe('app1.orders')
    expect(read.missingIndexes[0].impactPercent).toBeCloseTo(91.5)
  })

  /*
   * The honest half of the contract, and the one worth a test of its own.
   *
   * Most warning-bearing plans on a real instance belong to system tables — measured against a live
   * database, the only `NoJoinPredicate` warnings in the top-ranked families named `sys.sysschobjs`
   * and `plan_persist_runtime_stats_interval`, neither of which the city draws. The suggestion is
   * still real and is still counted; it simply has nowhere to be drawn, and inventing a building for
   * it would be worse than showing nothing.
   */
  it('keeps a suggestion that names a table this page does not hold, with no object to draw it on', () => {
    const read = surveyShowplan(
      showplan({
        missingIndexes: [
          { database: 'SimCity', schema: 'sys', table: 'sysschobjs', impactPercent: 40, equalityColumns: [], inequalityColumns: [], includedColumns: [] },
        ],
      }),
      { objects: OBJECTS, databaseName: 'SimCity', familyId: 'f1' },
    )
    expect(read.missingIndexes).toHaveLength(1)
    expect(read.missingIndexes[0].objectId).toBeNull()
    expect(read.missingIndexes[0].label).toBe('sys.sysschobjs')
  })

  /*
   * A plan that carries no `<MissingIndexes>` element and a plan whose optimizer asked for nothing
   * are different facts, and the difference decides whether the sidebar may say "no fires" or has to
   * say "nothing was read". Collapsing them would let an old normalizer report a clean city.
   */
  it('distinguishes a plan with no suggestions from a plan whose suggestions were never read', () => {
    expect(surveyShowplan(showplan({ missingIndexes: [] }), {
      objects: OBJECTS, databaseName: 'SimCity', familyId: 'f1',
    }).missingIndexesObserved).toBe(true)

    expect(surveyShowplan(showplan(), {
      objects: OBJECTS, databaseName: 'SimCity', familyId: 'f1',
    }).missingIndexesObserved).toBe(false)
  })

  it('ignores a warning kind the parser can never produce', () => {
    const read = surveyShowplan(
      showplan({
        nodes: [node({ warnings: [{ kind: 'HashSpill', detail: null }] })],
      }),
      { objects: OBJECTS, databaseName: 'SimCity', familyId: 'f1' },
    )
    expect(read.warnings).toHaveLength(0)
    expect(DEGRADING_WARNING_KINDS.has('hashspill')).toBe(false)
  })

  it('matches a warning kind whatever case the plan spelled it in', () => {
    const read = surveyShowplan(
      showplan({
        nodes: [node({
          objectReference: { database: 'SimCity', schema: 'app1', table: 'orders', index: null },
          warnings: [{ kind: 'NoJoinPredicate', detail: null }],
        })],
      }),
      { objects: OBJECTS, databaseName: 'SimCity', familyId: 'f1' },
    )
    expect(read.warnings).toHaveLength(1)
    expect(read.warnings[0].kind).toBe('nojoinpredicate')
    expect(read.warnings[0].objectId).toBe('o1')
  })

  /*
   * The attribution rule, which is the whole reason a burst main can be drawn anywhere at all.
   *
   * A spill or a convert is recorded on the operator that suffered it, and that operator is usually
   * a Sort or a Hash Match naming no table. Dropping those would discard most of the evidence, so
   * the search widens to the heaviest object-naming descendant — heaviest by the optimizer's own
   * arithmetic, not by tree order, which is what these two tests separate.
   */
  it('blames the heaviest table underneath an operator that names none', () => {
    const read = surveyShowplan(
      showplan({
        nodes: [
          node({ nodeId: 1, warnings: [{ kind: 'SpillToTempDb', detail: null }] }),
          node({
            nodeId: 2,
            parentNodeId: 1,
            estimatedCpuCost: 0.01,
            estimatedIoCost: 0.01,
            objectReference: { database: 'SimCity', schema: 'app1', table: 'invoices', index: null },
          }),
          node({
            nodeId: 3,
            parentNodeId: 1,
            estimatedCpuCost: 5,
            estimatedIoCost: 9,
            objectReference: { database: 'SimCity', schema: 'app1', table: 'orders', index: null },
          }),
        ],
      }),
      { objects: OBJECTS, databaseName: 'SimCity', familyId: 'f1' },
    )
    expect(read.warnings).toHaveLength(1)
    // Node 2 comes first in the list; node 3 costs more. Cost wins.
    expect(read.warnings[0].objectId).toBe('o1')
  })

  it('falls back to an ancestor when nothing underneath names a table', () => {
    const read = surveyShowplan(
      showplan({
        nodes: [
          node({
            nodeId: 1,
            objectReference: { database: 'SimCity', schema: 'app1', table: 'invoices', index: null },
          }),
          node({ nodeId: 2, parentNodeId: 1, warnings: [{ kind: 'PlanAffectingConvert', detail: null }] }),
        ],
      }),
      { objects: OBJECTS, databaseName: 'SimCity', familyId: 'f1' },
    )
    expect(read.warnings).toHaveLength(1)
    expect(read.warnings[0].objectId).toBe('o2')
  })

  it('reports a warning it cannot place rather than hiding it', () => {
    const read = surveyShowplan(
      showplan({ nodes: [node({ warnings: [{ kind: 'NoJoinPredicate', detail: null }] })] }),
      { objects: OBJECTS, databaseName: 'SimCity', familyId: 'f1' },
    )
    expect(read.warnings).toHaveLength(1)
    expect(read.warnings[0].objectId).toBeNull()
  })
})

describe('mergeDisasterSurvey', () => {
  /*
   * Two families very often resolve to the same compiled plan — a parameterized statement executed
   * from two call sites is two families over one plan. Counting it twice would report two fires on
   * one building and inflate `plansRead`, which is the number the disclosure is computed from.
   */
  it('counts one plan once, however many families led to it', () => {
    const survey = mergeDisasterSurvey(
      [
        evidenceFor({ planId: 'p1', familyId: 'f1', missingIndexes: [{ objectId: 'o1', label: 'app1.orders', impactPercent: 90, familyId: 'f1', planId: 'p1' }] }),
        evidenceFor({ planId: 'p1', familyId: 'f2', missingIndexes: [{ objectId: 'o1', label: 'app1.orders', impactPercent: 90, familyId: 'f2', planId: 'p1' }] }),
      ],
      { status: 'complete', familiesConsidered: 2, familiesWithoutPlan: 0, reason: 'r' },
    )
    expect(survey.plansRead).toBe(1)
    expect(survey.missingIndexes).toHaveLength(1)
  })

  it('reports suggestions as observed when any one plan carried them', () => {
    const survey = mergeDisasterSurvey(
      [
        evidenceFor({ planId: 'p1', missingIndexesObserved: false }),
        evidenceFor({ planId: 'p2', missingIndexesObserved: true }),
      ],
      { status: 'complete', familiesConsidered: 2, familiesWithoutPlan: 0, reason: 'r' },
    )
    expect(survey.missingIndexesObserved).toBe(true)
  })

  it('starts from a survey that claims nothing', () => {
    expect(EMPTY_DISASTER_SURVEY.status).toBe('idle')
    expect(EMPTY_DISASTER_SURVEY.plansRead).toBe(0)
    expect(EMPTY_DISASTER_SURVEY.missingIndexesObserved).toBe(false)
  })
})

describe('runDisasterSurvey', () => {
  const fetchers = (
    plans: Record<string, NormalizedShowplan | Error>,
    details: Record<string, QueryFamilyDetail | Error> = {},
  ) => ({
    fetchQueryFamily: vi.fn(async (familyId: string) => {
      const found = details[familyId] ?? detail([`plan-${familyId}`])
      if (found instanceof Error) throw found
      return found
    }),
    fetchPlan: vi.fn(async (planId: string) => {
      const found = plans[planId]
      if (found === undefined) throw new Error(`no plan ${planId}`)
      if (found instanceof Error) throw found
      return found
    }),
  })

  it('claims nothing when the page ranked no families', async () => {
    const survey = await runDisasterSurvey([], {
      objects: OBJECTS,
      databaseName: 'SimCity',
      fetchers: fetchers({}),
    })
    expect(survey.status).toBe('unavailable')
    expect(survey.plansRead).toBe(0)
    expect(survey.reason).toMatch(/no compiled plan was read/i)
  })

  it('never reads more families than the limit, however many the page ranked', async () => {
    const many = Array.from({ length: DISASTER_SURVEY_FAMILY_LIMIT + 17 }, (_, i) => family(`f${i}`))
    const plans: Record<string, NormalizedShowplan> = {}
    for (const f of many) plans[`plan-${f.familyId}`] = showplan({ planId: `plan-${f.familyId}`, missingIndexes: [] })
    const api = fetchers(plans)

    const survey = await runDisasterSurvey(many, {
      objects: OBJECTS,
      databaseName: 'SimCity',
      fetchers: api,
    })
    expect(survey.familiesConsidered).toBe(DISASTER_SURVEY_FAMILY_LIMIT)
    expect(api.fetchQueryFamily).toHaveBeenCalledTimes(DISASTER_SURVEY_FAMILY_LIMIT)
    expect(survey.plansRead).toBe(DISASTER_SURVEY_FAMILY_LIMIT)
  })

  /*
   * One family failing must not discard the ones either side of it.
   *
   * The survey's entire value is that it is an aggregate: a single unreadable plan taking the whole
   * city's fires down with it would make the layer strictly less reliable than the routed plan it
   * replaced, and it would do so silently, because an empty survey and a clean city look identical
   * from the sidebar.
   */
  it('keeps going when one family has no plan and another cannot be read', async () => {
    const api = fetchers(
      {
        'plan-f1': showplan({ planId: 'plan-f1', missingIndexes: [{ database: 'SimCity', schema: 'app1', table: 'orders', impactPercent: 95, equalityColumns: [], inequalityColumns: [], includedColumns: [] }] }),
        'plan-f3': new Error('Query Store threw'),
        'plan-f4': showplan({ planId: 'plan-f4', missingIndexes: [] }),
      },
      { f2: detail([]) },
    )

    const survey = await runDisasterSurvey(
      [family('f1'), family('f2'), family('f3'), family('f4')],
      { objects: OBJECTS, databaseName: 'SimCity', fetchers: api },
    )

    expect(survey.status).toBe('complete')
    expect(survey.plansRead).toBe(2)
    expect(survey.familiesWithoutPlan).toBe(2)
    expect(survey.familiesConsidered).toBe(4)
    expect(survey.missingIndexes.map(entry => entry.objectId)).toEqual(['o1'])
  })

  it('says so when every family failed, rather than reporting a city with no problems', async () => {
    const api = fetchers({}, { f1: new Error('down'), f2: new Error('down') })
    const survey = await runDisasterSurvey([family('f1'), family('f2')], {
      objects: OBJECTS,
      databaseName: 'SimCity',
      fetchers: api,
    })
    expect(survey.status).toBe('unavailable')
    expect(survey.plansRead).toBe(0)
    expect(survey.missingIndexes).toHaveLength(0)
    expect(survey.reason).not.toMatch(/no disaster/i)
  })

  /*
   * An abort has no result, not a partial one. A survey cancelled because the reader navigated to a
   * different database must not resolve with whatever it happened to have read, because the caller
   * would then apply another database's fires to this city's buildings.
   */
  it('propagates an abort instead of resolving with a partial survey', async () => {
    const controller = new AbortController()
    const api = {
      fetchQueryFamily: vi.fn(async () => {
        controller.abort()
        throw new DOMException('aborted', 'AbortError')
      }),
      fetchPlan: vi.fn(async () => showplan()),
    }
    await expect(runDisasterSurvey([family('f1')], {
      objects: OBJECTS,
      databaseName: 'SimCity',
      fetchers: api,
      signal: controller.signal,
    })).rejects.toThrow(/abort/i)
  })

  /*
   * The same, from the other direction, and this is the case that makes the `AbortError` check
   * load-bearing rather than redundant.
   *
   * The test above aborts a signal the survey is holding, so the `signal?.aborted` guard alone would
   * catch it — mutation testing confirmed that deleting the `AbortError` check left it green. A
   * fetcher can abort for its own reasons without the survey's signal ever being aborted (its own
   * timeout, a shared client tearing down), and in that case only the exception says so. Swallowing
   * it there would count a cancelled fetch as a family with no plan and report a quieter city than
   * was actually read.
   */
  it('propagates an abort raised by the fetcher even when the survey holds no signal', async () => {
    const api = {
      fetchQueryFamily: vi.fn(async () => detail(['plan-f1'])),
      fetchPlan: vi.fn(async () => {
        throw new DOMException('aborted', 'AbortError')
      }),
    }
    await expect(runDisasterSurvey([family('f1')], {
      objects: OBJECTS,
      databaseName: 'SimCity',
      fetchers: api,
    })).rejects.toThrow(/abort/i)
  })

  /*
   * The cache holds the **showplan**, not the evidence read from it.
   *
   * Object ids are resolved against the object list the caller passes, and that list grows as the
   * city pages in. Caching the resolved evidence would freeze each family's answer against however
   * much of the city had arrived the first time it was read, so a table that paged in later could
   * never catch fire no matter how many refreshes ran. This is the test that would have caught that,
   * and it is why the cache type is `CachedSurveyPlan` rather than `PlanDisasterEvidence`.
   */
  it('re-resolves a cached plan against the objects that have since paged in', async () => {
    const cache = new Map<string, CachedSurveyPlan | null>()
    const plan = showplan({
      planId: 'plan-f1',
      missingIndexes: [{ database: 'SimCity', schema: 'app2', table: 'ledger', impactPercent: 88, equalityColumns: [], inequalityColumns: [], includedColumns: [] }],
    })
    const api = fetchers({ 'plan-f1': plan })

    const first = await runDisasterSurvey([family('f1')], {
      objects: OBJECTS,
      databaseName: 'SimCity',
      fetchers: api,
      cache,
    })
    // app2.ledger has not paged in yet, so the suggestion is real but has no building.
    expect(first.missingIndexes[0].objectId).toBeNull()

    const wider = [...OBJECTS, cityObject({ objectId: 'o9', schemaName: 'app2', name: 'ledger' })]
    const second = await runDisasterSurvey([family('f1')], {
      objects: wider,
      databaseName: 'SimCity',
      fetchers: api,
      cache,
    })
    expect(second.missingIndexes[0].objectId).toBe('o9')
    // …and it did so without going back to the network.
    expect(api.fetchPlan).toHaveBeenCalledTimes(1)
  })

  /*
   * A transient failure must never be cached as a negative.
   *
   * A cached `null` is the record of "this family has no plan", and it is deliberately durable. A
   * timeout is not that fact — it is the absence of one — so writing it into the cache would turn a
   * five-second network blip into a family that is permanently unreadable for the life of the page.
   */
  it('retries a family whose plan fetch failed, rather than remembering the failure', async () => {
    const cache = new Map<string, CachedSurveyPlan | null>()
    let attempt = 0
    const api = {
      fetchQueryFamily: vi.fn(async () => detail(['plan-f1'])),
      fetchPlan: vi.fn(async () => {
        attempt += 1
        if (attempt === 1) throw new Error('timeout')
        return showplan({
          planId: 'plan-f1',
          missingIndexes: [{ database: 'SimCity', schema: 'app1', table: 'orders', impactPercent: 77, equalityColumns: [], inequalityColumns: [], includedColumns: [] }],
        })
      }),
    }

    const first = await runDisasterSurvey([family('f1')], {
      objects: OBJECTS, databaseName: 'SimCity', fetchers: api, cache,
    })
    expect(first.plansRead).toBe(0)
    expect(cache.has('f1')).toBe(false)

    const second = await runDisasterSurvey([family('f1')], {
      objects: OBJECTS, databaseName: 'SimCity', fetchers: api, cache,
    })
    expect(second.plansRead).toBe(1)
    expect(second.missingIndexes[0].objectId).toBe('o1')
  })

  it('remembers that a family genuinely has no plan, and does not ask twice', async () => {
    const cache = new Map<string, CachedSurveyPlan | null>()
    const api = fetchers({}, { f1: detail([]) })

    await runDisasterSurvey([family('f1')], { objects: OBJECTS, databaseName: 'SimCity', fetchers: api, cache })
    await runDisasterSurvey([family('f1')], { objects: OBJECTS, databaseName: 'SimCity', fetchers: api, cache })

    expect(cache.get('f1')).toBeNull()
    expect(api.fetchQueryFamily).toHaveBeenCalledTimes(1)
  })

  /*
   * A dispatcher plan is a routing shell with no operator tree, so reading it finds no warnings at
   * all. Query Store lists it alongside the plan that actually ran, and taking the first one in the
   * list would quietly survey the empty shell for any parameter-sensitive query.
   */
  it('prefers the plan whose runtime was counted over a dispatcher shell', async () => {
    const api = fetchers(
      { runtime: showplan({ planId: 'runtime', missingIndexes: [] }) },
      {
        f1: {
          plans: [
            { planId: 'dispatcher', runtimeCounted: false },
            { planId: 'runtime', runtimeCounted: true },
          ],
        } as unknown as QueryFamilyDetail,
      },
    )
    await runDisasterSurvey([family('f1')], { objects: OBJECTS, databaseName: 'SimCity', fetchers: api })
    expect(api.fetchPlan).toHaveBeenCalledWith('runtime', undefined)
  })

  it('reports progress while it runs so the sidebar is never silently blank', async () => {
    const api = fetchers({
      'plan-f1': showplan({ planId: 'plan-f1', missingIndexes: [] }),
      'plan-f2': showplan({ planId: 'plan-f2', missingIndexes: [] }),
    })
    const seen: string[] = []
    await runDisasterSurvey([family('f1'), family('f2')], {
      objects: OBJECTS,
      databaseName: 'SimCity',
      fetchers: api,
      onProgress: survey => seen.push(survey.status),
    })
    expect(seen.filter(status => status === 'running').length).toBeGreaterThan(0)
    expect(seen[seen.length - 1]).toBe('complete')
  })
})
