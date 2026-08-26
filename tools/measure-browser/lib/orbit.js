import { frameReport } from './stats.js'

/**
 * Frame cost while orbiting the city.
 *
 * The orbit is driven with `page.mouse`, which issues trusted input through the browser's
 * own event pipeline — the same path a hand on a mouse takes. Dispatching synthetic
 * `pointermove` events from `evaluate` would drive OrbitControls just as well and would
 * skip hit-testing, so a control that was covered by something else would still appear to
 * work. Trusted input is the only kind that is evidence.
 *
 * The drag runs until enough frames have been *recorded*, not for a fixed wall time. A
 * scene rendering at 60 fps and a scene rendering at 1 fps both need a usable sample, and a
 * four-second drag gives the second one almost nothing — which is how the first run of this
 * harness came to quote a median over a single frame.
 */
export async function orbit(page, { minFrames = 14, maxSeconds = 90, stepDelayMs = 40 } = {}) {
  const canvas = page.locator('canvas.city-canvas')
  await canvas.waitFor({ state: 'visible' })
  const box = await canvas.boundingBox()
  if (!box) throw new Error('The city canvas has no box, so there is nothing to orbit.')

  const centreX = box.x + box.width / 2
  const centreY = box.y + box.height / 2
  const radius = Math.min(box.width, box.height) * 0.22

  await page.evaluate(() => window.__measure.start())

  await page.mouse.move(centreX + radius, centreY)
  await page.mouse.down()

  const startedAt = Date.now()
  const deadline = startedAt + maxSeconds * 1000
  let step = 0
  let recorded = 0
  while (recorded < minFrames && Date.now() < deadline) {
    step += 1
    const angle = (step / 40) * Math.PI * 2
    await page.mouse.move(centreX + Math.cos(angle) * radius, centreY + Math.sin(angle) * radius * 0.35)
    await page.waitForTimeout(stepDelayMs)
    recorded = await page.evaluate(() => window.__measure.frames.length)
  }
  const dragMs = Date.now() - startedAt
  await page.mouse.up()
  // Damping keeps rendering after the pointer stops; those frames are part of the orbit.
  await page.waitForTimeout(1500)

  const result = await page.evaluate(() => window.__measure.stop())
  return {
    ...frameReport(result.frames),
    dragSeconds: Number((dragMs / 1000).toFixed(1)),
    renderer: result.renderer,
    raw: result.frames,
  }
}

/**
 * Frame cost for a camera move made through the on-screen controls.
 *
 * A second reading taken a different way, because a drag and a button press reach
 * OrbitControls through different code and only one of them is a trusted click on a control
 * that could be covered by something else. `locator.click()` hit-tests and waits for the
 * element to be actionable, so how long it takes is also a direct reading of how long the
 * page spends unable to answer a click.
 */
export async function nudgeOrbit(page, { presses = 6 } = {}) {
  const rotate = page.getByRole('button', { name: 'Rotate left' })
  await rotate.waitFor({ state: 'visible' })
  await page.evaluate(() => window.__measure.start())
  const perPress = []
  for (let press = 0; press < presses; press += 1) {
    const startedAt = Date.now()
    // Trusted click: hit-tested, so a control hidden behind a sibling fails here.
    await rotate.click({ timeout: 60000 })
    perPress.push(Date.now() - startedAt)
    await page.waitForTimeout(150)
  }
  await page.waitForTimeout(1200)
  const result = await page.evaluate(() => window.__measure.stop())
  return {
    ...frameReport(result.frames),
    presses,
    trustedClickMs: perPress,
    trustedClickTotalMs: perPress.reduce((sum, value) => sum + value, 0),
    raw: result.frames,
  }
}
