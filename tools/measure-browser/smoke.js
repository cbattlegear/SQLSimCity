import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { launch, instrument, VIEWPORTS } from './lib/city.js'
import { sidebarGeometry } from './lib/address.js'

const { values } = parseArgs({ options: {
  origin: { type: 'string' }, database: { type: 'string', default: 'SmokeCity' },
  out: { type: 'string' }, headed: { type: 'boolean', default: false },
} })
assert(values.origin && values.out, '--origin <API origin> --out <artifact-directory> are required')
await mkdir(values.out, { recursive: true })
const rig = await launch({ headed: values.headed })
const report = { origin: values.origin, database: values.database, results: [], errors: [] }

async function json(path) {
  const response = await rig.context.request.get(`${values.origin}${path}`)
  assert(response.ok(), `${path}: HTTP ${response.status()}`)
  return response.json()
}

async function click(locator, label, clicks) {
  const started = Date.now()
  try {
    await locator.click({ timeout: 15000 })
    const result = { label, ok: true, ms: Date.now() - started }
    clicks.push(result)
    console.log(`trusted click ${label}: PASS (${result.ms}ms)`)
  } catch (error) {
    clicks.push({ label, ok: false, ms: Date.now() - started, error: String(error) })
    throw error
  }
}

try {
  const atlas = await json('/api/v1/atlas')
  const database = atlas.databases.find(item => item.name === values.database)
  assert(database, `Actual atlas must contain seeded ${values.database}`)
  report.databaseId = database.databaseId
  const city = await json(`/api/v1/database-city/${encodeURIComponent(database.databaseId)}?metric=Cpu&pageSize=50`)
  assert(city.objects.length >= 2, 'Connected catalog must contain seeded objects')
  assert(city.topQueryFamilies.length > 0, 'Connected Query Store must contain captured families')
  assert(city.routes.some(route => route.kind === 'ObjectReference'), 'Seeded multi-table plan must yield a route')
  report.connected = { objects: city.objects.length, families: city.topQueryFamilies.length, routes: city.routes.length }
  // The first object is initially selected by the view. Pick a different table so a broken click
  // cannot pass merely because its evidence was already on screen.
  const object = city.objects.filter(item => item.kind === 'Table')[1]
  assert(object)

  for (const viewport of Object.values(VIEWPORTS)) {
    const page = await rig.context.newPage()
    const result = { viewport, clicks: [], geometry: {} }
    report.results.push(result)
    page.on('pageerror', error => report.errors.push(String(error)))
    await page.setViewportSize(viewport)
    await instrument(page)
    try {
      await page.goto(`${values.origin}/?mode=city`, { waitUntil: 'domcontentloaded' })
      await click(page.locator('.address-entry').filter({
        has: page.locator('strong', { hasText: values.database }),
      }).first(), 'atlas database', result.clicks)
      await click(page.getByRole('button', { name: 'Enter database city' }), 'enter city', result.clicks)
      await page.locator('.sidebar-directory > summary').waitFor({ state: 'visible', timeout: 60000 })
      await page.locator('.city-loading').waitFor({ state: 'detached', timeout: 60000 })
      result.geometry.rest = await sidebarGeometry(page)
      await click(page.locator('.sidebar-directory > summary'), 'city directory', result.clicks)
      const search = page.getByRole('searchbox', { name: 'Search queries, tables and infrastructure' })
      await click(search, 'directory search', result.clicks)
      await search.fill(object.name)
      result.geometry.directory = await sidebarGeometry(page)
      await click(page.locator('.address-entry').filter({
        has: page.locator('.address-icon.is-table'),
      }).first(), 'table evidence', result.clicks)
      const card = page.locator('.sidebar-place-card')
      await card.waitFor({ state: 'visible' })
      assert.match(await card.innerText(), /Attributed evidence/)
      assert.equal(await card.locator('h2').innerText(), `${object.schemaName}.${object.name}`,
        'Selected evidence must belong to selected table')
      assert.equal(await card.locator('dl > div').filter({
        has: page.getByText('Reserved pages', { exact: true }),
      }).locator('dd').innerText(), object.reservedPages8KiB, 'Rendered value must equal the actual API evidence')
      result.geometry.evidence = await sidebarGeometry(page)
      await page.screenshot({ path: resolve(values.out, `${viewport.name}-evidence.png`) })

      // Selecting a table may keep its directory term pinned. Clear it before opening another region.
      await search.fill('')
      const finder = page.locator('.sidebar-drawer').filter({ hasText: 'Route a captured query plan' }).first()
      await click(finder.locator('> summary'), 'plan finder', result.clicks)
      await click(finder.getByRole('button', { name: /^(?:Route it|Find plans)$/ }), 'search captured plans', result.clicks)
      const choice = page.locator('.hud-results li button').first()
      await choice.waitFor({ state: 'visible', timeout: 60000 })
      result.geometry.finder = await sidebarGeometry(page)
      await click(choice, 'route captured evidence', result.clicks)
      await page.locator('.sidebar-place-card.is-full').waitFor({ state: 'visible', timeout: 60000 })
      result.geometry.route = await sidebarGeometry(page)
      await page.screenshot({ path: resolve(values.out, `${viewport.name}-route.png`) })
      result.renderer = await page.evaluate(() => window.__measure.rendererName)
      for (const [state, geometry] of Object.entries(result.geometry)) {
        assert(geometry.sidebar?.clientHeight >= 100, `${state} sidebar must remain usable`)
        assert.equal(geometry.sidebar.unreachablePx, 0, `${state} sidebar must not clip content`)
      }
      assert(result.geometry.directory.scroll?.clientHeight >= 36, 'Directory must show at least one usable row')
      assert(result.geometry.evidence.placeCard?.clientHeight >= 48, 'Evidence card must not collapse')
      await click(page.locator('.sidebar-back').first(), 'back from route', result.clicks)
      await page.locator('.sidebar-place-card.is-full').waitFor({ state: 'detached' })
    } catch (error) {
      result.failure = String(error.stack ?? error)
      result.sidebarText = await page.locator('.map-sidebar').innerText()
      await page.screenshot({ path: resolve(values.out, `${viewport.name}-failure.png`) })
      throw error
    } finally {
      await page.close()
    }
  }
  assert.deepEqual(report.errors, [], 'Browser must not report uncaught errors')
} catch (error) {
  report.failure = String(error.stack ?? error)
  throw error
} finally {
  await writeFile(resolve(values.out, 'browser-smoke.json'), JSON.stringify(report, null, 2))
  await rig.browser.close()
}
