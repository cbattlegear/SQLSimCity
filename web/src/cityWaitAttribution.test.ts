import { describe, expect, it } from 'vitest'
import { attributedWaits, familyCostShares, familyWaitByObject } from './cityWaitAttribution'
import type { DatabaseCityQueryFamily, DatabaseCityRecentActivity, DatabaseCityWaitAttribution } from './databaseCityContracts'
import type { Evidence } from './contracts'

const evidence: Evidence = {
  source: 'QueryStoreAggregate',
  status: 'Available',
  observedAt: null,
  freshUntil: null,
  reason: 'test',
}

function attribution(
  objects: Array<[string, number, string]>,
  unattributed = '0',
): DatabaseCityWaitAttribution {
  return {
    objects: objects.map(([objectId, estimatedCostShare, waitMilliseconds]) => ({
      objectId,
      estimatedCostShare,
      waitMilliseconds,
    })),
    unattributedWaitMilliseconds: unattributed,
    plansRead: 1,
    rationale: 'test',
  }
}

function family(
  familyId: string,
  totalWaitMilliseconds: string,
  waitAttribution: DatabaseCityWaitAttribution | null = null,
  objectIds: string[] = [],
): DatabaseCityQueryFamily {
  return {
    familyId,
    queryHash: '0x00',
    executionCount: '10',
    totalCpuMicroseconds: '0',
    totalDurationMicroseconds: '0',
    totalLogicalReads8KiBPages: '0',
    totalWaitMilliseconds,
    waitMillisecondsByCategory: {},
    objectIds,
    confidence: 'Confirmed',
    rationale: 'test',
    evidence,
    waitAttribution,
  }
}

function recent(overrides: Partial<DatabaseCityRecentActivity> = {}): DatabaseCityRecentActivity {
  const wait = overrides.totalWaitMilliseconds ?? '0'
  return {
    windowMinutes: 15, windowStart: '2024-05-01T00:45:00Z', windowEnd: '2024-05-01T01:00:00Z',
    covered: true, executionCount: '0', totalDurationMicroseconds: '0', totalWaitMilliseconds: '0',
    waitAttribution: { objects: [], unattributedWaitMilliseconds: wait, plansRead: 0, rationale: 'No usable plan' },
    waitMillisecondsByCategory: { CPU: wait },
    rationale: 'test', ...overrides,
  }
}

describe('familyWaitByObject', () => {
  it('is empty when the family carries no attribution', () => {
    expect(familyWaitByObject(family('f1', '100')).size).toBe(0)
  })

  it('is empty when the attribution reached no object', () => {
    expect(familyWaitByObject(family('f1', '100', attribution([], '100'))).size).toBe(0)
  })

  it('reads each object\u2019s apportioned milliseconds', () => {
    const waits = familyWaitByObject(
      family('f1', '100', attribution([['object:1', 0.75, '75'], ['object:2', 0.25, '25']])),
    )
    expect(waits.get('object:1')).toBe(75n)
    expect(waits.get('object:2')).toBe(25n)
  })

  it('keeps very large totals exact', () => {
    const huge = '123456789012345678901234'
    const waits = familyWaitByObject(family('f1', huge, attribution([['object:1', 1, huge]])))
    expect(waits.get('object:1')).toBe(BigInt(huge))
  })

  it('ignores a malformed figure rather than throwing', () => {
    const waits = familyWaitByObject(family('f1', '100', attribution([['object:1', 1, 'not-a-number']])))
    expect(waits.size).toBe(0)
  })
})

describe('familyCostShares', () => {
  it('reads the estimated share the split placed on each object', () => {
    const shares = familyCostShares(
      family('f1', '100', attribution([['object:1', 0.8, '80'], ['object:2', 0.2, '20']])),
    )
    expect(shares.get('object:1')).toBeCloseTo(0.8, 9)
    expect(shares.get('object:2')).toBeCloseTo(0.2, 9)
  })
})

