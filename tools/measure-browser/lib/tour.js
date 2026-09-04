import { frameReport } from './stats.js'

/**
 * What the guided tour costs, and whether it is actually doing anything.
 *
 * The tour is an attract mode: it is meant to be left running on a wall display for hours, moving
 * the camera on every frame of it. That makes it the most expensive thing this scene can be asked
 * to do and the easiest thing to get wrong quietly, because *every* failure mode looks fine in a
 * screenshot:
 *
 * - A tour that never starts shows a city. So does a tour that started.
 * - A tour that re-arms the shadow map shows a city. So does one that does not — the difference is
 *   948 draw calls and ~7.6 ms a frame, invisible except in `offscreen`.
 * - A tour that keeps its loop scheduled after being switched off shows a city, at rest, forever
 *   running a callback that does nothing.
 *
 * So each of those is measured as its own number rather than inferred from a picture.
 */

/** Reads the tour caption, the toggle's pressed state, and the compass, in one go. */
async function tourReadout(page) {
  return page.evaluate(() => {
    const caption = document.querySelector('.hud-tour')
    const toggle = document.querySelector('.hud-tour-toggle')
    const compass = document.querySelector('.hud-compass')
    const text = (node) => (node ? (node.textContent ?? '').trim() : null)
    return {
      captionMounted: Boolean(caption),
      kind: text(caption?.querySelector('.hud-tour-kind')),
      caption: text(caption?.querySelector('strong')),
      detail: text(caption?.querySelector('.hud-tour-detail')),
      pressed: toggle ? toggle.getAttribute('aria-pressed') === 'true' : null,
      toggleLabel: text(toggle),
      compass: text(compass),
      roadReadoutMounted: Boolean(document.querySelector('.hud-road-readout')),
      status: text(document.querySelector('p[role="status"]')),
      /*
       * The live vehicle roster, read out of the page's own prose rather than from the scene.
       *
       * This is here to keep the post-drag idle reading honest. Vehicles animate on their own loop,
       * every frame, for as long as anything is sampled as moving — so on a busy instance a page
       * that never goes quiet may be reporting the vehicle loop rather than a tour that failed to
       * stop, and the two are indistinguishable in a callback count. `vehicleSummaryLabel` renders
       * exactly one of "N driving", "N unplaced", "Not matchable" or "None sampled", so matching it
       * says which case this run was. Read from `textContent`, not `innerText`: the roster line
       * lives inside a closed `<details>`, and `innerText` reports rendered text only, so it comes
       * back empty from exactly the collapsed state the page is normally in.
       */
      vehicles: (/(\d+ driving|\d+ unplaced|Not matchable|None sampled)/.exec(document.body.textContent ?? '') ?? [])[1] ?? null,
    }
  })
}

/**
 * The caption's geometry, in the terms `AGENTS.md` asks for.
 *
 * `unreachable` is the number that matters and it is deliberately not just `scrollHeight -
 * clientHeight`: overshoot is only unreachable when the box cannot scroll. It is measured against
 * the viewport too, because this element is `position: absolute` with a `translateX(-50%)` and the
 * way it fails is by hanging off an edge rather than by clipping its own content.
 */
async function captionGeometry(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.hud-tour')
    if (!el) return null
    const style = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    const overshoot = el.scrollHeight - el.clientHeight
    const scrollable = style.overflowY === 'auto' || style.overflowY === 'scroll'
    return {
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      overflowY: style.overflowY,
      unreachable: scrollable ? 0 : Math.max(0, overshoot),
      rect: {
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      // The whole element inside the viewport, with nothing hanging off an edge.
      onScreen:
        rect.left >= 0 &&
        rect.top >= 0 &&
        rect.right <= window.innerWidth &&
        rect.bottom <= window.innerHeight,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    }
  })
}

/** Counts rAF callbacks and draw calls over a window. Callbacks alone separate "at rest" from
 *  "a loop is running and drawing nothing"; draw calls say whether it is doing work. */
async function callbackRate(page, ms) {
  const before = await page.evaluate(() => ({
    raf: window.__measure.rafTotal,
    calls: window.__measure.live.calls,
    at: performance.now(),
  }))
  await page.waitForTimeout(ms)
  const after = await page.evaluate(() => ({
    raf: window.__measure.rafTotal,
    calls: window.__measure.live.calls,
    at: performance.now(),
  }))
  const elapsed = after.at - before.at
  return {
    windowMs: Math.round(elapsed),
    callbacks: after.raf - before.raf,
    perSecond: Number(((after.raf - before.raf) / (elapsed / 1000)).toFixed(1)),
    drawCalls: after.calls - before.calls,
  }
}

