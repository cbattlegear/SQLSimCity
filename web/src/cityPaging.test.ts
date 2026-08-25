import { describe, expect, it } from 'vitest'
import { mergeCityPage } from './cityPaging'
import type {
  DatabaseCityObject,
  DatabaseCityPage,
  DatabaseCityQueryFamily,
  DatabaseCityRoute,
  DatabaseCitySchema,
  DatabaseCityWaitAttribution,
} from './databaseCityContracts'
import type { Evidence } from './contracts'

const evidence: Evidence = {
  source: 'CatalogSnapshot',
  status: 'Available',
  observedAt: null,
  freshUntil: null,
  reason: 'test',
}

function object(objectId: string, schemaId: string): DatabaseCityObject {
  return {
    objectId,
    schemaId,
    schemaName: schemaId,
    name: objectId,
    kind: 'Table',
    reservedPages8KiB: '8',
    usedPages8KiB: '4',
    reservedBytes: String(8n * 8192n),
    usedBytes: String(4n * 8192n),
    sizeStatus: 'Known',
    sizeReason: null,
    layout: { neighborhoodOrdinal: 0, objectOrdinal: 0, x: 0, z: 0 },
    indexes: [],
    directActivity: { totalOperations: '1', resetEpochToken: null, evidence },
    attributedExposure: {
      executionCount: null,
      totalCpuMicroseconds: null,
      totalDurationMicroseconds: null,
      totalLogicalReads8KiBPages: null,
      confidence: 'Unknown',
      rationale: 'test',
      evidence,
    },
  }
}

function route(routeId: string, from: string, to: string): DatabaseCityRoute {
  return {
    routeId,
    fromObjectId: from,
    toId: to,
    kind: 'ObjectReference',
    confidence: 'Confirmed',
    rationale: 'test',
    evidence,
  }
}

function schema(schemaId: string, ordinal: number, count: string): DatabaseCitySchema {
  return { schemaId, name: schemaId, neighborhoodOrdinal: ordinal, objectCount: count, evidence }
}

function family(
  familyId: string,
  objectIds: string[],
  overrides: Partial<DatabaseCityQueryFamily> = {},
): DatabaseCityQueryFamily {
  return {
    familyId,
    queryHash: `0x${familyId}`,
    executionCount: '10',
    totalCpuMicroseconds: '100',
    totalDurationMicroseconds: '200',
    totalLogicalReads8KiBPages: '30',
    totalWaitMilliseconds: '90',
    waitMillisecondsByCategory: {},
    objectIds,
    confidence: objectIds.length === 1 ? 'Confirmed' : objectIds.length > 1 ? 'Probable' : 'Unknown',
    rationale: 'named on this page',
    evidence,
    ...overrides,
  }
}

function waitAttribution(
  shares: Array<[string, string]>,
  totalWaitMilliseconds: string,
  plansRead: number,
): DatabaseCityWaitAttribution {
  const sum = shares.reduce((running, [, ms]) => running + BigInt(ms), 0n)
  return {
    objects: shares.map(([objectId, waitMilliseconds]) => ({
      objectId,
      estimatedCostShare: 0.5,
      waitMilliseconds,
    })),
    unattributedWaitMilliseconds: String(BigInt(totalWaitMilliseconds) - sum),
    plansRead,
    rationale: 'split by estimated cost',
  }
}

function page(overrides: Partial<DatabaseCityPage> = {}): DatabaseCityPage {
  return {
    schemaVersion: '1.0',
    databaseId: 'db',
    databaseName: 'sales',
    metric: 'Cpu',
    pageSize: 50,
    nextPageToken: null,
    totalObjects: '4',
    schemas: [],
    objects: [],
    topQueryFamilies: [],
    otherWorkload: {
      familyCount: null,
      executionCount: null,
      totalCpuMicroseconds: null,
      totalDurationMicroseconds: null,
      totalLogicalReads8KiBPages: null,
      totalWaitMilliseconds: null,
      evidence,
    },
    routes: [],
    evidence,
    ...overrides,
  }
}

