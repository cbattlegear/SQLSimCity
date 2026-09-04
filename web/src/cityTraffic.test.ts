import { describe, expect, it } from 'vitest'
import type { Evidence } from './contracts'
import type { DatabaseCityQueryFamily, DatabaseCityRoute } from './databaseCityContracts'
import {
  CONGESTION_COLORS,
  CONGESTION_GRADES,
  CONGESTION_LABELS,
  HEAVY_DELAY_MS_PER_EXECUTION,
  MODERATE_DELAY_MS_PER_EXECUTION,
  ROAD_WIDTH,
  SEVERE_DELAY_MS_PER_EXECUTION,
  confidencePattern,
  congestionFromDelay,
  describeTrafficWindow,
  gradeRoads,
  roadDelay,
  roadVolume,
  waitShare,
} from './cityTraffic'

const evidence: Evidence = {
  source: 'QueryStoreAggregate',
  status: 'Available',
  observedAt: '2024-05-01T00:00:00Z',
  freshUntil: null,
  reason: 'test',
}

function family(overrides: Partial<DatabaseCityQueryFamily> & { familyId: string }): DatabaseCityQueryFamily {
  return {
    queryHash: '0x00',
    executionCount: '0',
    totalCpuMicroseconds: '0',
    totalDurationMicroseconds: '0',
    totalLogicalReads8KiBPages: '0',
    totalWaitMilliseconds: '0',
    waitMillisecondsByCategory: {},
    objectIds: [],
    confidence: 'Confirmed',
    rationale: 'test',
    evidence,
    ...overrides,
  }
}

function route(overrides: Partial<DatabaseCityRoute> & { routeId: string }): DatabaseCityRoute {
  return {
    fromObjectId: 'a',
    toId: 'b',
    kind: 'ObjectReference',
    confidence: 'Confirmed',
    rationale: 'test',
    evidence,
    ...overrides,
  }
}

describe('roadVolume', () => {
  it('sums executions only from families naming both endpoints', () => {
    const families = [
      family({ familyId: 'qf:1', objectIds: ['a', 'b'], executionCount: '100' }),
      family({ familyId: 'qf:2', objectIds: ['a', 'b', 'c'], executionCount: '50' }),
      family({ familyId: 'qf:3', objectIds: ['a', 'c'], executionCount: '9999' }),
    ]
    const result = roadVolume({ fromObjectId: 'a', toId: 'b' }, families)
    expect(result.executions).toBe(150)
    expect(result.familyIds).toEqual(['qf:1', 'qf:2'])
  })

  it('reports null rather than zero when nothing names the pair', () => {
    const result = roadVolume({ fromObjectId: 'a', toId: 'b' }, [
      family({ familyId: 'qf:1', objectIds: ['c', 'd'], executionCount: '10' }),
    ])
    expect(result.executions).toBeNull()
    expect(result.familyIds).toEqual([])
  })
})

describe('roadWidth', () => {
  /**
   * Width is no longer a channel. It carried executions on a log2 scale and competed with colour for
   * the same ribbon, so every road is now drawn at one width and the executions live in the record,
   * the rationale and the evidence tables instead.
   */
  it('draws every road at one width regardless of traffic', () => {
    const families = [
      family({ familyId: 'qf:hot', objectIds: ['a', 'b'], executionCount: '1000000' }),
      family({ familyId: 'qf:cool', objectIds: ['c', 'd'], executionCount: '1' }),
    ]
    const graded = gradeRoads(
      [route({ routeId: 'r:hot' }), route({ routeId: 'r:cool', fromObjectId: 'c', toId: 'd' })],
      families,
    )
    expect(graded[0].width).toBe(ROAD_WIDTH)
    expect(graded[1].width).toBe(ROAD_WIDTH)
  })

  /** Inside the old 2.2--11 range, so no road got thinner or thicker than one that used to exist. */
  it('sits inside the range the old scale spanned', () => {
    expect(ROAD_WIDTH).toBeGreaterThanOrEqual(2.2)
    expect(ROAD_WIDTH).toBeLessThanOrEqual(11)
  })

  /** Dropping width as a channel must not drop the measurement it used to carry. */
  it('still reports the executions width used to encode', () => {
    const [graded] = gradeRoads(
      [route({ routeId: 'r:hot' })],
      [family({ familyId: 'qf:hot', objectIds: ['a', 'b'], executionCount: '1234' })],
    )
    expect(graded.executions).toBe(1234)
    expect(graded.rationale).toContain('1,234')
  })
})

