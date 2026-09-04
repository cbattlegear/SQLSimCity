import { summarize, round } from './stats.js'
import { addressCounts } from './city.js'

/**
 * How long a *trusted* click is given before it is called a failure.
 *
 * This was 5s, which was enough before vehicles and is not enough now -- and the reason is worth
 * writing down, because the failure it produced looked like a broken control rather than a tight
 * budget. `locator.click()` hit-tests and waits for actionability, and it can only re-check that
 * on a rendered frame. A city of 4,200 objects under live load renders at ~6fps (163 ms/frame
 * measured), so a handful of re-checks alone spends most of a 5s budget: trusted clicks on the
 * orbit buttons in the same run took 2.0-2.7s each, and the plan finder's submit timed out.
 *
 * Raising the budget is the right response *because* it keeps the click trusted, which is the
 * whole point of the pass. The tempting alternatives -- `force: true`, or `element.click()` via
 * `evaluate` -- both bypass the hit-test, so they would turn this into a green line while a
 * genuinely unreachable control stayed unreachable. AGENTS.md calls that out specifically: it is
 * how issue #65's column was found to be uninteractable rather than merely unreadable.
 */
const TRUSTED_CLICK_TIMEOUT_MS = 20000

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
  await field.click({ timeout: TRUSTED_CLICK_TIMEOUT_MS })
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
  await field.click({ timeout: TRUSTED_CLICK_TIMEOUT_MS })
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
    await entry.click({ timeout: TRUSTED_CLICK_TIMEOUT_MS })
    return { ok: true, ms: Date.now() - startedAt }
  } catch (reason) {
    return { ok: false, ms: Date.now() - startedAt, error: String(reason).split('\n')[0] }
  }
}

/**
 * Opens the "City directory" disclosure, which is where the address book now lives.
 *
 * The book used to be an always-rendered region of the rail, and every reader of it here --
 * `addressCounts`, `sidebarGeometry`'s `scroll`, `clickFirstEntry`, `openPlaceCard` and the whole
 * address-book pass in `measure.js` -- still queries `.sidebar-scroll` and `.address-entry`
 * directly. Wrapping it in a collapsed `<details class="sidebar-directory">` did not remove those
 * nodes: `::details-content` hides them with `content-visibility`, so they stay in the DOM,
 * `querySelector` still finds them, and `clientHeight` reads 0.
 *
 * That is the worst possible shape for a measurement harness, because both halves lie quietly.
 * `sidebarGeometry` reported `scroll 0px visible, 9936px content` -- which is the exact signature
 * of the #65 squeezed-to-nothing column -- while the real cause was a disclosure nobody had
 * opened. And the address-book pass died on `locator('.address-entry').first()` resolving to a
 * *hidden* element for the full 120s budget, so a 5-minute run ended with "address book pass
 * failed: Timeout" and no typing numbers, no trusted click.
 *
 * The click is trusted for the usual reason: a summary that cannot be reached because something
 * covers it is a defect this pass exists to catch, not an obstacle to force past.
 */
export async function openDirectory(page) {
  const directory = page.locator('.sidebar-directory')
  if ((await directory.count()) === 0) {
    return { step: 'open city directory', ok: true, ms: 0, note: 'no directory disclosure in this view' }
  }
  if (await directory.evaluate(element => element.open)) {
    return { step: 'open city directory', ok: true, ms: 0, note: 'already open' }
  }
  const startedAt = Date.now()
  try {
    await directory.locator('> summary').click({ timeout: TRUSTED_CLICK_TIMEOUT_MS })
    await page.locator('.sidebar-scroll').waitFor({ state: 'visible', timeout: TRUSTED_CLICK_TIMEOUT_MS })
    return { step: 'open city directory', ok: true, ms: Date.now() - startedAt }
  } catch (reason) {
    return { step: 'open city directory', ok: false, ms: Date.now() - startedAt, error: String(reason).split('\n')[0] }
  }
}

