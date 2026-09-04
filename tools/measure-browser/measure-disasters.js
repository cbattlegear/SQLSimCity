/*
 * How big are the four disasters on screen, and do they survive the guided tour?
 *
 * `cityDisasters.ts` reports four things -- weathered buildings, building fires, burst water mains
 * and car crashes -- and for a long time only the first of them reached the viewport. When the
 * other three were finally drawn they were *correct and invisible*: the first honest measurement of
 * them covered 15 pixels out of 1,296,000. Every unit test passed against that, because a
 * present-but-unreadable fire is indistinguishable from a legible one to anything reading source or
 * state rather than pixels. This probe is the check that could tell the difference, kept so the
 * next person does not have to rebuild it.
 *
 * It answers two questions:
 *
 * 1. **Is each disaster large enough to notice?** Reported as per-instance bounding boxes, from
 *    connected components, not as one box per colour -- a global box over a single hue spans every
 *    fire in the city at once and reports a legible-looking rectangle the width of the screen.
 * 2. **Does it stay legible while the tour flies?** Disasters are magnified by `labelScreenScale`,
 *    which is a function of camera distance, and `placeDisasters()` is called from `draw()`. So a
 *    moving camera should re-magnify them every frame. A layer frozen at the framing it was built
 *    under would shrink to nothing as the tour pulled away, and that is what this catches.
 *
 * Measured off decoded screenshots. Reading the WebGL drawing buffer directly is not an option --
 * the context is not created with `preserveDrawingBuffer`, so `readPixels` after compositing
 * returns a cleared buffer. The screenshot is the presented frame, which is the thing in question.
 */
import { writeFileSync } from 'node:fs'
import { VIEWPORTS, launch, cityUrl, openCity, instrument, close } from './lib/city.js'
import { decodePng, components } from './lib/pixels.js'

/*
 * The hues the disaster materials are built from, in `DatabaseCityScene.ts`.
 *
 * Matched by Manhattan distance rather than exact equality, and the tolerance is not slack. Scene
 * fog shifts even an opaque `MeshBasicMaterial` with `toneMapped = false`: the wreck is authored as
 * 0xb8352b and the closest pixel actually on screen measured 0xb8433b -- red exact, green and blue
 * both off by more than a dozen. An exact-hex scan of that reported zero wreck pixels for a wreck
 * that was on screen the whole time, and nearly bought a fix for a bug that did not exist.
 */
const TARGETS = [
  { name: 'flame', rgb: [0xff, 0x8b, 0x1f], tol: 70 },
  { name: 'jet', rgb: [0x7f, 0xd4, 0xff], tol: 56 },
  { name: 'puddle', rgb: [0x2f, 0x7f, 0xa8], tol: 46 },
  { name: 'wreck', rgb: [0xb8, 0x35, 0x2b], tol: 52 },
]

const near = target => (r, g, b) =>
  Math.abs(r - target.rgb[0]) + Math.abs(g - target.rgb[1]) + Math.abs(b - target.rgb[2]) <= target.tol

function parseArgs(argv) {
  const args = {
    origin: 'http://127.0.0.1:5080',
    database: 'primary/database/SimCitySmall',
    viewport: 'rail',
    mode: 'city',
    settle: 95,
    samples: 8,
    every: 5,
    json: null,
    shot: null,
    headed: true,
    tour: true,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    switch (flag) {
      case '--origin': args.origin = value; index += 1; break
      case '--database': args.database = value; index += 1; break
      case '--viewport': args.viewport = value; index += 1; break
      case '--mode': args.mode = value; index += 1; break
      case '--settle': args.settle = Number(value); index += 1; break
      case '--samples': args.samples = Number(value); index += 1; break
      case '--every': args.every = Number(value); index += 1; break
      case '--json': args.json = value; index += 1; break
      case '--shot': args.shot = value; index += 1; break
      case '--headless': args.headed = false; break
      case '--no-tour': args.tour = false; break
      case '--help':
        console.log(`Usage: node measure-disasters.js [options]

  --origin <url>       Where the app is served. Default http://127.0.0.1:5080
  --database <id>      City to open. Default primary/database/SimCitySmall
  --viewport rail|sheet   Which side of the 860px breakpoint. Default rail
  --settle <seconds>   How long to wait for the disaster survey. Default 95.
                       The survey reads up to 40 top-ranked families' compiled
                       plans; on a busy Query Store it is a minute or more.
  --samples <n>        How many samples to take. Default 8
  --every <seconds>    Gap between samples. Default 5
  --json <path>        Write the full report
  --shot <path>        Write a final screenshot
  --no-tour            Measure the static framing only, without starting the tour
  --headless           Headless Chromium. Falls back to SwiftShader on many
                       machines, which rasterises in software.

Note: disasters are drawn only where there is evidence for them. If the sidebar
reports no fires or burst mains, the city is healthy or -- far more likely on a
busy instance -- the families carrying that evidence rank outside the top 40 the
survey reads. Clearing Query Store and re-running a seed workload is what makes
them the dominant families again.`)
        process.exit(0)
        break
      default: break
    }
  }
  return args
}