describe('waitShare', () => {
  it('converts microsecond duration to milliseconds before dividing', () => {
    // 250 ms waiting out of 1,000,000 microseconds (= 1000 ms) of duration.
    const share = waitShare([
      family({ familyId: 'qf:1', totalWaitMilliseconds: '250', totalDurationMicroseconds: '1000000' }),
    ])
    expect(share).toBeCloseTo(0.25, 10)
  })

  it('returns null when duration is unmeasured', () => {
    expect(waitShare([])).toBeNull()
    expect(
      waitShare([family({ familyId: 'qf:1', totalWaitMilliseconds: '5', totalDurationMicroseconds: '0' })]),
    ).toBeNull()
  })

  it('treats a zero wait total as a real measurement of zero', () => {
    const share = waitShare([
      family({ familyId: 'qf:1', totalWaitMilliseconds: '0', totalDurationMicroseconds: '5000' }),
    ])
    expect(share).toBe(0)
  })
})

describe('roadDelay', () => {
  it('divides captured waiting by captured executions', () => {
    const delay = roadDelay([
      family({ familyId: 'qf:1', totalWaitMilliseconds: '250', executionCount: '100' }),
      family({ familyId: 'qf:2', totalWaitMilliseconds: '250', executionCount: '100' }),
    ])
    expect(delay).toBeCloseTo(2.5, 10)
  })

  it('returns null rather than zero when nothing reported waiting', () => {
    expect(roadDelay([])).toBeNull()
    expect(roadDelay([family({ familyId: 'qf:1', totalWaitMilliseconds: '', executionCount: '10' })]))
      .toBeNull()
  })

  it('returns null when no execution was captured, rather than dividing by zero', () => {
    expect(roadDelay([family({ familyId: 'qf:1', totalWaitMilliseconds: '50', executionCount: '0' })]))
      .toBeNull()
  })

  it('treats a captured zero wait as a real measurement of free-flowing', () => {
    const delay = roadDelay([
      family({ familyId: 'qf:1', totalWaitMilliseconds: '0', executionCount: '10' }),
    ])
    expect(delay).toBe(0)
    expect(congestionFromDelay(delay)).toBe('free')
  })
})

describe('congestionFromDelay', () => {
  it('grades on the documented thresholds, inclusive at the boundary', () => {
    expect(congestionFromDelay(0)).toBe('free')
    expect(congestionFromDelay(MODERATE_DELAY_MS_PER_EXECUTION - 0.0001)).toBe('free')
    expect(congestionFromDelay(MODERATE_DELAY_MS_PER_EXECUTION)).toBe('moderate')
    expect(congestionFromDelay(HEAVY_DELAY_MS_PER_EXECUTION - 0.0001)).toBe('moderate')
    expect(congestionFromDelay(HEAVY_DELAY_MS_PER_EXECUTION)).toBe('heavy')
    expect(congestionFromDelay(SEVERE_DELAY_MS_PER_EXECUTION - 0.0001)).toBe('heavy')
    expect(congestionFromDelay(SEVERE_DELAY_MS_PER_EXECUTION)).toBe('severe')
    expect(congestionFromDelay(1e9)).toBe('severe')
  })

  /**
   * The two upper cut points are the ones this codebase has graded street load by since it was first
   * drawn. Splitting the bottom band must not move them, or a road that was red yesterday goes amber
   * today for no measured reason.
   */
  it('keeps the pre-existing 5 ms and 50 ms cut points', () => {
    expect(HEAVY_DELAY_MS_PER_EXECUTION).toBe(5)
    expect(SEVERE_DELAY_MS_PER_EXECUTION).toBe(50)
  })

  it('never claims "free" for missing or non-finite evidence', () => {
    expect(congestionFromDelay(null)).toBe('unknown')
    expect(congestionFromDelay(Number.NaN)).toBe('unknown')
    expect(congestionFromDelay(Number.POSITIVE_INFINITY)).toBe('unknown')
  })
})