/**
 * Walks the sidebar's accordion and measures each region while it is the open one.
 *
 * There is no longer a single "worst case" state to reach. `DatabaseCityView.tsx` holds one
 * `openRegion`, and the city directory is part of it, so opening any region closes the last --
 * "every drawer open over real rows with an open address book competing for the same rail" is
 * unreachable by construction. This used to click every summary in turn and then measure, which
 * measured the *emptiest* column rather than the fullest (#118): three closed drawers, a closed
 * book, and a reassuring 0px unreachable from a column carrying almost nothing.
 *
 * So the accordion's worst case is a *set* of single-region states, and each one is measured while
 * its region is open. The plan finder is populated at the only moment it can be -- while its own
 * drawer is the open one. Clicking "Route it" after the walk, as this did, hits a button the
 * accordion has already closed, and `AGENTS.md` is specific that an empty finder is a short form
 * that hides every height defect in that drawer.
 *
 * Every interaction is a trusted `locator.click()`. A summary that cannot be clicked because its
 * region was squeezed under it is the defect this pass exists to catch, so reaching each state has
 * to fail loudly rather than be forced through with `element.click()`.
 */
export async function walkSidebarRegions(page, { populatePlanFinder = true } = {}) {
  const steps = []
  const regions = {}

  const directoryStep = await openDirectory(page)
  steps.push(directoryStep)
  if (directoryStep.ok) regions['City directory'] = await sidebarGeometry(page)

  const drawers = page.locator('.sidebar-drawer')
  const count = await drawers.count()
  for (let index = 0; index < count; index += 1) {
    const drawer = drawers.nth(index)
    const summary = drawer.locator('> summary')
    const label = (await summary.textContent())?.trim() ?? `drawer ${index}`
    if (!(await drawer.evaluate(element => element.open))) {
      const startedAt = Date.now()
      try {
        await summary.click({ timeout: TRUSTED_CLICK_TIMEOUT_MS })
        steps.push({ step: `open "${label}"`, ok: true, ms: Date.now() - startedAt })
      } catch (reason) {
        steps.push({ step: `open "${label}"`, ok: false, ms: Date.now() - startedAt, error: String(reason).split('\n')[0] })
        continue
      }
    } else {
      steps.push({ step: `open "${label}"`, ok: true, ms: 0, note: 'already open' })
    }

    /*
     * Fill the finder now, while this drawer is the open one. An empty search term lists
     * everything, which is the reliable way to fill it: Query Store's capture mode decides whether
     * any particular term matches anything.
     */
    if (populatePlanFinder) {
      const submit = drawer.getByRole('button', { name: /^(?:Route it|Find plans)$/ })
      if ((await submit.count()) > 0) {
        const submittedAt = Date.now()
        try {
          await submit.click({ timeout: TRUSTED_CLICK_TIMEOUT_MS })
          await page.locator('.hud-results li').first().waitFor({ state: 'visible', timeout: 30000 })
          steps.push({ step: 'populate plan finder', ok: true, ms: Date.now() - submittedAt })
        } catch (reason) {
          steps.push({ step: 'populate plan finder', ok: false, ms: Date.now() - submittedAt, error: String(reason).split('\n')[0] })
        }
      }
    }

    regions[label] = await sidebarGeometry(page)
  }

  /*
   * What the accordion left open, recorded rather than assumed.
   *
   * Under an accordion this is one region, and every geometry read after this point describes that
   * region and not the others. Without recording it, a snapshot showing three closed drawers reads
   * as three squeezed drawers instead of the accordion working -- which is the misreading #118 was
   * filed for.
   */
  const open = await page.locator('.sidebar-drawer, .sidebar-directory').evaluateAll(
    list => list.filter(element => element.open).map(element => element.querySelector(':scope > summary')?.textContent?.trim() ?? '?'),
  )
  steps.push({ step: 'regions left open', ok: true, ms: 0, note: open.length ? open.join(', ') : 'none' })

  return { steps, regions }
}

