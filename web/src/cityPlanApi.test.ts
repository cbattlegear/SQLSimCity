import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchPlan, fetchQueryFamilies, QueryStoreRequestError } from './api'
afterEach(() => vi.unstubAllGlobals())
describe('city plan API context', () => {
  it('sends the selected database and opaque cursor with the family search', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL) => new Response('{}', { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    await fetchQueryFamilies('cpu', 'cursor/+1', undefined, 'server/database/sales')
    const url = String(fetch.mock.calls[0]?.[0])
    expect(url).toContain('databaseId=server%2Fdatabase%2Fsales')
    expect(url).toContain('pageToken=cursor%2F%2B1')
  })
  it('preserves normalization failure reasons instead of reporting an empty result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'This Showplan could not be normalized.' }), { status: 422, headers: { 'content-type': 'application/json' } })))
    await expect(fetchPlan('db:123')).rejects.toMatchObject({ status: 422, message: 'This Showplan could not be normalized.' })
  })
  it('keeps unavailable/absent HTTP results distinct from success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
    await expect(fetchPlan('db:123')).rejects.toBeInstanceOf(QueryStoreRequestError)
  })
})