/**
 * Four measured bands plus an off-scale one, every band with its own colour and its own words.
 *
 * A ladder with two bands sharing a hue is a ladder with three bands wearing four names, and the
 * legend would then be describing a distinction the map cannot draw.
 */
describe('the congestion ladder', () => {
  it('has four measured bands and one that is off the scale', () => {
    expect(CONGESTION_GRADES).toEqual(['free', 'moderate', 'heavy', 'severe', 'unknown'])
  })

  it('gives every band a distinct colour and a distinct label', () => {
    const colors = new Set(CONGESTION_GRADES.map(grade => CONGESTION_COLORS[grade]))
    const labels = new Set(CONGESTION_GRADES.map(grade => CONGESTION_LABELS[grade]))
    expect(colors.size).toBe(CONGESTION_GRADES.length)
    expect(labels.size).toBe(CONGESTION_GRADES.length)
  })

  /**
   * `unknown` must not read as "clear". Folding grey into green is the easiest way for this map to
   * claim a quiet road it never measured, so the grey is held well away from the green: it is the
   * least saturated colour on the ladder, and its channels are close to each other where the green's
   * are not.
   */
  it('keeps the unmeasured grey desaturated and nowhere near the green', () => {
    const spread = (color: number) => {
      const channels = [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff]
      return Math.max(...channels) - Math.min(...channels)
    }
    for (const grade of CONGESTION_GRADES) {
      if (grade === 'unknown') continue
      expect(spread(CONGESTION_COLORS.unknown)).toBeLessThan(spread(CONGESTION_COLORS[grade]))
    }
  })
})

describe('confidencePattern', () => {
  it('maps each confidence to a distinct pattern so colour stays free for congestion', () => {
    const patterns = new Set([
      confidencePattern('Confirmed'),
      confidencePattern('Probable'),
      confidencePattern('Unknown'),
    ])
    expect(patterns.size).toBe(3)
    expect(confidencePattern('Confirmed')).toBe('solid')
  })
})

