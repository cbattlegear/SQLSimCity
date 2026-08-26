import { describe, expect, it } from 'vitest'
import { GROWTH_SIZES, PLAN_TIMEOUT_MS, objectIdFor, planOf } from './cityGrowth.testkit'

/*
 * The ground half of the growth guarantee: the added table gets a lot, and no two buildings end up
 * standing on the same block. See `cityGrowth.testkit.ts` for the fixtures and for why this family
 * is split across files.
 */

describe('adding a table to the database', () => {
  it.each(GROWTH_SIZES)('gives the new table a building of its own, at %i objects', count => {
    const before = planOf(count)
    const after = planOf(count + 1)
    const added = objectIdFor(count)
    expect(before.lots.has(added)).toBe(false)
    expect(after.lots.has(added)).toBe(true)
    expect(after.lots.size).toBe(before.lots.size + 1)
  }, PLAN_TIMEOUT_MS)

  it.each(GROWTH_SIZES)('stands every building on ground of its own, at %i objects', count => {
    const plan = planOf(count + 1)
    const blocks = new Set([...plan.lots.values()].map(lot => lot.blockId))
    expect(blocks.size).toBe(plan.lots.size)
  }, PLAN_TIMEOUT_MS)

  it('does not stand the new building on ground another building already holds', () => {
    const before = planOf(120)
    const after = planOf(121)
    const taken = new Set([...before.lots.values()].map(lot => lot.blockId))
    const added = after.lots.get(objectIdFor(120))!
    expect(taken.has(added.blockId)).toBe(false)
  })
})