/**
 * Routes a captured plan, which is the one state where the card takes the whole rail over.
 *
 * Worth its own pass because it is not a bigger version of the place card -- the address book, the
 * feed and every drawer stop being rendered, so the card is the column's only flex item and the
 * rules that hold it are different ones. #120 lived exactly here: 1028px of card in a 900px
 * `overflow: hidden` rail, 229px of a routed plan unreachable, while every other state on this run
 * reported a clean column.
 *
 * Must run while the plan finder is still rendered -- see the ordering note at the call site. A
 * missing finder is reported as a *failure* rather than a pass with a note, because the state this
 * pass exists to measure was not measured, and any geometry recorded next to it would belong to
 * whatever the column happened to be showing instead.
 */
export async function openRoutedPlan(page) {
  const startedAt = Date.now()
  const drawer = page.locator('.sidebar-drawer').filter({ hasText: 'Route a captured query plan' }).first()
  try {
    if ((await drawer.count()) === 0) {
      return {
        step: 'route a captured plan',
        ok: false,
        ms: 0,
        error: 'plan finder not rendered, so the routed-plan state was never entered',
      }
    }
    if (!(await drawer.evaluate(element => element.open))) {
      await drawer.locator('> summary').click({ timeout: TRUSTED_CLICK_TIMEOUT_MS })
    }
    const results = page.locator('.hud-results li')
    if ((await results.count()) === 0) {
      await drawer.getByRole('button', { name: /^(?:Route it|Find plans)$/ }).click({ timeout: TRUSTED_CLICK_TIMEOUT_MS })
      await results.first().waitFor({ state: 'visible', timeout: 30000 })
    }
    await results.first().click({ timeout: TRUSTED_CLICK_TIMEOUT_MS })
    await page.locator('.sidebar-place-card.is-full').waitFor({ state: 'visible', timeout: TRUSTED_CLICK_TIMEOUT_MS })
    return { step: 'route a captured plan', ok: true, ms: Date.now() - startedAt }
  } catch (reason) {
    return { step: 'route a captured plan', ok: false, ms: Date.now() - startedAt, error: String(reason).split('\n')[0] }
  }
}

/**
 * Clears an open route, putting the address book back so later passes have a column to work with.
 *
 * The route's back button *is* the clear control -- `sidebarMode` swaps it from "back to the atlas"
 * to "back to <database>" whenever a route is open -- so this is the reader's own way out, not a
 * probe-only reset.
 */
export async function dismissRoutedPlan(page) {
  const startedAt = Date.now()
  try {
    if ((await page.locator('.sidebar-place-card.is-full').count()) === 0) {
      return { step: 'clear the routed plan', ok: true, ms: 0, note: 'no route open' }
    }
    await page.locator('.sidebar-back').first().click({ timeout: TRUSTED_CLICK_TIMEOUT_MS })
    await page.locator('.sidebar-place-card.is-full').waitFor({ state: 'detached', timeout: TRUSTED_CLICK_TIMEOUT_MS })
    return { step: 'clear the routed plan', ok: true, ms: Date.now() - startedAt }
  } catch (reason) {
    return { step: 'clear the routed plan', ok: false, ms: Date.now() - startedAt, error: String(reason).split('\n')[0] }
  }
}

/** Opens a place card by selecting an address, so the card competes for the rail like the rest. */
export async function openPlaceCard(page) {
  const entry = page.locator('.address-entry').first()
  const startedAt = Date.now()
  try {
    await openDirectory(page)
    await entry.waitFor({ state: 'visible', timeout: 10000 })
    await entry.click({ timeout: TRUSTED_CLICK_TIMEOUT_MS })
    await page.locator('.sidebar-place-card').waitFor({ state: 'visible', timeout: TRUSTED_CLICK_TIMEOUT_MS })
    return { step: 'open place card', ok: true, ms: Date.now() - startedAt }
  } catch (reason) {
    return { step: 'open place card', ok: false, ms: Date.now() - startedAt, error: String(reason).split('\n')[0] }
  }
}