/**
 * Wait until the page goes quiet, and report how long that took.
 *
 * Reporting the settling time rather than assuming one is the point. A fixed sleep before the idle
 * window is a guess, and a guess that lands mid-decay reports a stopped loop as a running one —
 * which is what a 3-second window did here, giving 0.7/s on the rail and exactly 5.0/s on the
 * sheet for the same code. Polling separates the two claims: *that* it went quiet, and *when*.
 */
async function waitForQuiet(page, { maxMs = 15000, windowMs = 1000, threshold = 5 } = {}) {
  const startedAt = Date.now()
  let last = null
  while (Date.now() - startedAt < maxMs) {
    last = await callbackRate(page, windowMs)
    if (last.perSecond < threshold) {
      return { quiet: true, settledAfterMs: Date.now() - startedAt, last }
    }
  }
  return { quiet: false, settledAfterMs: Date.now() - startedAt, last }
}

/**
 * Start the tour with a trusted click, and measure everything it does.
 *
 * `locator.click()` hit-tests, so it fails when a sibling overlaps the toggle. `element.click()`
 * via `evaluate` and `click({ force: true })` both bypass hit-testing and would pass while the
 * control was covered — reported here as its own pass/fail line for that reason.
 *
 * `control: true` runs the identical pass with the toggle never clicked. That exists because the
 * post-drag idle rate is only evidence about the *tour* loop if something else is not also drawing.
 * On an instance under live load the vehicle loop animates every frame it has a roster for, so the
 * page never goes quiet whether the tour ran or not, and the same reading that means "the tour is
 * stuck" on an idle instance means nothing at all on a busy one. Running the control gives the
 * number to compare against instead of a guess about which loop the callbacks belonged to.
 */
