import { describe, expect, it } from 'vitest'
import {
  GROWTH_SIZES,
  PLAN_TIMEOUT_MS,
  movedBuildings,
  objectIdFor,
  planOf,
} from './cityGrowth.testkit'

/*
 * The building half of the growth guarantee: whether a table added to the database moves any
 * building that was already standing. See `cityGrowth.testkit.ts` for the fixtures and for why
 * this family is split across files.
 */

describe('adding a table to the database', () => {
  it.each(GROWTH_SIZES)('leaves every existing building where it was, at %i objects', count => {
    const before = planOf(count)
    const after = planOf(count + 1)
    expect(movedBuildings(before, after)).toEqual([])
  }, PLAN_TIMEOUT_MS)
})

describe('a table created after the city was drawn', () => {
  /*
   * The premise the whole append-only guarantee rests on, tested on its own because it is the one
   * that is quietly false under a text comparison: SQL Server writes object ids unpadded, so
   * `object/9` sorts after `object/1234567` as text. A table created into a database whose ids have
   * just gained a digit is the case that would otherwise land mid-order and push every building after
   * it along.
   */
  it('sorts last however many digits its object id has', () => {
    // 97 objects run to object id 99, so the 98th is id 100 — the first three-digit id in the
    // database. Compared as text it sorts before `11`, landing near the front of the catalogue and
    // pushing most of the city along; compared as a number it sorts last, which is the truth.
    const before = planOf(97)
    const after = planOf(98)
    expect(movedBuildings(before, after)).toEqual([])
    expect(after.lots.has(objectIdFor(97))).toBe(true)
  })

  it('takes ground no earlier table wanted', () => {
    const before = planOf(97)
    const after = planOf(98)
    const taken = new Set([...before.lots.values()].map(lot => lot.blockId))
    expect(taken.has(after.lots.get(objectIdFor(97))!.blockId)).toBe(false)
  })
})
