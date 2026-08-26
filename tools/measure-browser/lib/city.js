import { chromium } from 'playwright'
import { INSTRUMENT_SOURCE } from './instrument.js'

/**
 * Opening a city and getting it into the state the issue is about.
 *
 * The state that matters is the one the view reaches on its own: entering a database
 * backfills up to AUTO_PAGE_LIMIT (80) pages of CITY_PAGE_SIZE (50) objects with no
 * further input, so a measurement taken before that walk finishes is a measurement of a
 * small city wearing a large one's name.
 */

/** The two sides of the 860px breakpoint. The sidebar is a rail above it and a sheet at or below. */
export const VIEWPORTS = {
  rail: { name: 'rail', width: 1440, height: 900 },
  sheet: { name: 'sheet', width: 820, height: 900 },
}

export async function launch({ headed = true, deviceScaleFactor = 1 } = {}) {
  /*
   * Headed by default, and worth a note.
   *
   * Headless Chromium falls back to SwiftShader on many machines, which rasterises in
   * software: frame times taken there measure a CPU renderer, not the GPU a user has. The
   * probe records the unmasked renderer string on every run so the report can say which one
   * served it, but the default is the arrangement that answers the question honestly.
   */
  const browser = await chromium.launch({
    headless: !headed,
    args: [
      '--use-angle=default',
      '--enable-gpu',
      // Long Tasks and Event Timing are on by default; this only ensures the
      // frame-rate limiter does not idle a backgrounded window mid-measurement.
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-background-timer-throttling',
    ],
  })
  const context = await browser.newContext({ deviceScaleFactor })
  return { browser, context }
}

/**
 * Installs the probe on one page.
 *
 * Deliberately per-page and deliberately last. Init scripts run in registration order, and
 * `page.clock` installs its own — which replaces `requestAnimationFrame` wholesale. Registered
 * on the context, the probe would be wrapped *underneath* the clock's replacement and would
 * silently stop seeing frames: the first run with `--clock` reported no frames at all rather
 * than failing. Registering here, after any clock, keeps the probe's wrapper outermost.
 */
export async function instrument(page) {
  await page.addInitScript(INSTRUMENT_SOURCE)
}

export function cityUrl(origin, databaseId, mode = 'city') {
  return `${origin}/?view=city&database=${encodeURIComponent(databaseId)}&mode=${mode}`
}

/**
 * Loads a city and waits for the automatic page walk to finish.
 *
 * `.city-loading` covers both the first load and the single re-layout at the end of the
 * walk, so waiting for it to be detached *twice* is what distinguishes "the first 50
 * objects are on screen" from "the whole database has been laid out".
 */
export async function openCity(page, url, { timeout = 900000 } = {}) {
  const startedAt = Date.now()
  await page.goto(url, { waitUntil: 'domcontentloaded' })

  // First paint of the city: the initial loading screen has gone.
  await page.locator('.map-sidebar').waitFor({ state: 'visible', timeout })

  /*
   * The backfill is done when the object count in the sidebar subtitle stops moving and
   * no loading screen is up. Polling the rendered count rather than the network is
   * deliberate: it is the number the user is shown, and it is the one the address book
   * and the scene are built from.
   */
  const settled = await page.waitForFunction(
    () => {
      const loading = document.querySelector('.city-loading')
      if (loading) return false
      const subtitle = document.querySelector('.sidebar-subtitle, .map-sidebar p')
      const text = document.body.textContent ?? ''
      const match = text.match(/([\d,]+)\s+objects/)
      const count = match ? Number(match[1].replace(/,/g, '')) : 0
      const previous = window.__cityCount ?? -1
      window.__cityCount = count
      const stableFor = count === previous ? (window.__cityStable ?? 0) + 1 : 0
      window.__cityStable = stableFor
      void subtitle
      // Three consecutive identical readings with no loading screen up.
      return stableFor >= 3 ? count : false
    },
    undefined,
    { timeout, polling: 500 },
  )

  const objectCount = await settled.jsonValue()
  const buildings = await page.evaluate(() => {
    const measure = window.__measure
    return { renderer: measure?.rendererName ?? null, contexts: measure?.contexts ?? 0 }
  })

  return { objectCount, loadMs: Date.now() - startedAt, ...buildings }
}

/** Reads the number the address book was actually built from, straight off the rendered list. */
export async function addressCounts(page) {
  return page.evaluate(() => {
    const scroll = document.querySelector('.sidebar-scroll')
    return {
      entries: document.querySelectorAll('.address-entry').length,
      groups: document.querySelectorAll('.address-group').length,
      scrollNodes: scroll ? scroll.querySelectorAll('*').length : 0,
      documentNodes: document.querySelectorAll('*').length,
    }
  })
}

export async function close({ browser }) {
  await browser.close()
}
