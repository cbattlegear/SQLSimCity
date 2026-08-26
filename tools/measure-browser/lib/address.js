import { summarize, round } from './stats.js'
import { addressCounts } from './city.js'

/**
 * What a keystroke in the address-book search box costs.
 *
 * Typed with `pressSequentially`, which issues trusted key events one at a time through
 * the browser's input pipeline, so React sees exactly the sequence a person would produce.
 * Setting `input.value` from `evaluate` would change the DOM without ever running the
 * event path this is trying to measure.
 *
 * The reported latency is keydown to the paint that answers it. Each keystroke narrows the
 * list further, so the first keystroke of a term is the expensive one — it is the one that
 * filters, groups, sorts and re-renders the whole book — and the ones after it work on a
 * smaller list. Both ends are reported rather than averaged into a single number that
 * describes neither.
 */
export async function typeSearch(page, term, { perKeyDelayMs = 260 } = {}) {
  const field = page.getByRole('searchbox', { name: /Search queries, tables and infrastructure/i })
  await field.waitFor({ state: 'visible' })
  // Trusted click on the field itself: hit-tested, so a search box covered by the place
  // card or a drawer fails here rather than being typed into invisibly.
  const clickStartedAt = Date.now()
  await field.click({ timeout: 5000 })
  const trustedClickMs = Date.now() - clickStartedAt

  const before = await addressCounts(page)

  await page.evaluate(() => window.__measure.start())
  await field.pressSequentially(term, { delay: perKeyDelayMs })
  await page.waitForTimeout(600)
  const result = await page.evaluate(() => window.__measure.stop())

  const after = await addressCounts(page)

  const perKey = result.keys.map(entry => entry.toPaintMs)
  return {
    term,
    trustedClickMs,
    keystrokes: perKey.length,
    keyToPaintMs: summarize(perKey, 1),
    firstKeyToPaintMs: round(perKey[0] ?? null, 1),
    perKeyToPaintMs: perKey.map(value => round(value, 1)),
    slowEvents: result.events.map(entry => ({
      name: entry.name,
      durationMs: round(entry.durationMs, 1),
      handlerMs: round(entry.handlerMs, 1),
    })),
    longTasksMs: result.longTasks.map(entry => round(entry.durationMs, 1)),
    blockingMs: round(
      result.longTasks.reduce((sum, entry) => sum + Math.max(0, entry.durationMs - 50), 0),
      1,
    ),
    entriesBefore: before,
    entriesAfter: after,
  }
}

/**
 * Clearing the box back to the full list.
 *
 * The other half of the cost: emptying the term re-renders every entry the book has, which
 * is the largest single render the panel ever does.
 */
export async function clearSearch(page, { term }) {
  const field = page.getByRole('searchbox', { name: /Search queries, tables and infrastructure/i })
  await field.click({ timeout: 5000 })
  await page.evaluate(() => window.__measure.start())
  for (let index = 0; index < term.length; index += 1) {
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(260)
  }
  await page.waitForTimeout(600)
  const result = await page.evaluate(() => window.__measure.stop())
  const perKey = result.keys.map(entry => entry.toPaintMs)
  return {
    keystrokes: perKey.length,
    keyToPaintMs: summarize(perKey, 1),
    lastKeyToPaintMs: round(perKey[perKey.length - 1] ?? null, 1),
    perKeyToPaintMs: perKey.map(value => round(value, 1)),
    entriesAfter: await addressCounts(page),
  }
}

/**
 * A trusted click on an entry in the list.
 *
 * `locator.click()` hit-tests, so this fails when the entry is covered rather than passing
 * on an element that is technically in the DOM and unreachable in practice. That is the
 * check that caught the uninteractable column in #65, and it is reported as its own line.
 */
export async function clickFirstEntry(page) {
  const entry = page.locator('.address-entry').first()
  await entry.waitFor({ state: 'visible', timeout: 10000 })
  const startedAt = Date.now()
  try {
    await entry.click({ timeout: 5000 })
    return { ok: true, ms: Date.now() - startedAt }
  } catch (reason) {
    return { ok: false, ms: Date.now() - startedAt, error: String(reason).split('\n')[0] }
  }
}

/** Heights of the sections that give way, so "no overflow" is never quoted on its own. */
export async function sidebarGeometry(page) {
  return page.evaluate(() => {
    const read = (selector) => {
      const element = document.querySelector(selector)
      if (!element) return null
      const style = getComputedStyle(element)
      const overflowY = style.overflowY
      const overshoot = Math.max(0, element.scrollHeight - element.clientHeight)
      /*
       * Overshoot is only *unreachable* when the box cannot scroll.
       *
       * `overflow: auto` on a 529px column holding 341,776px of list is a scroller doing its
       * job, not a defect; `overflow: hidden` on the same numbers is content the user can
       * never get to. Reporting both as one figure is how a scroll extent gets quoted as a
       * bug — and how a real clipping bug gets waved away as "it's just a long list".
       */
      const scrollable = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay'
      return {
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        overflowY,
        scrollExtentPx: scrollable ? overshoot : 0,
        unreachablePx: scrollable ? 0 : overshoot,
      }
    }
    return {
      sidebar: read('.map-sidebar'),
      scroll: read('.sidebar-scroll'),
      placeCard: read('.sidebar-place-card'),
      drawers: read('.sidebar-drawers'),
    }
  })
}