describe('gradeRoads', () => {
  const families = [
    family({
      familyId: 'qf:hot',
      objectIds: ['a', 'b'],
      executionCount: '10',
      totalWaitMilliseconds: '900',
      totalDurationMicroseconds: '1000000',
    }),
    family({
      familyId: 'qf:cool',
      objectIds: ['c', 'd'],
      executionCount: '10',
      totalWaitMilliseconds: '1',
      totalDurationMicroseconds: '1000000',
    }),
  ]

  it('grades a heavily-waiting road red and a light one green', () => {
    const graded = gradeRoads(
      [route({ routeId: 'r:hot' }), route({ routeId: 'r:cool', fromObjectId: 'c', toId: 'd' })],
      families,
    )
    expect(graded[0].grade).toBe('severe')
    expect(graded[0].color).toBe(CONGESTION_COLORS.severe)
    expect(graded[1].grade).toBe('free')
    expect(graded[1].color).toBe(CONGESTION_COLORS.free)
    // And width says nothing about either of them any more.
    expect(graded[0].width).toBe(graded[1].width)
  })

  it('leaves roads with no captured family unknown and grey', () => {
    const [graded] = gradeRoads([route({ routeId: 'r:x', fromObjectId: 'x', toId: 'y' })], families)
    expect(graded.grade).toBe('unknown')
    expect(graded.color).toBe(CONGESTION_COLORS.unknown)
    expect(graded.executions).toBeNull()
    expect(graded.waitShare).toBeNull()
    expect(graded.delayPerExecution).toBeNull()
    expect(graded.rationale).toContain('no traffic volume is claimed')
  })

  /**
   * `waitShare` stopped grading the colour and did not stop being measured. It answers a different
   * question about the same waiting -- what fraction of the road's captured time went on it -- and
   * the evidence table still prints it.
   */
  it('keeps reporting the wait share the colour no longer grades on', () => {
    const [graded] = gradeRoads([route({ routeId: 'r:hot' })], families)
    expect(graded.waitShare).toBeCloseTo(0.9, 10)
    expect(graded.delayPerExecution).toBeCloseTo(90, 10)
    expect(graded.rationale).toContain('90.00 ms of captured waiting per execution')
    expect(graded.rationale).toContain('90.0% of captured duration')
  })

  it('upgrades to the worst band when a live lock wait resolves to an endpoint', () => {
    const [graded] = gradeRoads(
      [route({ routeId: 'r:cool', fromObjectId: 'c', toId: 'd' })],
      families,
      [{ objectKey: 'd', blockedSessionCount: 3 }],
    )
    expect(graded.grade).toBe('severe')
    expect(graded.rationale).toContain('live lock wait')
  })

  it('ignores live entries that report no blocked sessions', () => {
    const [graded] = gradeRoads(
      [route({ routeId: 'r:cool', fromObjectId: 'c', toId: 'd' })],
      families,
      [{ objectKey: 'd', blockedSessionCount: 0 }],
    )
    expect(graded.grade).toBe('free')
  })

  it('preserves route identity and carries the driving family ids for drill-down', () => {
    const [graded] = gradeRoads([route({ routeId: 'r:hot' })], families)
    expect(graded.routeId).toBe('r:hot')
    expect(graded.fromObjectId).toBe('a')
    expect(graded.toId).toBe('b')
    expect(graded.familyIds).toEqual(['qf:hot'])
  })

  it('always explains itself', () => {
    const graded = gradeRoads(
      [route({ routeId: 'r:hot' }), route({ routeId: 'r:x', fromObjectId: 'x', toId: 'y' })],
      families,
    )
    for (const road of graded) {
      expect(road.rationale.length).toBeGreaterThan(0)
    }
  })
})