describe('attributedWaits', () => {
  it('reports nothing for an empty page', () => {
    const totals = attributedWaits([])
    expect(totals.byObject.size).toBe(0)
    expect(totals.note).toContain('No ranked query family')
  })

  it('sums one building\u2019s share across every family that named it', () => {
    const totals = attributedWaits([
      family('f1', '100', attribution([['object:1', 0.5, '50'], ['object:2', 0.5, '50']])),
      family('f2', '40', attribution([['object:1', 1, '40']])),
    ])
    expect(totals.byObject.get('object:1')!.milliseconds).toBe(90n)
    expect(totals.byObject.get('object:1')!.familyIds).toEqual(['f1', 'f2'])
    expect(totals.byObject.get('object:2')!.milliseconds).toBe(50n)
  })

  it('reconciles: every part plus the remainder equals the measured total', () => {
    const families = [
      family('f1', '100', attribution([['object:1', 0.6, '55'], ['object:2', 0.4, '37']], '8')),
      family('f2', '40', attribution([['object:1', 1, '31']], '9')),
    ]
    const totals = attributedWaits(families)
    let placed = 0n
    for (const entry of totals.byObject.values()) placed += entry.milliseconds
    expect(placed + totals.unattributed).toBe(totals.measured)
    expect(totals.measured).toBe(140n)
  })

  it('treats a family with no attribution as wholly unplaced, never as zero wait', () => {
    const totals = attributedWaits([family('f1', '250')])
    expect(totals.byObject.size).toBe(0)
    expect(totals.unattributed).toBe(250n)
    expect(totals.measured).toBe(250n)
    expect(totals.apportioned).toBe(0)
  })

  it('moves a share for a building this page does not draw into the remainder', () => {
    const totals = attributedWaits(
      [family('f1', '100', attribution([['object:1', 0.5, '50'], ['object:off', 0.5, '50']]))],
      new Set(['object:1']),
    )
    expect(totals.byObject.size).toBe(1)
    expect(totals.byObject.get('object:1')!.milliseconds).toBe(50n)
    expect(totals.unattributed).toBe(50n)
    let placed = 0n
    for (const entry of totals.byObject.values()) placed += entry.milliseconds
    expect(placed + totals.unattributed).toBe(totals.measured)
  })

  it('says plainly that the split is estimated and the milliseconds are not', () => {
    const totals = attributedWaits([family('f1', '100', attribution([['object:1', 1, '100']]))])
    expect(totals.note).toContain('measured')
    expect(totals.note).toContain('cost estimate')
  })

  it('uses recent apportionment exactly while leaving cost shares historical', () => {
    const huge = 123456789012345678901234n
    const sample = {
      ...family('f1', '1000', attribution([['a', 0.9, '900'], ['b', 0.1, '100']])),
      recentActivity: recent({
        executionCount: '2', totalWaitMilliseconds: String(huge),
        waitAttribution: attribution([['a', 0.1, '3'], ['b', 0.9, '7']], String(huge - 10n)),
      }),
    }
    expect(familyWaitByObject(sample)).toEqual(new Map([['a', 3n], ['b', 7n]]))
    expect(familyCostShares(sample)).toEqual(new Map([['a', 0.9], ['b', 0.1]]))
    const totals = attributedWaits([sample], new Set(['a']))
    expect(totals.measured).toBe(huge)
    expect(totals.byObject.get('a')!.milliseconds).toBe(3n)
    expect(totals.unattributed).toBe(huge - 3n)
    expect(totals.byObject.get('a')!.milliseconds + totals.unattributed).toBe(totals.measured)
    expect(totals.note).toContain('Recent window')
  })

  it.each(['1000', '9007199254740993'])('leaves recent waits %s wholly unplaced when only retained allocation exists', total => {
    const totals = attributedWaits([{
      ...family('f1', '1000', attribution([['a', 1, '1000']])),
      recentActivity: recent({ executionCount: '2', totalWaitMilliseconds: total, waitAttribution: undefined }),
    }])
    expect(totals.byObject.size).toBe(0)
    expect(totals.measured).toBe(BigInt(total))
    expect(totals.unattributed).toBe(totals.measured)
  })

  it('never falls back to retained waits for a missing family in a recent aggregate', () => {
    const totals = attributedWaits([
      family('missing', '1000', attribution([['a', 1, '1000']])),
      { ...family('quiet', '2000'), recentActivity: recent() },
    ])
    expect(totals.basis.kind).toBe('recent')
    expect(totals.byObject.size).toBe(0)
    expect(totals.measured).toBe(0n)
    expect(totals.unknownFamilyIds).toEqual(['missing'])
    expect(totals.note).toContain('unknown waits are not zero')
  })

  it('counts uncovered or malformed recent totals as unknown rather than zero measurements', () => {
    const totals = attributedWaits([
      { ...family('uncovered', '100'), recentActivity: recent({ covered: false }) },
      { ...family('malformed', '100'), recentActivity: recent({ totalWaitMilliseconds: 'bad' }) },
    ])
    expect(totals.unknownFamilyIds).toEqual(['uncovered', 'malformed'])
    expect(totals.byObject.size).toBe(0)
  })

  it.each([
    attribution([['a', 1, 'bad']], '0'),
    attribution([['a', 1, '-1']], '11'),
    attribution([['a', 1, '20']], '0'),
    attribution([['a', 1, '5']], '0'),
    attribution([['a', Number.NaN, '10']], '0'),
    attribution([['a', -0.5, '10']], '0'),
    attribution([['a', 1.5, '10']], '0'),
  ])('keeps malformed or non-reconciling recent attribution wholly unplaced', split => {
    const totals = attributedWaits([{
      ...family('f1', '100'), recentActivity: recent({
        executionCount: '1', totalWaitMilliseconds: '10', waitAttribution: split,
      }),
    }])
    expect(totals.byObject.size).toBe(0)
    expect(totals.unattributed).toBe(10n)
    expect(totals.measured).toBe(10n)
  })

  it('distinguishes missing recent wait capture from captured waits whose plan could not be placed', () => {
    const totals = attributedWaits([
      { ...family('runtime-only', '1000'), recentActivity: recent({
        executionCount: '10', totalWaitMilliseconds: '0', waitAttribution: null, waitMillisecondsByCategory: null,
      }) },
      { ...family('captured-unplaced', '1000'), recentActivity: recent({
        executionCount: '2', totalWaitMilliseconds: '120',
      }) },
    ])
    expect(totals.unknownFamilyIds).toEqual(['runtime-only'])
    expect(totals.byObject.size).toBe(0)
    expect(totals.apportioned).toBe(0)
    expect(totals.measured).toBe(120n)
    expect(totals.unattributed).toBe(120n)
  })
})