/** Heights of the sections that give way, so "no overflow" is never quoted on its own. */
export async function sidebarGeometry(page) {
  return page.evaluate(() => {
    const readElement = (element) => {
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
    const read = (selector) => readElement(document.querySelector(selector))

    /*
     * Each drawer separately, not just the wrapper.
     *
     * The wrapper's own overflow says nothing about how its budget was divided, and a division
     * that squeezes one drawer to its summary is the #63 defect wearing the wrapper's clean
     * numbers. The label is the summary text so a share can be attributed to the drawer that got
     * it, and `open` is recorded because a closed drawer costs its summary and nothing else.
     */
    const drawerList = [...document.querySelectorAll('.sidebar-drawer')].map((drawer, index) => {
      const summary = drawer.querySelector(':scope > summary')
      const body = drawer.querySelector(':scope > .sidebar-drawer-body')
      return {
        index,
        label: summary?.textContent?.trim() ?? `drawer ${index}`,
        open: drawer.open,
        summaryHeight: summary ? Math.round(summary.getBoundingClientRect().height) : null,
        maxHeight: getComputedStyle(drawer).maxHeight,
        ...readElement(drawer),
        body: readElement(body),
      }
    })
    return {
      sidebar: read('.map-sidebar'),
      /*
       * Whether the address book's disclosure is open, recorded next to `scroll`.
       *
       * Without this a 0px `.sidebar-scroll` is unattributable: it reads identically whether the
       * column squeezed the list to nothing (the #65 defect) or the reader simply never opened
       * the "City directory" disclosure it now lives inside. One of those is a bug and the other
       * is the resting state, and the harness quoted the defect's numbers for the resting state
       * until this was here.
       */
      directory: (() => {
        const element = document.querySelector('.sidebar-directory')
        if (!element) return null
        return { open: element.open, ...readElement(element) }
      })(),
      /** The address list's scroller: the section that gave way to 0px in #65. */
      scroll: read('.sidebar-scroll'),
      placeCard: read('.sidebar-place-card'),
      /*
       * The routed plan's own scroller, one box inside the card.
       *
       * The card is the only flex item in the takeover state, so making it shrink moves the
       * overflow inwards rather than removing it: `.hud-slideover` is the card's flex item and
       * floors on its own content the same way. #120 needed both, and a run that reports only the
       * card cannot tell "the slideover scrolls" from "the slideover is clipping and the card
       * happens to hide it". Null in every state but the routed plan.
       */
      routeSlideover: read('.sidebar-place-card > .hud-slideover'),
      /*
       * The live query feed, which is a rail region and not a drawer.
       *
       * Measured separately for the reason `eachDrawer` exists: it competes with the address list
       * for the rail's slack, and "the column does not overflow" says nothing about whether a feed
       * can show a whole entry. `rowsVisible` is the number that actually answers that -- as a
       * fourth drawer this read 0.4 rows at rest while every overflow number was 0.
       */
      feed: read('.sidebar-feed'),
      feedBody: (() => {
        const body = document.querySelector('.sidebar-feed-body')
        if (!body) return null
        const row = document.querySelector('.query-ticker-row')
        const rowHeight = row ? row.getBoundingClientRect().height : null
        return {
          ...readElement(body),
          rows: document.querySelectorAll('.query-ticker-row').length,
          rowHeight,
          rowsVisible: rowHeight ? Math.round((body.clientHeight / rowHeight) * 10) / 10 : null,
        }
      })(),
      drawers: read('.sidebar-drawers'),
      drawerCap: (() => {
        const wrapper = document.querySelector('.sidebar-drawers')
        if (!wrapper) return null
        const style = getComputedStyle(wrapper)
        return {
          budget: style.getPropertyValue('--sidebar-drawer-budget').trim() || null,
          cap: style.getPropertyValue('--sidebar-drawer-cap').trim() || null,
        }
      })(),
      eachDrawer: drawerList,
    }
  })
}