describe('the recent traffic window', () => {
  function recent(
    overrides: Partial<NonNullable<DatabaseCityQueryFamily['recentActivity']>> = {},
  ): NonNullable<DatabaseCityQueryFamily['recentActivity']> {
    const wait = overrides.totalWaitMilliseconds ?? '0'
    return {
      windowMinutes: 15,
      windowStart: '2024-05-01T00:45:00Z',
      windowEnd: '2024-05-01T01:00:00Z',
      covered: true,
      executionCount: '0',
      totalDurationMicroseconds: '0',
      totalWaitMilliseconds: '0',
      waitAttribution: { objects: [], unattributedWaitMilliseconds: wait, plansRead: 0, rationale: 'No usable plan' },
      waitMillisecondsByCategory: { CPU: wait },
      rationale: 'test',
      ...overrides,
    }
  }

  const hot = route({ routeId: 'r:hot', fromObjectId: 'a', toId: 'b' })

  it('grades from the window rather than from the retained totals', () => {
    // Enormous history, quiet now: the street is not congested at this moment, and a map read as a
    // traffic map has to say so.
    const families = [
      family({
        familyId: 'qf:batch',
        objectIds: ['a', 'b'],
        executionCount: '500000',
        totalWaitMilliseconds: '50000000',
        recentActivity: recent({ executionCount: '10', totalWaitMilliseconds: '1' }),
      }),
    ]

    const [road] = gradeRoads([hot], families)

    expect(roadDelay(families)).toBeGreaterThanOrEqual(SEVERE_DELAY_MS_PER_EXECUTION)
    expect(road.grade).toBe('free')
    expect(road.delayPerExecution).toBeCloseTo(0.1)
    expect(road.recentExecutions).toBe(10)
    expect(road.recentWindowMinutes).toBe(15)
  })

  it('reports a quiet window as unknown rather than as a clear road', () => {
    // The distinction the whole contract exists for: nothing captured is grey, not green.
    const families = [
      family({
        familyId: 'qf:idle',
        objectIds: ['a', 'b'],
        executionCount: '100',
        totalWaitMilliseconds: '10',
        recentActivity: recent({ covered: false }),
      }),
    ]

    const [road] = gradeRoads([hot], families)

    expect(road.grade).toBe('unknown')
    expect(road.delayPerExecution).toBeNull()
    expect(road.rationale).toContain('missing capture')
  })

  it('still grades a busy window severe', () => {
    const families = [
      family({
        familyId: 'qf:hot',
        objectIds: ['a', 'b'],
        executionCount: '10',
        totalWaitMilliseconds: '0',
        recentActivity: recent({
          executionCount: '4',
          totalWaitMilliseconds: String(SEVERE_DELAY_MS_PER_EXECUTION * 4),
        }),
      }),
    ]

    expect(gradeRoads([hot], families)[0].grade).toBe('severe')
  })

  it('falls back to retained totals when no family published a window', () => {
    // An archive or a fixture page. Greying those out would discard evidence that is perfectly
    // good, just of a different kind.
    const families = [
      family({
        familyId: 'qf:archive',
        objectIds: ['a', 'b'],
        executionCount: '10',
        totalWaitMilliseconds: String(SEVERE_DELAY_MS_PER_EXECUTION * 10),
      }),
    ]

    const [road] = gradeRoads([hot], families)

    expect(road.grade).toBe('severe')
    expect(road.recentWindowMinutes).toBeNull()
  })

  it('lets a live lock wait still outrank a quiet window', () => {
    const families = [
      family({
        familyId: 'qf:idle',
        objectIds: ['a', 'b'],
        recentActivity: recent({ covered: false }),
      }),
    ]

    const [road] = gradeRoads([hot], families, [{ objectKey: 'a', blockedSessionCount: 2 }])

    expect(road.grade).toBe('severe')
  })

  it('keeps an old-hot road quiet when its covered recent execution and wait totals are zero', () => {
    const [road] = gradeRoads([hot], [family({
      familyId: 'old-hot', objectIds: ['a', 'b'], executionCount: '1000',
      totalWaitMilliseconds: '1000000', recentActivity: recent(),
    })])
    expect(road.grade).toBe('free')
    expect(road.delayPerExecution).toBe(0)
    expect(road.recentExecutions).toBe(0)
    expect(road.executions).toBe(1000)
  })

  it('chooses recent globally even when only an unrelated road publishes a window', () => {
    const [road] = gradeRoads([hot], [
      family({ familyId: 'archive', objectIds: ['a', 'b'], executionCount: '1', totalWaitMilliseconds: '1000' }),
      family({ familyId: 'publisher', objectIds: ['x', 'y'], recentActivity: recent() }),
    ])
    expect(road.grade).toBe('unknown')
    expect(road.recentExecutions).toBeNull()
    expect(road.waitShare).toBeNull()
    expect(road.rationale).toContain('0 of 1')
  })

  it('does not grade a covered quiet subset free while a contributing family lacks coverage', () => {
    const [road] = gradeRoads([hot], [
      family({ familyId: 'quiet', objectIds: ['a', 'b'], recentActivity: recent() }),
      family({ familyId: 'missing', objectIds: ['a', 'b'], executionCount: '1000' }),
    ])
    expect(road.grade).toBe('unknown')
    expect(road.delayPerExecution).toBeNull()
    expect(road.recentExecutions).toBeNull()
    expect(road.rationale).toContain('1 of 2')
    expect(road.rationale).toContain('Partial')
  })

  it.each(['', 'bad', '-1', 'NaN', 'Infinity', '0x10', '1.5'])(
    'never converts malformed recent waiting %j into a free road',
    value => {
      const [road] = gradeRoads([hot], [family({
        familyId: 'malformed', objectIds: ['a', 'b'],
        recentActivity: recent({ executionCount: '100', totalWaitMilliseconds: value }),
      })])
      expect(road.grade).toBe('unknown')
      expect(road.delayPerExecution).toBeNull()
    },
  )

  it('does not combine executions and waits from different windows or horizons', () => {
    const [road] = gradeRoads([hot], [family({
      familyId: 'recent', objectIds: ['a', 'b'], executionCount: '10000',
      totalWaitMilliseconds: '900000', totalDurationMicroseconds: '9000000000',
      recentActivity: recent({
        executionCount: '2', totalWaitMilliseconds: '120', totalDurationMicroseconds: '240000',
      }),
    })])
    expect(road.grade).toBe('severe')
    expect(road.delayPerExecution).toBe(60)
    expect(road.waitShare).toBe(0.5)
  })

  it('qualifies mismatched-window contributors as missing rather than summing their totals', () => {
    const [road] = gradeRoads([hot], [
      family({ familyId: 'new', objectIds: ['a', 'b'], recentActivity: recent() }),
      family({
        familyId: 'old', objectIds: ['a', 'b'],
        recentActivity: recent({ windowStart: '2024-05-01T00:30:00Z', windowEnd: '2024-05-01T00:45:00Z' }),
      }),
    ])
    expect(road.grade).toBe('unknown')
    expect(road.rationale).toContain('1 of 2')
  })

  it.each(['0', '10'])('never grades runtime-covered executions %s free when recent wait capture is explicitly null', executionCount => {
    const [road] = gradeRoads([hot], [family({
      familyId: 'runtime-only', objectIds: ['a', 'b'],
      recentActivity: recent({
        executionCount, totalWaitMilliseconds: '0',
        waitAttribution: null, waitMillisecondsByCategory: null,
      }),
    })])
    expect(road.grade).toBe('unknown')
    expect(road.delayPerExecution).toBeNull()
    expect(road.waitShare).toBeNull()
    expect(road.rationale).toContain('missing capture')
  })

  it('keeps legacy recent counters without wait metadata unknown, not free', () => {
    const [road] = gradeRoads([hot], [family({
      familyId: 'legacy-window', objectIds: ['a', 'b'],
      recentActivity: recent({ waitAttribution: undefined, waitMillisecondsByCategory: undefined }),
    })])
    expect(road.grade).toBe('unknown')
    expect(road.delayPerExecution).toBeNull()
  })

  it('grades captured whole-family waits even when no recent plan can place them', () => {
    const [road] = gradeRoads([hot], [family({
      familyId: 'captured-unplaced', objectIds: ['a', 'b'],
      recentActivity: recent({ executionCount: '2', totalWaitMilliseconds: '120' }),
    })])
    expect(road.grade).toBe('severe')
    expect(road.delayPerExecution).toBe(60)
  })
})