export async function tourPass(page, { seconds = 12, sampleMs = 1500, control = false } = {}) {
  const toggle = page.locator('.hud-tour-toggle')
  await toggle.waitFor({ state: 'visible', timeout: 30000 })

  const before = await tourReadout(page)
  const idleBefore = await callbackRate(page, 2000)

  let trustedClick = { ok: false, ms: null, error: null, skipped: control }
  if (!control) {
    const clickAt = Date.now()
    try {
      await toggle.click({ timeout: 5000 })
      trustedClick = { ok: true, ms: Date.now() - clickAt, error: null, skipped: false }
    } catch (error) {
      trustedClick = { ok: false, ms: Date.now() - clickAt, error: String(error).split('\n')[0], skipped: false }
    }
  }

  await page.waitForTimeout(600)
  const started = await tourReadout(page)
  const geometry = await captionGeometry(page)

  /*
   * Frame cost while the tour flies. `offscreenDrawCalls` is the line to read first: the sun is
   * directional and its shadow map is rendered from the light, so a camera moving underneath it
   * cannot change a texel. Anything but a median of 0 means the tour re-armed the pass that #90
   * removed, and did it on the longest-running thing this scene does.
   */
  await page.evaluate(() => window.__measure.start())

  // Sample the caption and the compass across the flight. Two things are being settled: that the
  // camera moves at all, and that the itinerary advances rather than parking on one shot.
  const samples = []
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    await page.waitForTimeout(sampleMs)
    const read = await tourReadout(page)
    samples.push({ at: Date.now(), kind: read.kind, caption: read.caption, compass: read.compass })
  }

  const flight = await page.evaluate(() => window.__measure.stop())

  const captions = samples.map(sample => sample.caption).filter(Boolean)
  const headings = samples.map(sample => sample.compass).filter(Boolean)

  /*
   * Ending it the way a viewer does, with a trusted drag on the canvas rather than the toggle.
   *
   * This is the interaction the design turns on: grabbing the camera ends the tour from inside the
   * scene, which reports back up and un-presses the button nobody touched. A tour that carried on,
   * or one that fought the drag, would both show here as `pressed` still true.
   */
  const canvas = page.locator('canvas.city-canvas')
  const box = await canvas.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 30, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(700)

  const afterDrag = await tourReadout(page)

  /*
   * Whether the loop stopped, measured after letting OrbitControls' damping finish.
   *
   * Two things run after the drag and only one of them is the tour: `endTourOnInput` calls
   * `controls.update()` to hand the camera back, which starts the scene's *damping* loop, and that
   * decays over several seconds. Sampling a fixed window immediately after conflates the two and
   * reports a perfectly stopped tour as a running one — a 3-second window did exactly that here,
   * giving 0.7/s on the rail and exactly 5.0/s on the sheet for identical code. So the wait polls
   * until the page is actually at rest, and reports that as its own finding.
   */
  const settling = await waitForQuiet(page)
  // Confirmed over a longer window once quiet, so a single lucky sample cannot pass this.
  const idleAfter = await callbackRate(page, 4000)
  const flightReport = frameReport(flight.frames)

  /*
   * What "the loop stopped" is measured against.
   *
   * Not zero, and not the pre-tour idle either. This page is never wholly still: it polls for fresh
   * data, and on a busy instance the vehicle loop animates a live roster on its own handle. An
   * absolute `drawCalls === 0` test therefore failed against a scene that had genuinely stopped
   * moving. The pre-tour sample looks like the obvious control and is not one — it is taken before
   * the live roster has arrived, so it reports a quieter page than the one the post-drag sample
   * sees. Measured on the same 4,200-object instance: 1.0/s before, 17 vehicles driving by the end,
   * and 5.9/s after, for a tour that had demonstrably stopped.
   *
   * A running tour loop, by contrast, calls `requestAnimationFrame` on every frame, so its rate is
   * the rate the page can draw at. That is measurable in the same run and varies by two orders of
   * magnitude across the cities this is pointed at, which is why it is read rather than assumed:
   * the tour flew at 42/s on the 4,200-object city and 204/s on the 64-object one. Half of that
   * separates "still flying" from "background redraw" on both, and the 5/s floor keeps a nearly
   * silent page from being held to a fraction of a number close to zero.
   *
   * Cross-checked with `--control`, which runs the identical pass without ever starting the tour:
   * with the same 17-vehicle roster it read 4.2/s, against 5.9-6.2/s after a real tour. Both are
   * the same background work; neither is anywhere near a loop running every frame.
   *
   * Proven to bind by mutation, because a check that has never failed is not evidence. Orphaning
   * the loop on purpose — dropping `cancelAnimationFrame` from `stopTourLoop` *and* the `tourActive`
   * bail from its `step`, since either one alone still stops it — turned this line FAIL at 143.9/s
   * against a 72.5/s ceiling, with `went quiet` NO after the full 15s budget. Reverting restored
   * PASS at 0.5/s from a byte-identical bundle. Note that the mutant has to reach the browser: see
   * the publish note in `measure-tour.js`.
   */
  const stoppedThreshold = Math.max(5, (flightReport.fps ?? 0) / 2)

  return {
    before: { captionMounted: before.captionMounted, pressed: before.pressed, toggleLabel: before.toggleLabel },
    idleCallbacksBefore: idleBefore,
    trustedClick,
    started: {
      pressed: started.pressed,
      toggleLabel: started.toggleLabel,
      captionMounted: started.captionMounted,
      kind: started.kind,
      caption: started.caption,
      detail: started.detail,
      status: started.status,
      // The tour owns the bottom-centre slot outright while it runs; see the viewport's comment.
      roadReadoutMounted: started.roadReadoutMounted,
    },
    captionGeometry: geometry,
    flight: flightReport,
    itinerary: {
      samples: samples.length,
      distinctCaptions: new Set(captions).size,
      kinds: [...new Set(samples.map(sample => sample.kind).filter(Boolean))],
      visited: captions,
      distinctHeadings: new Set(headings).size,
      cameraMoved: new Set(headings).size > 1,
      advanced: new Set(captions).size > 1,
    },
    endedByDrag: {
      pressed: afterDrag.pressed,
      toggleLabel: afterDrag.toggleLabel,
      captionMounted: afterDrag.captionMounted,
      // What else was still moving when the idle window was taken. See `tourReadout`.
      vehicles: afterDrag.vehicles,
      // The property the whole "not a pause" decision rests on.
      stopped: afterDrag.pressed === false && !afterDrag.captionMounted,
    },
    idleCallbacksAfter: idleAfter,
    settling,
    control,
    // The threshold and its justification are built above, beside the measurements that set it.
    stoppedThreshold: Number(stoppedThreshold.toFixed(1)),
    loopStopped: settling.quiet && idleAfter.perSecond <= stoppedThreshold,
  }
}
