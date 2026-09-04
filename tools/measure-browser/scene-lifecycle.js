import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createServer } from '../../web/node_modules/vite/dist/node/index.js'
import { launch, instrument, VIEWPORTS } from './lib/city.js'

const { values } = parseArgs({ options: {
  out: { type: 'string' }, baseline: { type: 'boolean', default: false },
  headed: { type: 'boolean', default: false },
} })
assert(values.out, '--out <artifact-directory> is required')
await mkdir(values.out, { recursive: true })
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const fixture = resolve(root, 'tools/measure-browser/lib/sceneFixture.ts').replaceAll('\\', '/')
const server = await createServer({
  configFile: false, root: resolve(root, 'web'), server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
  resolve: { dedupe: ['three'] },
  plugins: [{
    name: 'scene-lifecycle-fixture',
    configureServer(vite) {
      vite.middlewares.use('/__scene_lifecycle', (_request, response) => {
        response.setHeader('Content-Type', 'text/html')
        response.end(`<html><body style="margin:0"><canvas style="width:100vw;height:100vh;display:block"></canvas><script type="module" src="/@fs/${fixture}"></script></body></html>`)
      })
    },
  }],
})
let browser
const results = []
const failures = []
try {
  await server.listen()
  const launched = await launch({ headed: values.headed })
  browser = launched.browser
  for (const viewport of Object.values(VIEWPORTS)) {
    const page = await launched.context.newPage()
    page.on('pageerror', error => failures.push(String(error)))
    await page.setViewportSize(viewport)
    await instrument(page)
    await page.goto(`${server.resolvedUrls.local[0]}__scene_lifecycle`)
    await page.waitForFunction(() => !!window.__sceneFixture, undefined, { polling: 100 })
    // Asset arrival changes geometry. Let it settle before sampling camera-only work.
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1500)
    const clickAt = Date.now()
    await page.locator('canvas').click()
    const trustedClick = { ok: true, ms: Date.now() - clickAt }
    await page.mouse.move(500, 250)
    await page.mouse.down()
    await page.mouse.move(660, 310, { steps: 8 })
    await page.mouse.up()
    await page.evaluate(() => { window.__sceneFixture.start(); window.__measure.start() })
    await page.waitForTimeout(2500)
    const active = await page.evaluate(() => ({
      ...window.__measure.stop(), state: window.__sceneFixture.state(),
    }))
    const result = { viewport, trustedClick, active }
    results.push(result)
    assert(active.state.moving > 0, 'Fixture must actually animate a vehicle')
    assert(active.state.tour, 'Fixture tour must be active')
    assert(active.browserFrames.some(frame => frame.renders > 0), 'Scene submissions must be observed')
    if (!values.baseline) assert(Math.max(...active.browserFrames.map(frame => frame.renders)) <= 1,
      'Multiple full-scene submissions in one browser frame')

    await page.evaluate(() => { window.__measure.start(); window.__sceneFixture.invalidate() })
    await page.waitForTimeout(500)
    const invalidation = await page.evaluate(() => window.__measure.stop())
    result.invalidation = invalidation
    assert(invalidation.browserFrames.some(frame => frame.offCalls > 0), 'Content change must redraw shadows')
    const steady = active.browserFrames.slice(5).map(frame => frame.offCalls).sort((a, b) => a - b)
    assert.equal(steady[Math.floor(steady.length / 2)], 0, 'Camera/vehicles must not continuously invalidate shadows')
    await page.screenshot({ path: resolve(values.out, `${viewport.name}-city.png`) })
    await page.evaluate(() => window.__sceneFixture.mode('map'))
    await page.waitForTimeout(300)
    await page.screenshot({ path: resolve(values.out, `${viewport.name}-map.png`) })
    await page.evaluate(() => { window.__sceneFixture.mode('city'); window.__sceneFixture.stop() })
    await page.waitForTimeout(1800)
    const beforeIdle = await page.evaluate(() => window.__measure.rafTotal)
    await page.evaluate(() => new Promise(resolve => window.__measure.sampleFrame(() => resolve())))
    await page.waitForTimeout(600)
    const idleCallbacks = await page.evaluate(before => window.__measure.rafTotal - before, beforeIdle)
    result.idleCallbacks = idleCallbacks
    assert.equal(idleCallbacks, 0, 'Empty/stopped controllers must leave no idle callbacks')

    await page.evaluate(() => window.__sceneFixture.start())
    await page.waitForTimeout(200)
    await page.evaluate(() => window.__sceneFixture.dispose())
    const beforeDispose = await page.evaluate(() => window.__measure.rafTotal)
    await page.waitForTimeout(400)
    const disposedCallbacks = await page.evaluate(before => window.__measure.rafTotal - before, beforeDispose)
    result.disposedCallbacks = disposedCallbacks
    if (!values.baseline) assert.equal(disposedCallbacks, 0, 'Dispose must cancel every pending owned callback')
    console.log(`${viewport.name}: trusted click PASS ${trustedClick.ms}ms; max renders/frame ${Math.max(...active.browserFrames.map(f => f.renders))}; idle callbacks ${idleCallbacks}; disposed callbacks ${disposedCallbacks}; renderer ${active.renderer}`)
    await page.close()
  }
  assert.deepEqual(failures, [], 'No browser errors')
} finally {
  await writeFile(resolve(values.out, 'scene-lifecycle.json'), JSON.stringify({
    baseline: values.baseline, scope: 'Deterministic real-browser controller fixture, not connected SQL evidence or GPU latency', results, failures,
  }, null, 2))
  await browser?.close()
  await server.close()
}
