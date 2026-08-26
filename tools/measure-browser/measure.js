#!/usr/bin/env node
/**
 * The browser workbench.
 *
 * Answers three questions about a large city that reading the code cannot: what a frame
 * costs while orbiting it, how many draw calls that frame submits and how many of them are
 * the shadow pass, and what one keystroke in the address book costs.
 *
 * Nothing here runs in CI, and nothing in `web/` knows it exists.
 *
 *   node measure.js --database "primary/database/SimCityLoad"
 *   node measure.js --viewport sheet --json out.json
 */

import { writeFileSync } from 'node:fs'
import { VIEWPORTS, launch, cityUrl, openCity, addressCounts, instrument } from './lib/city.js'
import { orbit, nudgeOrbit } from './lib/orbit.js'
import { typeSearch, clearSearch, clickFirstEntry, sidebarGeometry } from './lib/address.js'

function parseArgs(argv) {
  const args = {
    origin: 'http://127.0.0.1:5080',
    database: 'primary/database/SimCityLoad',
    viewport: 'both',
    mode: 'city',
    term: 'orders',
    headed: true,
    json: null,
    orbitSeconds: 4,
    label: null,
    screenshot: null,
    clock: null,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    switch (flag) {
      case '--origin': args.origin = value; index += 1; break
      case '--database': args.database = value; index += 1; break
      case '--viewport': args.viewport = value; index += 1; break
      case '--mode': args.mode = value; index += 1; break
      case '--term': args.term = value; index += 1; break
      case '--json': args.json = value; index += 1; break
      case '--label': args.label = value; index += 1; break
      case '--screenshot': args.screenshot = value; index += 1; break
      case '--clock': args.clock = value; index += 1; break
      case '--orbit-seconds': args.orbitSeconds = Number(value); index += 1; break
      case '--headless': args.headed = false; break
      case '--headed': args.headed = true; break
      case '--help':
        console.log(`Usage: node measure.js [options]

  --origin <url>        Where the app is served. Default http://127.0.0.1:5080
  --database <id>       City to open. Default primary/database/SimCityLoad
  --viewport rail|sheet|both   Which side of the 860px breakpoint. Default both
  --mode city|map       Initial view mode. Default city
  --term <text>         What to type into the address book. Default "orders"
  --orbit-seconds <n>   Length of the orbit drag. Default 4
  --label <text>        Recorded in the output, e.g. "before" / "after"
  --screenshot <path>   Save the city after orbiting, e.g. to eyeball the shadows
  --clock <iso>         Pin the hour the city is lit for, e.g. 2026-06-21T08:30:00
  --json <path>         Write the full result, including every frame
  --headless            Run without a window (usually SwiftShader; see README)`)
        process.exit(0)
        break
      default:
        if (flag.startsWith('--')) throw new Error(`Unknown option ${flag}`)
    }
  }
  return args
}

async function measureViewport(context, viewport, args) {
  const page = await context.newPage()
  await page.setViewportSize({ width: viewport.width, height: viewport.height })

  /*
   * Pin the hour when asked.
   *
   * The city is lit for the clock on the machine looking at it, so a run at midnight measures
   * — and photographs — a scene whose key light is almost off. `setFixedTime` fixes what `new
   * Date()` returns without touching timers, which is exactly the surface `timeOfDay.ts` reads,
   * and leaves `requestAnimationFrame` and `performance.now()` alone so the frame numbers stay
   * real. Use it to put the sun somewhere the shadows are actually visible.
   */
  if (args.clock) await page.clock.setFixedTime(new Date(args.clock))
  // After the clock, never before: see `instrument()`.
  await instrument(page)

  const url = cityUrl(args.origin, args.database, args.mode)
  const load = await openCity(page, url)

  const counts = await addressCounts(page)
  const geometry = await sidebarGeometry(page)

  const dragOrbit = await orbit(page, { seconds: args.orbitSeconds })
  const buttonOrbit = await nudgeOrbit(page)

  /*
   * Captured last, and deliberately so.
   *
   * The shadow map is only regenerated when something that casts changes, so the frame worth
   * looking at is one reached entirely through camera-only controls — a drag, six azimuth
   * rotations and a few zooms, none of which invalidate. If the shadows are still under the
   * right buildings here, they survived the whole camera-only path. A capture of the first
   * frame would look correct even with invalidation broken outright.
   *
   * Zoomed in first: at the framing that holds 4,200 buildings a shadow is under a pixel wide.
   */
  if (args.screenshot) {
    const zoomIn = page.getByRole('button', { name: 'Zoom in' })
    for (let press = 0; press < 5; press += 1) {
      await zoomIn.click({ timeout: 60000 })
      await page.waitForTimeout(200)
    }
    await page.waitForTimeout(1500)
    const path = args.screenshot.replace(/(\.png)?$/i, `-${viewport.name}.png`)
    await page.screenshot({ path })
    console.log(`  screenshot: ${path}`)
  }

  const search = await typeSearch(page, args.term)
  const cleared = await clearSearch(page, { term: args.term })
  const entryClick = await clickFirstEntry(page)

  await page.close()

  return {
    viewport: { name: viewport.name, width: viewport.width, height: viewport.height },
    load,
    addressBook: counts,
    sidebarGeometry: geometry,
    orbit: dragOrbit,
    buttonOrbit,
    search,
    cleared,
    trustedEntryClick: entryClick,
  }
}

function line(label, value) {
  return `  ${label.padEnd(34)} ${value}`
}

