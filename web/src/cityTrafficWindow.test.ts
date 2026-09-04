import { describe, expect, it } from 'vitest'
import { familyTrafficMeasurement, sameTrafficWindow, trafficBasis, trafficInteger } from './cityTrafficWindow'
import type { DatabaseCityQueryFamily, DatabaseCityRecentActivity } from './databaseCityContracts'

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

function family(recentActivity?: DatabaseCityRecentActivity | null): DatabaseCityQueryFamily {
  return {
    familyId: 'f1', queryHash: '0x00', objectIds: ['a', 'b'], executionCount: '1000',
    totalWaitMilliseconds: '1000000', totalDurationMicroseconds: '1000000',
    totalCpuMicroseconds: '0', totalLogicalReads8KiBPages: '0', waitMillisecondsByCategory: { Lock: '1000000' },
    confidence: 'Probable', rationale: 'test',
    evidence: { source: 'QueryStoreAggregate', status: 'Available', reason: 'test', observedAt: null, freshUntil: null },
    recentActivity,
  }
}

describe('shared traffic window projection', () => {
  it('uses retained history only when no recent window exists anywhere', () => {
    const archive = family()
    expect(trafficBasis([archive, family(null)]).kind).toBe('retained')
    expect(familyTrafficMeasurement(archive).waitMilliseconds).toBe(1000000n)
    const basis = trafficBasis([archive, family(recent())])
    const missing = familyTrafficMeasurement(archive, basis)
    expect(missing.covered).toBe(false)
    expect(missing.executions).toBeNull()
    expect(missing.waitMilliseconds).toBeNull()
    expect(missing.categories).toBeNull()
    expect(missing.quiet).toBe(false)
  })

  it('does not let malformed published window bounds enable retained fallback', () => {
    const sample = family(recent({ windowStart: 'bad' }))
    const basis = trafficBasis([sample])
    expect(basis).toEqual({ kind: 'recent', window: null })
    expect(familyTrafficMeasurement(sample, basis).covered).toBe(false)
  })

  it('chooses the latest window independently of family order and rejects other windows', () => {
    const old = family(recent({ windowStart: '2024-05-01T00:30:00Z', windowEnd: '2024-05-01T00:45:00Z' }))
    const current = family(recent())
    const basis = trafficBasis([old, current])
    expect(basis).toEqual(trafficBasis([current, old]))
    expect(familyTrafficMeasurement(old, basis).covered).toBe(false)
    expect(familyTrafficMeasurement(current, basis).quiet).toBe(true)
  })

  it('compares instants rather than timestamp spelling when merging a window', () => {
    expect(sameTrafficWindow(recent(), recent({
      windowStart: '2024-05-01T00:45:00.000+00:00', windowEnd: '2024-05-01T01:00:00.000+00:00',
    }))).toBe(true)
    expect(sameTrafficWindow(recent(), recent({ windowMinutes: 30 }))).toBe(false)
  })

  it('keeps the chosen basis independent of same-window family order and counters', () => {
    const a = family(recent())
    const b = family(recent({ executionCount: '20', totalWaitMilliseconds: '100' }))
    expect(trafficBasis([a, b])).toEqual(trafficBasis([b, a]))
    expect(Object.keys(trafficBasis([a, b]).window!).sort())
      .toEqual(['windowEnd', 'windowMinutes', 'windowStart'])
  })

  it.each([undefined, null, '', ' ', '-1', '1.5', '1e3', '0x10', 'NaN', 'Infinity'])(
    'strictly rejects malformed integer %j without substituting zero', value => {
      expect(trafficInteger(value)).toBeNull()
    },
  )

  it('keeps exact values above Number.MAX_SAFE_INTEGER', () => {
    expect(trafficInteger('900719925474099312345')).toBe(900719925474099312345n)
  })

  it('requires coverage as well as zero counts to claim a quiet measurement', () => {
    expect(familyTrafficMeasurement(family(recent())).quiet).toBe(true)
    expect(familyTrafficMeasurement(family(recent({ covered: false }))).quiet).toBe(false)
    expect(familyTrafficMeasurement(family(recent({ executionCount: 'bad' }))).quiet).toBe(false)
    expect(familyTrafficMeasurement(family(recent({ totalWaitMilliseconds: '1' }))).quiet).toBe(false)
  })

  it.each(['0', '10'])('does not infer wait capture from runtime-covered executions %s', executionCount => {
    const sample = familyTrafficMeasurement(family(recent({
      executionCount, totalWaitMilliseconds: '0', waitAttribution: null, waitMillisecondsByCategory: null,
    })))
    expect(sample.executions).toBe(BigInt(executionCount))
    expect(sample.waitMilliseconds).toBeNull()
    expect(sample.covered).toBe(false)
    expect(sample.quiet).toBe(false)
    expect(sample.attribution).toBeNull()
  })

  it('treats omitted recent wait metadata as unknown while a captured empty split is measured', () => {
    const missing = familyTrafficMeasurement(family(recent({
      waitAttribution: undefined, waitMillisecondsByCategory: undefined,
    })))
    expect(missing.waitMilliseconds).toBeNull()
    expect(missing.quiet).toBe(false)
    const captured = familyTrafficMeasurement(family(recent({
      executionCount: '2', totalWaitMilliseconds: '120',
    })))
    expect(captured.waitMilliseconds).toBe(120n)
    expect(captured.covered).toBe(true)
    expect(captured.attribution!.objects).toEqual([])
    expect(captured.attribution!.unattributedWaitMilliseconds).toBe('120')
  })
})