describe('mergeCityPage', () => {
  it('keeps the routes an earlier page carried when a later page carries none', () => {
    // The bug this exists for: co-references are reported per page, so a database whose routes all
    // sit among the first fifty objects returns an empty `routes` on page two. Replacing the page
    // wholesale erased every road ribbon the moment a second page landed.
    const first = page({
      nextPageToken: 'cursor',
      objects: [object('a', 's1'), object('b', 's1')],
      routes: [route('r1', 'a', 'b')],
    })
    const second = page({ objects: [object('c', 's1')], routes: [] })

    const merged = mergeCityPage(first, second)

    expect(merged.routes.map(item => item.routeId)).toEqual(['r1'])
    expect(merged.objects.map(item => item.objectId)).toEqual(['a', 'b', 'c'])
    expect(merged.nextPageToken).toBeNull()
  })

  it('sums per-page schema counts into the database-wide count the layout needs', () => {
    // `page.schemas` counts that page's objects, not the schema's. The city is laid out from these
    // counts, so they have to accumulate or a neighbourhood is sized for a fraction of its tables.
    const first = page({
      nextPageToken: 'cursor',
      objects: [object('a', 's1'), object('b', 's2')],
      schemas: [schema('s1', 0, '1'), schema('s2', 1, '1')],
    })
    const second = page({
      objects: [object('c', 's2'), object('d', 's3')],
      schemas: [schema('s2', 1, '1'), schema('s3', 2, '1')],
    })

    const merged = mergeCityPage(first, second)

    expect(merged.schemas.map(item => `${item.schemaId}:${item.objectCount}`))
      .toEqual(['s1:1', 's2:2', 's3:1'])
  })

  it('is idempotent, so a repeated page never doubles a count', () => {
    const first = page({
      nextPageToken: 'cursor',
      objects: [object('a', 's1')],
      schemas: [schema('s1', 0, '1')],
      routes: [route('r1', 'a', 'a')],
    })

    const once = mergeCityPage(first, first)
    const twice = mergeCityPage(once, first)

    expect(once.schemas.map(item => item.objectCount)).toEqual(['1'])
    expect(twice.schemas.map(item => item.objectCount)).toEqual(['1'])
    expect(twice.objects).toHaveLength(1)
    expect(twice.routes).toHaveLength(1)
  })

  it('takes database-wide fields from the newer page and never loses the total', () => {
    const first = page({ nextPageToken: 'cursor', totalObjects: '9' })
    const second = page({ totalObjects: null, databaseName: 'sales' })

    const merged = mergeCityPage(first, second)

    expect(merged.totalObjects).toBe('9')
    expect(merged.databaseName).toBe('sales')
  })

  it('unions a family\'s object ids across pages so a plan keeps every table it touched', () => {
    // The bug this exists for: a family's references are resolved against only the current page's
    // objects, so each page names a different subset. Taking the newest page wholesale left the
    // family carrying just the last page's ids — the "no loaded object named" the user saw.
    const first = page({ nextPageToken: 'cursor', topQueryFamilies: [family('f1', ['b', 'a'])] })
    const second = page({ topQueryFamilies: [family('f1', ['c', 'a'])] })

    const merged = mergeCityPage(first, second)

    expect(merged.topQueryFamilies).toHaveLength(1)
    // Deduplicated and sorted so the result does not depend on which page arrived first.
    expect(merged.topQueryFamilies[0].objectIds).toEqual(['a', 'b', 'c'])
  })

  it('is idempotent for families, so a repeated page changes neither ids nor rationale', () => {
    const first = page({
      nextPageToken: 'cursor',
      topQueryFamilies: [family('f1', ['a', 'b'], { confidence: 'Probable' })],
    })

    const once = mergeCityPage(first, first)
    const twice = mergeCityPage(once, first)

    expect(twice.topQueryFamilies[0].objectIds).toEqual(['a', 'b'])
    // Re-folding must not stack the merge note onto the rationale.
    expect(twice.topQueryFamilies[0].rationale).toBe(once.topQueryFamilies[0].rationale)
  })

  it('unions wait shares while keeping the exact sum invariant the contract states', () => {
    const first = page({
      nextPageToken: 'cursor',
      topQueryFamilies: [family('f1', ['a'], {
        totalWaitMilliseconds: '90',
        waitAttribution: waitAttribution([['a', '30']], '90', 2),
      })],
    })
    const second = page({
      topQueryFamilies: [family('f1', ['b'], {
        totalWaitMilliseconds: '90',
        waitAttribution: waitAttribution([['b', '40']], '90', 5),
      })],
    })

    const merged = mergeCityPage(first, second)
    const attribution = merged.topQueryFamilies[0].waitAttribution!

    expect(attribution.objects.map(share => share.objectId).sort()).toEqual(['a', 'b'])
    expect(attribution.plansRead).toBe(5)
    // parts + unattributed === total, checked in BigInt so no float rounding can hide a drift.
    const parts = attribution.objects.reduce((sum, share) => sum + BigInt(share.waitMilliseconds), 0n)
    expect(parts + BigInt(attribution.unattributedWaitMilliseconds)).toBe(90n)
    expect(attribution.unattributedWaitMilliseconds).toBe('20')
  })

  it('downgrades confidence to Probable once the union names more than one object', () => {
    const first = page({
      nextPageToken: 'cursor',
      topQueryFamilies: [family('f1', ['a'], { confidence: 'Confirmed' })],
    })
    const second = page({ topQueryFamilies: [family('f1', ['b'], { confidence: 'Confirmed' })] })

    const merged = mergeCityPage(first, second)

    // A total the plan spread across two buildings belongs to no single one, so it can only be Probable.
    expect(merged.topQueryFamilies[0].confidence).toBe('Probable')
  })

  it('keeps a single-object union at the confidence of the page that named it', () => {
    const first = page({
      nextPageToken: 'cursor',
      topQueryFamilies: [family('f1', ['a'], { confidence: 'Confirmed' })],
    })
    const second = page({ topQueryFamilies: [family('f1', [], { confidence: 'Unknown' })] })

    const merged = mergeCityPage(first, second)

    expect(merged.topQueryFamilies[0].objectIds).toEqual(['a'])
    expect(merged.topQueryFamilies[0].confidence).toBe('Confirmed')
  })

  it('retains a family only an earlier page carried, appended after the newest ranking', () => {
    const first = page({
      nextPageToken: 'cursor',
      topQueryFamilies: [family('f1', ['a']), family('f2', ['b'])],
    })
    const second = page({ topQueryFamilies: [family('f1', ['c'])] })

    const merged = mergeCityPage(first, second)

    // f1 keeps the newest page's slot; f2, which only page one carried, survives appended after.
    expect(merged.topQueryFamilies.map(item => item.familyId)).toEqual(['f1', 'f2'])
  })
})