async function sample(page, label) {
  const shot = await page.locator('canvas').screenshot()
  const image = decodePng(shot)
  const result = { label, width: image.width, height: image.height, disasters: {} }
  for (const target of TARGETS) {
    const blobs = components(image, near(target), { dilate: 3, minPixels: 12 })
    result.disasters[target.name] = {
      instances: blobs.length,
      total: blobs.reduce((sum, blob) => sum + blob.pixels, 0),
      largest: blobs.length > 0 ? `${blobs[0].w}x${blobs[0].h}` : null,
      sizes: blobs.slice(0, 4).map(blob => `${blob.w}x${blob.h}`),
    }
  }
  return result
}

function report(result) {
  const parts = TARGETS.map(target => {
    const found = result.disasters[target.name]
    return `${target.name} ${String(found.instances).padStart(2)} @ ${(found.sizes.join(',') || '-').padEnd(24)}`
  })
  console.log(`  ${result.label.padEnd(13)} ${parts.join(' ')}`)
}

async function run() {
  const args = parseArgs(process.argv.slice(2))
  const viewport = VIEWPORTS[args.viewport] ?? VIEWPORTS.rail

  const { browser, context } = await launch({ headed: args.headed })
  const page = await context.newPage()
  await page.setViewportSize({ width: viewport.width, height: viewport.height })
  await instrument(page)

  const load = await openCity(page, cityUrl(args.origin, args.database, args.mode))
  console.log(`loaded ${load.objectCount} objects on ${load.renderer ?? 'unknown renderer'}`)

  console.log(`waiting ${args.settle}s for the disaster survey to settle...`)
  await page.waitForTimeout(args.settle * 1000)

  // The sidebar is the claim; the pixels below are whether the claim reached the viewport.
  const lines = await page.evaluate(() =>
    document.body.innerText
      .split('\n')
      .filter(line => /building fire|burst main|water main|car crash|stale|top-ranked query famil/i.test(line))
      .slice(0, 10))
  console.log('what the sidebar says is wrong with the city:')
  for (const line of lines) console.log(`  | ${line}`)

  console.log('\nper-instance bounding boxes:')
  const before = await sample(page, args.tour ? 'before tour' : 'static')
  report(before)

  const samples = []
  if (args.tour) {
    const started = Date.now()
    // A trusted click. `element.click()` and `{ force: true }` both bypass hit-testing and would
    // pass while the control sat under an overlay, which is how an unusable column once measured
    // healthy.
    await page.locator('.hud-tour-toggle').click({ timeout: 15000 })
    console.log(`\ntrusted click on the tour toggle: PASS (${Date.now() - started}ms)\n`)

    for (let index = 1; index <= args.samples; index += 1) {
      await page.waitForTimeout(args.every * 1000)
      const stop = await page.evaluate(() => {
        const el = document.querySelector('.hud-tour strong')
        return el ? el.textContent : '(no stop)'
      })
      const taken = await sample(page, `t+${index * args.every}s`)
      taken.stop = stop
      samples.push(taken)
      report(taken)
      console.log(`  ${''.padEnd(13)} stop: "${stop}"`)
    }

    console.log('\nacross the tour:')
    for (const target of TARGETS) {
      const seen = samples.filter(s => s.disasters[target.name].instances > 0).length
      const peak = Math.max(...samples.map(s => s.disasters[target.name].total))
      const biggest = samples
        .map(s => s.disasters[target.name].largest)
        .filter(Boolean)
        .sort((a, b) => {
          const [aw, ah] = a.split('x').map(Number)
          const [bw, bh] = b.split('x').map(Number)
          return bw * bh - aw * ah
        })[0]
      console.log(
        `  ${target.name.padEnd(8)} in ${seen}/${samples.length} samples, peak ${peak}px, largest instance ${biggest ?? '-'}`,
      )
    }
    /*
     * A disaster is expected to be absent from some samples: the tour looks at one part of the city
     * at a time, and a fire across town is legitimately off screen. What would be a defect is a
     * disaster that is never seen at all while the sidebar insists it exists, or one whose largest
     * instance shrinks toward a handful of pixels as the tour pulls away from it.
     */
  }

  if (args.shot) await page.screenshot({ path: args.shot })
  if (args.json) writeFileSync(args.json, JSON.stringify({ load, lines, before, samples }, null, 2))
  await close({ browser, context })
}

run().catch(error => {
  console.error('measurement failed:', error)
  process.exit(1)
})