describe('describeTrafficWindow', () => {
  const covered = {
    windowMinutes: 15,
    windowStart: '2024-05-01T00:45:00Z',
    windowEnd: '2024-05-01T01:00:00Z',
    covered: true,
    executionCount: '4',
    totalDurationMicroseconds: '0',
    totalWaitMilliseconds: '0',
    waitAttribution: { objects: [], unattributedWaitMilliseconds: '0', plansRead: 0, rationale: 'No usable plan' },
    waitMillisecondsByCategory: { CPU: '0' },
    rationale: 'test',
  }

  it('says the colours are the window, and names the window', () => {
    const disclosure = describeTrafficWindow(
      [family({ familyId: 'qf:1', recentActivity: covered })],
      '2024-05-01T01:00:00Z',
      30_000,
    )

    expect(disclosure.headline).toContain('last 15 minutes')
    expect(disclosure.windowMinutes).toBe(15)
    expect(disclosure.covered).toBe(true)
    // The legend has to admit the buckets are counted whole, or the totals read as 15 minutes of work.
    expect(disclosure.detail).toContain('pro-rated')
  })

  it('says so when the colours are the retained history instead', () => {
    const disclosure = describeTrafficWindow([family({ familyId: 'qf:1' })], null, 30_000)

    expect(disclosure.headline).toContain('retained history')
    expect(disclosure.windowMinutes).toBeNull()
  })

  it('explains an empty window rather than letting it read as a fault', () => {
    const disclosure = describeTrafficWindow(
      [family({ familyId: 'qf:1', recentActivity: { ...covered, covered: false } })],
      '2024-05-01T01:00:00Z',
      30_000,
    )

    expect(disclosure.covered).toBe(false)
    expect(disclosure.headline).toContain('captured nothing')
    expect(disclosure.detail).toContain('unmeasured, not clear')
  })

  it('does not invent an observation time when workload evidence supplies none', () => {
    const disclosure = describeTrafficWindow(
      [family({ familyId: 'qf:1', recentActivity: covered })],
      null,
      30_000,
    )

    expect(disclosure.detail).toContain('every 30 seconds')
    expect(disclosure.detail).not.toContain('last read at')
    expect(disclosure.detail).toContain('Workload observation time unknown')
  })

  it('labels the workload observation separately from HTTP polling cadence', () => {
    const observedAt = '2024-04-30T19:12:00Z'
    const disclosure = describeTrafficWindow(
      [family({ familyId: 'qf:1', recentActivity: covered })], observedAt, 30_000,
    )
    expect(disclosure.detail).toContain(`Workload observed at ${new Date(observedAt).toLocaleString()}`)
    expect(disclosure.detail).toContain('polling is not a measurement timestamp')
    expect(disclosure.detail).not.toContain('last read at')
  })

  it.each(['archive', 'edge'] as const)('describes %s traffic as a captured window with no live cadence', mode => {
    const observedAt = '2024-05-01T01:00:00Z'
    const disclosure = describeTrafficWindow(
      [family({ familyId: 'qf:1', recentActivity: covered })], observedAt, 30_000, mode,
    )
    expect(disclosure.headline).toContain('captured 15-minute window')
    expect(disclosure.detail).toContain(`This ${mode} snapshot does not refresh automatically`)
    expect(disclosure.detail).toContain(`window ends at ${new Date(covered.windowEnd).toLocaleString()}`)
    expect(disclosure.detail).toContain('not at the current time')
    expect(disclosure.detail).not.toContain('every 30 seconds')
    expect(disclosure.detail).not.toContain('last 15 minutes')
    expect(disclosure.headline).not.toContain('last 15 minutes')
  })

  it('does not promise live blocking or polling for an uncovered archived window', () => {
    const disclosure = describeTrafficWindow(
      [family({ familyId: 'qf:1', recentActivity: { ...covered, covered: false } })],
      null, 30_000, 'archive',
    )
    expect(disclosure.headline).toContain('captured 15-minute window')
    expect(disclosure.detail).toContain('unmeasured, not clear')
    expect(disclosure.detail).not.toContain('Live blocking')
    expect(disclosure.detail).not.toContain('every 30 seconds')
  })

  it('keeps legacy archives explicitly historical and static', () => {
    const disclosure = describeTrafficWindow([family({ familyId: 'qf:1' })], null, 30_000, 'archive')
    expect(disclosure.headline).toContain('retained history')
    expect(disclosure.detail).toContain('snapshot does not refresh automatically')
    expect(disclosure.detail).toContain('Workload observation time unknown')
  })

  it('does not render a malformed observation timestamp as an observation', () => {
    const disclosure = describeTrafficWindow(
      [family({ familyId: 'qf:1', recentActivity: covered })], 'bad timestamp', 30_000,
    )
    expect(disclosure.detail).toContain('Workload observation time unknown')
    expect(disclosure.detail).not.toContain('Invalid Date')
  })
})
