import { describe, expect, it, vi } from 'vitest'
import {
  ATLAS_ATMOSPHERE,
  CITY_ATMOSPHERE,
  TIMES_OF_DAY,
  TIME_OF_DAY_POLL_MS,
  resolveTimeOfDay,
  watchTimeOfDay,
  type TimeOfDay,
} from './timeOfDay'

/** A local time on a fixed day, so nothing here depends on the machine's zone or the date. */
function at(hour: number, minute = 0): Date {
  return new Date(2024, 5, 12, hour, minute, 0, 0)
}

/**
 * The four phases, hour by hour.
 *
 * Spelled out rather than derived from the boundary table, because a test that recomputes the thing
 * it is checking agrees with any edit to it — including the wrong one.
 */
const EXPECTED_BY_HOUR: readonly TimeOfDay[] = [
  'night', // 00
  'night', // 01
  'night', // 02
  'night', // 03
  'night', // 04
  'morning', // 05
  'morning', // 06
  'morning', // 07
  'morning', // 08
  'morning', // 09
  'day', // 10
  'day', // 11
  'day', // 12
  'day', // 13
  'day', // 14
  'day', // 15
  'day', // 16
  'evening', // 17
  'evening', // 18
  'evening', // 19
  'night', // 20
  'night', // 21
  'night', // 22
  'night', // 23
]

describe('resolveTimeOfDay', () => {
  it.each(EXPECTED_BY_HOUR.map((phase, hour) => [hour, phase] as const))(
    'draws %i:00 as %s',
    (hour, phase) => {
      expect(resolveTimeOfDay(at(hour))).toBe(phase)
    },
  )

  it('changes phase on the hour, not part way through it', () => {
    expect(resolveTimeOfDay(at(4, 59))).toBe('night')
    expect(resolveTimeOfDay(at(5, 0))).toBe('morning')
    expect(resolveTimeOfDay(at(9, 59))).toBe('morning')
    expect(resolveTimeOfDay(at(10, 0))).toBe('day')
    expect(resolveTimeOfDay(at(16, 59))).toBe('day')
    expect(resolveTimeOfDay(at(17, 0))).toBe('evening')
    expect(resolveTimeOfDay(at(19, 59))).toBe('evening')
    expect(resolveTimeOfDay(at(20, 0))).toBe('night')
  })

  it('carries night across midnight as one phase', () => {
    expect(resolveTimeOfDay(at(23, 59))).toBe('night')
    expect(resolveTimeOfDay(new Date(2024, 5, 13, 0, 0))).toBe('night')
  })
})

describe('watchTimeOfDay', () => {
  /** A controllable clock and timer, so nothing here waits a real minute. */
  function harness(startHour: number) {
    let hour = startHour
    let tick: (() => void) | null = null
    const cleared: number[] = []
    const seen: TimeOfDay[] = []
    const stop = watchTimeOfDay(phase => seen.push(phase), {
      now: () => at(hour),
      setInterval: handler => {
        tick = handler
        return 7
      },
      clearInterval: handle => {
        cleared.push(handle)
      },
    })
    return {
      seen,
      cleared,
      stop,
      set(next: number) {
        hour = next
        tick?.()
      },
    }
  }

  it('does not fire for the phase it started in', () => {
    const watch = harness(12)
    expect(watch.seen).toEqual([])
    watch.set(13)
    expect(watch.seen).toEqual([])
  })

  it('fires once when the viewer crosses into the next phase', () => {
    const watch = harness(19)
    watch.set(20)
    expect(watch.seen).toEqual(['night'])
    watch.set(21)
    expect(watch.seen).toEqual(['night'])
    watch.set(6)
    expect(watch.seen).toEqual(['night', 'morning'])
  })

  it('stops polling once unsubscribed', () => {
    const watch = harness(19)
    watch.stop()
    expect(watch.cleared).toEqual([7])
    watch.set(20)
    expect(watch.seen).toEqual([])
  })

  it('clears its timer only once, however many times it is unsubscribed', () => {
    const watch = harness(19)
    watch.stop()
    watch.stop()
    expect(watch.cleared).toEqual([7])
  })

  it('polls on a one-minute cadence by default', () => {
    const setInterval = vi.fn(() => 1)
    watchTimeOfDay(() => {}, { now: () => at(12), setInterval, clearInterval: () => {} })
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), TIME_OF_DAY_POLL_MS)
    expect(TIME_OF_DAY_POLL_MS).toBe(60_000)
  })
})

/**
 * The golden hour the city has always been drawn in, lifted from the constants that were hard-coded
 * in `DatabaseCityScene` and `AtlasScene` before the hour became a variable.
 *
 * This is the regression guard for the whole feature: three new looks were tuned alongside it, and
 * without this the historical one could drift a shade at a time and nobody would notice.
 */
