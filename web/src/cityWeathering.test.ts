/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

import {
  ARCHETYPE_COLORS,
  BUILDING_TRIM_COLOR,
  BUILDING_WINDOW_COLOR,
  BUILDING_WINDOW_EMISSIVE,
  WEATHERED_TRIM_COLOR,
  WEATHERED_WINDOW_COLOR,
  WEATHERED_WINDOW_EMISSIVE,
  buildingColor,
  mapBuildingColor,
  neighborhoodTint,
  relativeLuma,
  weatheredBuildingColor,
  weatheredMapBuildingColor,
} from './cityBuildings'
import type { BuildingArchetype } from './cityPlan'
import type { DistrictCharacter } from './cityTerrain'

const ARCHETYPES = Object.keys(ARCHETYPE_COLORS) as BuildingArchetype[]
const CHARACTERS: DistrictCharacter[] = ['residential', 'commercial', 'industrial', 'civic']

const channels = (color: number): [number, number, number] => [
  (color >> 16) & 0xff,
  (color >> 8) & 0xff,
  color & 0xff,
]

/** Straight-line distance in packed sRGB, on the same 0-255 scale the samples were measured on. */
function distance(left: number, right: number): number {
  const a = channels(left)
  const b = channels(right)
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/** Every fresh facade a district can draw, across all its archetypes. */
function freshFacades(character: DistrictCharacter, tint: number): number[] {
  return ARCHETYPES.map(archetype => buildingColor(archetype, character, tint))
}

/**
 * The average gap the palette itself opens between two *fresh* buildings in one district.
 *
 * This is the noise floor a weathering cue has to clear. Two healthy buildings in the same
 * neighbourhood already differ by this much on average, so a cue smaller than it cannot be read as
 * meaning anything — which is exactly how the original 35% body blend came to be invisible.
 */
function freshSpread(character: DistrictCharacter, tint: number): number {
  const fresh = freshFacades(character, tint)
  let total = 0
  let pairs = 0
  for (let i = 0; i < fresh.length; i += 1) {
    for (let j = i + 1; j < fresh.length; j += 1) {
      total += distance(fresh[i], fresh[j])
      pairs += 1
    }
  }
  return total / pairs
}

/**
 * What one building actually looks like, as the mean of the three surfaces it is drawn from.
 *
 * A building is not just its body colour, which is the assumption the original cue was built on.
 * Facade, glazing and trim are all on screen at once, and the eye integrates them — so this is the
 * quantity a legibility claim has to be made about.
 */
function appearance(
  archetype: BuildingArchetype,
  character: DistrictCharacter,
  tint: number,
  weathered: boolean,
): number {
  const body = buildingColor(archetype, character, tint)
  const surfaces = weathered
    ? [weatheredBuildingColor(body), WEATHERED_WINDOW_COLOR, WEATHERED_TRIM_COLOR]
    : [body, BUILDING_WINDOW_COLOR, BUILDING_TRIM_COLOR]
  let out = 0
  for (let shift = 16; shift >= 0; shift -= 8) {
    const mean = surfaces.reduce((sum, color) => sum + ((color >> shift) & 0xff), 0) / surfaces.length
    out |= Math.round(mean) << shift
  }
  return out
}

describe('weathered buildings', () => {
  /**
   * The defect this replaced, stated as a number.
   *
   * Measured in a browser against a real instance, the old cue moved a stale facade 19.2 and 22.1
   * units away from two fresh neighbours, while those two neighbours were already 32.3 units apart
   * from each other. The signal was smaller than the noise, so a reader had no way to tell which
   * tower the disaster was about.
   *
   * Note what this is measured over: the whole building, not the body. A dark tower's facade cannot
   * clear the floor on its own — there is not enough brightness left in it to spend — which is the
   * reason weathering is three cues and not a harder version of one.
   */
  it('changes a building more than the palette separates two fresh ones', () => {
    for (const character of CHARACTERS) {
      for (let ordinal = 0; ordinal < 6; ordinal += 1) {
        const tint = neighborhoodTint(ordinal)
        const floor = freshSpread(character, tint)
        for (const archetype of ARCHETYPES) {
          const moved = distance(
            appearance(archetype, character, tint, false),
            appearance(archetype, character, tint, true),
          )
          expect(
            moved,
            `${character}/${archetype}/tint ${ordinal}: weathering moved ${moved.toFixed(1)}, ` +
              `fresh buildings already differ by ${floor.toFixed(1)} on average`,
          ).toBeGreaterThan(floor)
        }
      }
    }
  })

  /**
   * Direction matters as much as size. The old blend darkened some facades and *lightened* others,
   * so in one measured frame the stale tower was the brighter of the three on its street.
   */
  it('always darkens, whatever the facade started as', () => {
    for (const character of CHARACTERS) {
      for (let ordinal = 0; ordinal < 6; ordinal += 1) {
        const tint = neighborhoodTint(ordinal)
        for (const archetype of ARCHETYPES) {
          const fresh = buildingColor(archetype, character, tint)
          expect(relativeLuma(weatheredBuildingColor(fresh))).toBeLessThan(relativeLuma(fresh))
        }
      }
    }
  })

  /**
   * Derelict has to look the same everywhere or it is just another neighbourhood colour. Two
   * weathered buildings from different districts converge on one grimy tone even when their fresh
   * colours were far apart.
   */
  it('pulls buildings from unlike districts toward one common grime', () => {
    const left = buildingColor('tower', 'residential', neighborhoodTint(0))
    const right = buildingColor('house', 'civic', neighborhoodTint(3))
    expect(distance(weatheredBuildingColor(left), weatheredBuildingColor(right)))
      .toBeLessThan(distance(left, right))
  })

  it('darkens the flattened basemap plate too', () => {
    for (let ordinal = 0; ordinal < 6; ordinal += 1) {
      const plate = mapBuildingColor('tower', 0xd7d2c6, neighborhoodTint(ordinal))
      expect(relativeLuma(weatheredMapBuildingColor(plate))).toBeLessThan(relativeLuma(plate) - 40)
    }
  })

  describe('boarded windows', () => {
    it('puts the lights out', () => {
      expect(WEATHERED_WINDOW_EMISSIVE).toBe(0)
      expect(BUILDING_WINDOW_EMISSIVE).toBeGreaterThan(0)
    })

    it('reads as boards rather than as glass', () => {
      expect(relativeLuma(WEATHERED_WINDOW_COLOR))
        .toBeLessThan(relativeLuma(BUILDING_WINDOW_COLOR) - 60)
    })

    /**
     * Boards are deliberately *lighter* than the grimed facade they sit in. Darkening them to match
     * would collapse the window grid into the body and leave a featureless slab, which reads as a
     * building drawn without detail rather than as one that has been abandoned.
     */
    it('stays lighter than the grime around it, so the window grid survives', () => {
      for (const character of CHARACTERS) {
        for (const archetype of ARCHETYPES) {
          const grimed = weatheredBuildingColor(buildingColor(archetype, character, neighborhoodTint(2)))
          expect(relativeLuma(WEATHERED_WINDOW_COLOR)).toBeGreaterThan(relativeLuma(grimed))
        }
      }
    })
  })

  it('dulls the trim', () => {
    expect(relativeLuma(WEATHERED_TRIM_COLOR)).toBeLessThan(relativeLuma(BUILDING_TRIM_COLOR) - 30)
  })

  /**
   * The colours above are only worth having if the scene reaches for them.
   *
   * Read as source text because the scene needs a WebGL context and cannot be instantiated in this
   * suite — the same reason `shadowInvalidation.test.ts` reads it this way. It cannot prove the
   * building looks right on screen, which is what `tools/measure-browser` is for, but it can prove
   * that the glazing and trim of a weathered building are not quietly drawn with the clean
   * materials, which is the regression that would restore the invisible single-cue version without
   * changing a single colour.
   */
  describe('the scene draws all three cues', () => {
    const scene = readFileSync(new URL('./DatabaseCityScene.ts', import.meta.url), 'utf8')
    const buildBuildings = scene.slice(
      scene.indexOf('function buildBuildings('),
      scene.indexOf('function buildTraffic('),
    )

    it('slices a region that exists', () => {
      expect(scene.indexOf('function buildBuildings(')).toBeGreaterThan(-1)
      expect(scene.indexOf('function buildTraffic('))
        .toBeGreaterThan(scene.indexOf('function buildBuildings('))
    })

    it('boards the windows of a weathered building', () => {
      expect(buildBuildings).toMatch(/isWeathered \? materials\.weatheredWindow : materials\.window/)
    })

    it('dulls the trim of a weathered building', () => {
      expect(buildBuildings).toMatch(/isWeathered \? materials\.weatheredTrim : materials\.trim/)
    })

    it('grimes the facade and the basemap plate of a weathered building', () => {
      expect(buildBuildings).toMatch(/isWeathered \? weatheredBuildingColor\(/)
      expect(buildBuildings).toMatch(/isWeathered \? weatheredMapBuildingColor\(/)
    })
  })
})
