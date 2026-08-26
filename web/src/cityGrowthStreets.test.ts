import { describe, expect, it } from 'vitest'
import { planCity, type CityPlan } from './cityPlan'
import {
  GROWTH_SIZES,
  PLAN_TIMEOUT_MS,
  cityOf,
  lotsOf,
  movedBuildings,
  objectIdFor,
  planOf,
  streetSignature,
} from './cityGrowth.testkit'

/*
 * The street half of the growth guarantee: what the network does when the database changes under it.
 * See `cityGrowth.testkit.ts` for the fixtures and for why this family is split across files.
 */

/**
 * The traced street network is cached and handed to every plan that shares a seed, by reference. That
 * is what makes a page merge cheap, and it is also the one way this change could corrupt a city
 * rather than stabilise it: if any part of planning wrote to the shared network, the second city to
 * use it would be planned against ground the first had already altered.
 *
 * Reading the consumers is not proof, because a future consumer could start writing. These plan the
 * same city on either side of a different one and check the network came back identical, which fails
 * the moment anything mutates what it was lent.
 */
describe('the shared street network', () => {
  it('survives another city being planned against it', () => {
    const first = planOf(100)
    const signature = streetSignature(first)
    const lots = lotsOf(first)

    planOf(140)
    planOf(100)

    // The first plan object itself, not a fresh one: it holds the shared network by reference, so it
    // is where a leak would show.
    expect(streetSignature(first)).toEqual(signature)
    expect(lotsOf(first)).toEqual(lots)
  })

  it('plans the same city identically whether or not it was traced fresh', () => {
    const traced = planOf(100)
    const cached = planOf(100)
    expect(streetSignature(cached)).toEqual(streetSignature(traced))
    expect(lotsOf(cached)).toEqual(lotsOf(traced))
    expect(cached.intersections.size).toEqual(traced.intersections.size)
    expect(cached.terrain).toEqual(traced.terrain)
    expect(cached.districts).toEqual(traced.districts)
  })

  it('routes the same way after another city has used the router', () => {
    const first = planOf(100)
    const ids = [...first.intersections.keys()].sort()
    const from = first.intersections.get(ids[0])!
    const to = first.intersections.get(ids[ids.length - 1])!
    const before = first.router.route(from.col, to.col)

    planOf(140).router.route(from.col, to.col)

    expect(first.router.route(from.col, to.col)).toEqual(before)
  })
})

describe('adding a table to the database', () => {
  it.each(GROWTH_SIZES)('leaves the street network untouched, at %i objects', count => {
    expect(streetSignature(planOf(count + 1))).toBe(streetSignature(planOf(count)))
  }, PLAN_TIMEOUT_MS)

  /*
   * The honest half of the trade. Growth cannot be both continuous and stable: either every added
   * table moves the map a little, or the map holds still and rebuilds on a rung. This asserts the
   * rebuild really does happen there, so the ladder is a documented behaviour rather than a gap in
   * the tests above.
   */
  it('does rebuild the city when the database climbs a rung', () => {
    expect(streetSignature(planOf(77))).not.toBe(streetSignature(planOf(76)))
  })
})

describe('a table growing', () => {
  /** The same database, with one table holding more pages than it did before. */
  function grownBy(count: number, index: number, pages: string): CityPlan {
    const { objects, options } = cityOf(count)
    const grown = objects.map(item =>
      item.objectId === objectIdFor(index)
        ? {
            ...item,
            reservedPages8KiB: pages,
            usedPages8KiB: pages,
            reservedBytes: String(BigInt(pages) * 8192n),
            usedBytes: String(BigInt(pages) * 8192n),
          }
        : item,
    )
    return planCity(grown, options)
  }

  /*
   * The everyday case, and the one that would be worst if it churned: tables gain pages constantly,
   * so a city that retraces when its largest table grows is a city that is never the same twice.
   */
  it('does not retrace the city when a table gains pages', () => {
    const before = planOf(120)
    const after = grownBy(120, 7, '90000')
    expect(streetSignature(after)).toBe(streetSignature(before))
    expect(movedBuildings(before, after)).toEqual([])
  })
})
