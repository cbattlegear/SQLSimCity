import { describe, expect, it } from 'vitest'
import { planOf, streetSignature } from './cityGrowth.testkit'

/*
 * How often the street network is redrawn across a long stretch of growth. See
 * `cityGrowth.testkit.ts` for the fixtures and for why this family is split across files.
 *
 * This spec holds one test and gets a file to itself deliberately. It plans sixty-one cities, which
 * is the most expensive thing the web suite does, and vitest parallelises across files but not
 * within one. Anything sharing this file would wait on it for no reason.
 */

describe('adding a table to the database', () => {
  /*
   * A quantised city redraws on a ladder step rather than never. The promise is that growth is rare
   * and bounded, so this walks a long stretch of it and counts how often the network is retraced
   * rather than asserting it never is.
   */
  it('retraces the streets rarely rather than on every added table', () => {
    let retraced = 0
    let previous = streetSignature(planOf(80))
    for (let count = 81; count <= 140; count += 1) {
      const signature = streetSignature(planOf(count))
      if (signature !== previous) retraced += 1
      previous = signature
    }
    expect(retraced).toBeLessThanOrEqual(2)
  }, 60_000)
})
