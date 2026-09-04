import { afterEach, describe, expect, it, vi } from 'vitest'
import { CityEvidenceController, cityEvidenceDisclosure } from './cityEvidence'
import type { CitySourceMode } from './cityEvidence'
import type { DatabaseCityPage } from './databaseCityContracts'

function page(overrides: Partial<DatabaseCityPage> = {}): DatabaseCityPage {
  const evidence = { source: 'QueryStoreAggregate' as const, status: 'Available' as const, observedAt: '2026-09-04T10:00:00Z', freshUntil: '2026-09-04T10:01:00Z', reason: 'Captured facts' }
  return {
    schemaVersion: '1.0', databaseId: 'db', databaseName: 'City', metric: 'Cpu', pageSize: 50,
    nextPageToken: null, totalObjects: '0', schemas: [], objects: [], topQueryFamilies: [], routes: [],
    otherWorkload: { familyCount: '0', executionCount: '0', totalCpuMicroseconds: '0', totalDurationMicroseconds: '0', totalLogicalReads8KiBPages: '0', totalWaitMilliseconds: '0', evidence },
    evidence, ...overrides,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
afterEach(() => { vi.useRealTimers() })

describe('city evidence lifecycle', () => {
  it('records initial success separately from collection time and ages while requests are pending', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T10:00:30Z'))
    const pending = deferred<DatabaseCityPage>()
    const fetch = vi.fn().mockResolvedValueOnce(page()).mockReturnValue(pending.promise)
    const owner = new CityEvidenceController('db', 'cpu', 'live', fetch)
    owner.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(owner.getSnapshot().lastSuccessAt).toBe('2026-09-04T10:00:30.000Z')
    expect(cityEvidenceDisclosure(owner.getSnapshot(), 'live').observedAt).toBe('2026-09-04T10:00:00Z')
    await vi.advanceTimersByTimeAsync(31_000)
    expect(owner.getSnapshot().phase).toBe('refresh')
    expect(cityEvidenceDisclosure(owner.getSnapshot(), 'live').status).toBe('Stale')
    owner.dispose()
    pending.resolve(page())
    await vi.advanceTimersByTimeAsync(0)
    expect(owner.getSnapshot().lastSuccessAt).toBe('2026-09-04T10:00:30.000Z')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains useful city on failure and only recovery replaces it', async () => {
    const original = page()
    const recovered = page({ totalObjects: '12' })
    const fetch = vi.fn().mockResolvedValueOnce(original).mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce(recovered)
    const owner = new CityEvidenceController('db', 'cpu', 'live', fetch)
    await owner.refresh()
    await owner.refresh()
    expect(owner.getSnapshot().page).toBe(original)
    const disclosure = cityEvidenceDisclosure(owner.getSnapshot(), 'live')
    expect(disclosure.status).toBe('Refresh failed')
    expect(disclosure.detail).toContain('Connection lost')
    expect(disclosure.observedAt).toBe(original.otherWorkload.evidence.observedAt)
    await owner.refresh()
    expect(owner.getSnapshot().page).toBe(recovered)
    expect(owner.getSnapshot().error).toBeNull()
  })

  it('a superseded continuation cannot overwrite a newer generation even if abort is ignored', async () => {
    const slow = deferred<DatabaseCityPage>()
    const fetch = vi.fn().mockResolvedValueOnce(page({ nextPageToken: 'next' })).mockReturnValueOnce(slow.promise).mockResolvedValueOnce(page({ totalObjects: '99' }))
    const owner = new CityEvidenceController('db', 'cpu', 'live', fetch)
    const first = owner.refresh()
    await Promise.resolve()
    await owner.refresh()
    slow.resolve(page({ totalObjects: '2' }))
    await first
    expect(owner.getSnapshot().page?.totalObjects).toBe('99')
    expect(owner.getSnapshot().phase).toBe('idle')
  })

  it.each([{ databaseId: 'neighbor' }, { metric: 'Reads' as const }])('refuses a response from another target/ranking', async change => {
    const owner = new CityEvidenceController('db', 'cpu', 'live', vi.fn().mockResolvedValue(page(change)))
    await owner.refresh()
    expect(owner.getSnapshot().page).toBeNull()
    expect(owner.getSnapshot().error).toMatch(/different database or workload ranking/)
  })

  it('cancels the old target owner before it can publish', async () => {
    const old = deferred<DatabaseCityPage>()
    const owner = new CityEvidenceController('db', 'cpu', 'live', () => old.promise)
    const walk = owner.refresh()
    owner.dispose()
    old.resolve(page())
    await walk
    expect(owner.getSnapshot().page).toBeNull()
  })

  it.each<CitySourceMode>(['archive', 'edge'])('keeps %s evidence static and does not poll', async mode => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T10:00:30Z'))
    const fetch = vi.fn().mockResolvedValue(page())
    const owner = new CityEvidenceController('db', 'cpu', mode, fetch)
    owner.start()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(cityEvidenceDisclosure(owner.getSnapshot(), mode).status).toBe('Available')
    expect(cityEvidenceDisclosure(owner.getSnapshot(), mode).detail).toContain('Static captured evidence')
    owner.dispose()
  })

  it('does not let a new catalog timestamp renew old workload evidence', async () => {
    const value = page()
    value.evidence = { ...value.evidence, observedAt: '2026-09-04T11:00:00Z', freshUntil: '2026-09-04T11:01:00Z' }
    const owner = new CityEvidenceController('db', 'cpu', 'live', vi.fn().mockResolvedValue(value))
    await owner.refresh()
    expect(cityEvidenceDisclosure(owner.getSnapshot(), 'live').observedAt).toBe('2026-09-04T10:00:00Z')
  })

  it('bounds automatic paging and ignores a second load-more click while one is pending', async () => {
    const pending = deferred<DatabaseCityPage>()
    const fetch = vi.fn(async (_database: string, _metric: string, token: string | null) =>
      page({ nextPageToken: String(Number(token ?? 0) + 1) }))
    const owner = new CityEvidenceController('db', 'cpu', 'live', fetch)
    await owner.refresh()
    expect(fetch).toHaveBeenCalledTimes(80)
    fetch.mockImplementationOnce(() => pending.promise)
    const more = owner.loadMore()
    await owner.loadMore()
    expect(fetch).toHaveBeenCalledTimes(81)
    pending.resolve(page())
    await more
    expect(owner.getSnapshot().page?.nextPageToken).toBeNull()
  })

  it('does not publish a one-second heartbeat or poll a hidden city', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T10:00:01Z'))
    const fetch = vi.fn().mockResolvedValue(page())
    const owner = new CityEvidenceController('db', 'cpu', 'live', fetch, undefined, () => true)
    const publish = vi.fn()
    owner.subscribe(publish)
    owner.start()
    await vi.advanceTimersByTimeAsync(0)
    publish.mockClear()
    await vi.advanceTimersByTimeAsync(58_000)
    expect(publish).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(publish).toHaveBeenCalledOnce()
    expect(cityEvidenceDisclosure(owner.getSnapshot(), 'live').status).toBe('Stale')
    owner.dispose()
  })

  it('stops all timing for a fixture discovered through the live adapter', async () => {
    vi.useFakeTimers()
    const value = page()
    value.evidence = { ...value.evidence, source: 'Fixture' }
    const owner = new CityEvidenceController('db', 'cpu', 'live', vi.fn().mockResolvedValue(value))
    owner.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
    owner.dispose()
  })
})