function report(result) {
  const out = []
  out.push(`\n=== ${result.viewport.name} (${result.viewport.width}x${result.viewport.height}) ===`)
  out.push(line('objects loaded', result.load.objectCount))
  out.push(line('load to settled', `${(result.load.loadMs / 1000).toFixed(1)} s`))
  out.push(line('GPU', result.load.renderer ?? 'unknown'))

  out.push('\n  -- orbit (trusted drag) --')
  out.push(line('drag length', `${result.orbit.dragSeconds} s`))
  out.push(line('frames sampled (steady / total)', `${result.orbit.frames} / ${result.orbit.sampled}`))
  out.push(line('first frame CPU ms', result.orbit.firstFrameCpuMs))
  out.push(line('CPU ms/frame median | p95 | max',
    `${result.orbit.cpuMsPerFrame.median} | ${result.orbit.cpuMsPerFrame.p95} | ${result.orbit.cpuMsPerFrame.max}`))
  out.push(line('  shadow pass ms/frame median',
    `${result.orbit.shadowPassMsPerFrame.median} (max ${result.orbit.shadowPassMsPerFrame.max})`))
  out.push(line('frame interval ms median | p95',
    `${result.orbit.frameIntervalMs.median} | ${result.orbit.frameIntervalMs.p95}`))
  out.push(line('fps (from median interval)', result.orbit.fps))
  out.push(line('draw calls/frame median | max',
    `${result.orbit.drawCalls.median} | ${result.orbit.drawCalls.max}`))
  out.push(line('  of which offscreen (shadow)',
    `${result.orbit.offscreenDrawCalls.median} | ${result.orbit.offscreenDrawCalls.max}`))
  out.push(line('triangles/frame median',
    `${result.orbit.trianglesPerFrame.median?.toLocaleString?.() ?? result.orbit.trianglesPerFrame.median}`))
  out.push(line('  of which offscreen (shadow)',
    `${result.orbit.offscreenTriangles.median?.toLocaleString?.() ?? result.orbit.offscreenTriangles.median}`))

  out.push('\n  -- orbit (trusted clicks on Rotate left) --')
  out.push(line('presses', result.buttonOrbit.presses))
  out.push(line('trusted click ms each', result.buttonOrbit.trustedClickMs.join(', ')))
  out.push(line('CPU ms/frame median | max',
    `${result.buttonOrbit.cpuMsPerFrame.median} | ${result.buttonOrbit.cpuMsPerFrame.max}`))
  out.push(line('draw calls/frame median',
    `${result.buttonOrbit.drawCalls.median} (offscreen ${result.buttonOrbit.offscreenDrawCalls.median})`))

  out.push('\n  -- address book --')
  out.push(line('entries rendered', result.addressBook.entries))
  out.push(line('nodes under .sidebar-scroll', result.addressBook.scrollNodes))
  out.push(line('document nodes', result.addressBook.documentNodes))
  out.push(line('trusted click on search field', `${result.search.trustedClickMs} ms`))
  out.push(line(`typing "${result.search.term}" keystrokes`, result.search.keystrokes))
  out.push(line('key-to-paint ms median | p95 | max',
    `${result.search.keyToPaintMs.median} | ${result.search.keyToPaintMs.p95} | ${result.search.keyToPaintMs.max}`))
  out.push(line('first keystroke to paint', `${result.search.firstKeyToPaintMs} ms`))
  out.push(line('per key', result.search.perKeyToPaintMs.join(', ')))
  out.push(line('long tasks during typing', result.search.longTasksMs.join(', ') || 'none'))
  out.push(line('entries after typing', result.search.entriesAfter.entries))
  out.push(line('clearing: last key to paint', `${result.cleared.lastKeyToPaintMs} ms`))
  out.push(line('clearing: per key', result.cleared.perKeyToPaintMs.join(', ')))
  out.push(line('entries after clearing', result.cleared.entriesAfter.entries))

  out.push('\n  -- reachability --')
  for (const [name, box] of Object.entries(result.sidebarGeometry)) {
    if (!box) { out.push(line(name, 'not present')); continue }
    out.push(line(name, `${box.clientHeight}px visible, ${box.scrollHeight}px content, `
      + `overflow ${box.overflowY}, ${box.unreachablePx}px unreachable`
      + (box.scrollExtentPx ? `, ${box.scrollExtentPx}px scrollable` : '')))
  }
  out.push(line('trusted click on first entry',
    result.trustedEntryClick.ok ? `passed in ${result.trustedEntryClick.ms} ms` : `FAILED: ${result.trustedEntryClick.error}`))
  return out.join('\n')
}

const args = parseArgs(process.argv.slice(2))
const wanted = args.viewport === 'both' ? [VIEWPORTS.rail, VIEWPORTS.sheet] : [VIEWPORTS[args.viewport]]
if (wanted.some(viewport => !viewport)) throw new Error(`Unknown viewport ${args.viewport}`)

const { browser, context } = await launch({ headed: args.headed })
const results = []
try {
  for (const viewport of wanted) {
    const result = await measureViewport(context, viewport, args)
    results.push(result)
    console.log(report(result))
  }
} finally {
  await browser.close()
}

if (args.json) {
  writeFileSync(args.json, JSON.stringify({
    label: args.label,
    origin: args.origin,
    database: args.database,
    mode: args.mode,
    at: new Date().toISOString(),
    results,
  }, null, 2))
  console.log(`\nWrote ${args.json}`)
}