describe('the evening atmosphere is the historical golden hour', () => {
  it('lights the city exactly as it was lit before', () => {
    expect(CITY_ATMOSPHERE.evening).toEqual({
      hemiSky: 0xa8b6c9,
      hemiGround: 0x6a5a45,
      hemiIntensity: 1.75,
      keyColor: 0xffc286,
      keyIntensity: 2.2,
      // reach * 1.35, reach * 1.15, reach * 0.6 — the offsets `aimSunAt` used to hard-code.
      sunEast: 1.35,
      sunHeight: 1.15,
      sunSouth: 0.6,
      fillColor: 0x8aa6d2,
      fillIntensity: 0.5,
      background: 0x131f36,
      fogColor: 0xc6a184,
      skyZenith: 0x14203c,
      skyUpper: 0x3c4a72,
      skyHorizon: 0xf0b072,
      hazeNear: 0xc6a184,
      hazeFar: 0x6d6b52,
      windowEmissive: 0x2f4f6a,
      windowEmissiveIntensity: 1,
    })
  })

  it('lights the atlas exactly as it was lit before', () => {
    expect(ATLAS_ATMOSPHERE.evening).toEqual({
      sky: 0x2b3a45,
      hemiSky: 0xa8cbe4,
      hemiGround: 0x35392a,
      hemiIntensity: 1.05,
      keyColor: 0xffd39a,
      keyIntensity: 3.1,
    })
  })

  it('matches the fog to the haze the city dissolves into', () => {
    // The two being equal is what stops the ground ending at a hard edge with a void behind it.
    for (const phase of TIMES_OF_DAY) {
      expect(CITY_ATMOSPHERE[phase].fogColor).toBe(CITY_ATMOSPHERE[phase].hazeNear)
    }
  })
})

describe('every phase is fully specified', () => {
  it.each(TIMES_OF_DAY)('gives %s a complete city rig', phase => {
    expect(Object.keys(CITY_ATMOSPHERE[phase]).sort()).toEqual(
      Object.keys(CITY_ATMOSPHERE.evening).sort(),
    )
    for (const [key, value] of Object.entries(CITY_ATMOSPHERE[phase])) {
      expect(typeof value, key).toBe('number')
      expect(Number.isFinite(value), key).toBe(true)
    }
  })

  it.each(TIMES_OF_DAY)('gives %s a complete atlas rig', phase => {
    expect(Object.keys(ATLAS_ATMOSPHERE[phase]).sort()).toEqual(
      Object.keys(ATLAS_ATMOSPHERE.evening).sort(),
    )
  })

  it('keeps every colour inside a 24-bit hex', () => {
    for (const phase of TIMES_OF_DAY) {
      const rig = CITY_ATMOSPHERE[phase]
      const colors = [
        rig.hemiSky,
        rig.hemiGround,
        rig.keyColor,
        rig.fillColor,
        rig.background,
        rig.fogColor,
        rig.skyZenith,
        rig.skyUpper,
        rig.skyHorizon,
        rig.hazeNear,
        rig.hazeFar,
        rig.windowEmissive,
        ATLAS_ATMOSPHERE[phase].sky,
        ATLAS_ATMOSPHERE[phase].hemiSky,
        ATLAS_ATMOSPHERE[phase].hemiGround,
        ATLAS_ATMOSPHERE[phase].keyColor,
      ]
      for (const color of colors) {
        expect(Number.isInteger(color)).toBe(true)
        expect(color).toBeGreaterThanOrEqual(0)
        expect(color).toBeLessThanOrEqual(0xffffff)
      }
    }
  })

  /*
   * A night city lit only by its own windows is a black rectangle, and the ~47% of ground carrying
   * no building disappears along with every road, park and parcel boundary drawn on it. The sky
   * fill is the only thing holding that ground up, so it has a floor.
   */
  it('keeps enough sky fill at night to read the ground', () => {
    expect(CITY_ATMOSPHERE.night.hemiIntensity).toBeGreaterThan(1)
    expect(ATLAS_ATMOSPHERE.night.hemiIntensity).toBeGreaterThan(0.5)
  })

  /* Windows are lit from the inside, so they run opposite the sun rather than with it. */
  it('glows the windows hardest at night and least at midday', () => {
    const intensity = (phase: TimeOfDay) => CITY_ATMOSPHERE[phase].windowEmissiveIntensity
    expect(intensity('night')).toBeGreaterThan(intensity('evening'))
    expect(intensity('evening')).toBeGreaterThan(intensity('morning'))
    expect(intensity('morning')).toBeGreaterThan(intensity('day'))
  })

  /*
   * Shadows are the drawing's cheapest depth cue, and they come from where the sun *is*, not what
   * colour it is. Morning and evening that share an elevation and a heading render as the same
   * picture in different paint.
   */
  it('puts the sun somewhere different in every phase', () => {
    const placements = TIMES_OF_DAY.map(phase => {
      const rig = CITY_ATMOSPHERE[phase]
      return `${rig.sunEast},${rig.sunHeight},${rig.sunSouth}`
    })
    expect(new Set(placements).size).toBe(TIMES_OF_DAY.length)
    expect(CITY_ATMOSPHERE.day.sunHeight).toBeGreaterThan(CITY_ATMOSPHERE.evening.sunHeight)
    expect(CITY_ATMOSPHERE.morning.sunHeight).toBeLessThan(CITY_ATMOSPHERE.day.sunHeight)
    // Morning and evening sun stand on opposite sides of the city.
    expect(Math.sign(CITY_ATMOSPHERE.morning.sunEast)).not.toBe(
      Math.sign(CITY_ATMOSPHERE.evening.sunEast),
    )
  })
})
