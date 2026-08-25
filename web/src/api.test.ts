import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import type { LiveIncidentResponse } from './liveContracts'
import type { LiveFeedConnectionState } from './liveIncidents'
import { RECONNECT_BASE_DELAY_MS, RECONNECT_MAX_DELAY_MS } from './liveIncidents'

/*
 * The push channel is exercised against a fake HubConnection so retry, REST fallback, and disposal
 * are deterministic: no network, no real timers, and no dependence on SignalR's own retry policy —
 * whose limits are exactly what this module exists to compensate for.
 */
type Handler = (...args: unknown[]) => void

interface FakeConnection {
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  invoke: ReturnType<typeof vi.fn>
  on: (methodName: string, handler: Handler) => void
  onclose: (handler: Handler) => void
  onreconnecting: (handler: Handler) => void
  onreconnected: (handler: Handler) => void
  emitUpdate: (payload: unknown) => void
  emitClose: () => void
  emitReconnecting: () => void
  emitReconnected: () => void
}

const hoisted = vi.hoisted(() => ({ connection: null as unknown }))

vi.mock('@microsoft/signalr', () => ({
  HubConnectionBuilder: class {
    withUrl() {
      return this
    }
    withAutomaticReconnect() {
      return this
    }
    build() {
      return hoisted.connection
    }
  },
}))

const { LIVE_FALLBACK_POLL_INTERVAL_MS, subscribeToLiveIncidents } = await import('./liveFeed')

function validResponse(sequence: number): LiveIncidentResponse {
  return {
    snapshot: null,
    collector: {
      state: 'Running',
      sequence,
      lastSuccessAt: '2026-01-01T00:00:00Z',
      lastAttemptAt: '2026-01-01T00:00:00Z',
      consecutiveFailures: 0,
      nextAttemptInMs: null,
      lastErrorReason: null,
      missedCycles: 0,
      skippedCycles: 0,
    },
  }
}

function createFakeConnection(): FakeConnection {
  const updateHandlers: Handler[] = []
  const closeHandlers: Handler[] = []
  const reconnectingHandlers: Handler[] = []
  const reconnectedHandlers: Handler[] = []
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    invoke: vi.fn(async () => validResponse(1)),
    on: (methodName, handler) => {
      if (methodName === 'liveIncidentUpdated') updateHandlers.push(handler)
    },
    onclose: handler => void closeHandlers.push(handler),
    onreconnecting: handler => void reconnectingHandlers.push(handler),
    onreconnected: handler => void reconnectedHandlers.push(handler),
    emitUpdate: payload => updateHandlers.forEach(handler => handler(payload)),
    emitClose: () => closeHandlers.forEach(handler => handler()),
    emitReconnecting: () => reconnectingHandlers.forEach(handler => handler()),
    emitReconnected: () => reconnectedHandlers.forEach(handler => handler()),
  }
}

let connection: FakeConnection
let fetchMock: ReturnType<typeof vi.fn>
let errorSpy: MockInstance<(...args: unknown[]) => void>
let updates: LiveIncidentResponse[]
let states: LiveFeedConnectionState[]

function subscribe(): () => void {
  return subscribeToLiveIncidents(
    update => void updates.push(update),
    state => void states.push(state),
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  connection = createFakeConnection()
  hoisted.connection = connection
  updates = []
  states = []
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => validResponse(99) }))
  vi.stubGlobal('fetch', fetchMock)
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  errorSpy.mockRestore()
})

describe('subscribeToLiveIncidents: connected path', () => {
  it('reports connected and delivers the initial pull once the channel starts', async () => {
    const dispose = subscribe()
    await vi.advanceTimersByTimeAsync(0)

    expect(states).toEqual(['reconnecting', 'connected'])
    expect(connection.invoke).toHaveBeenCalledWith('GetCurrentLiveSnapshot')
    expect(updates).toHaveLength(1)
    expect(fetchMock).not.toHaveBeenCalled()
    dispose()
  })

  it('does not poll over REST while the channel is connected', async () => {
    const dispose = subscribe()
    await vi.advanceTimersByTimeAsync(LIVE_FALLBACK_POLL_INTERVAL_MS * 5)

    expect(fetchMock).not.toHaveBeenCalled()
    dispose()
  })

  it('keeps the channel when only the initial pull fails, and still delivers later pushes', async () => {
    connection.invoke.mockRejectedValueOnce(new Error('hub method failed'))
    const dispose = subscribe()
    await vi.advanceTimersByTimeAsync(0)

    expect(states).toEqual(['reconnecting', 'connected'])
    expect(errorSpy).toHaveBeenCalled()

    connection.emitUpdate(validResponse(2))
    expect(updates).toHaveLength(1)
    expect(connection.start).toHaveBeenCalledTimes(1)
    dispose()
  })
})

describe('subscribeToLiveIncidents: initial start failure', () => {
  it('retries the initial start (which withAutomaticReconnect never does) and polls REST meanwhile', async () => {
    connection.start.mockRejectedValueOnce(new Error('server not up'))
    const dispose = subscribe()
    await vi.advanceTimersByTimeAsync(0)

    expect(states).toEqual(['reconnecting', 'polling-fallback'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(updates).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS)
    expect(connection.start).toHaveBeenCalledTimes(2)
    expect(states.at(-1)).toBe('connected')

    const fetchesAtReconnect = fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(LIVE_FALLBACK_POLL_INTERVAL_MS * 3)
    expect(fetchMock).toHaveBeenCalledTimes(fetchesAtReconnect)
    dispose()
  })

  it('keeps polling on the fallback interval for as long as the channel is down', async () => {
    connection.start.mockRejectedValue(new Error('server not up'))
    const dispose = subscribe()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(LIVE_FALLBACK_POLL_INTERVAL_MS)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(LIVE_FALLBACK_POLL_INTERVAL_MS)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    dispose()
  })

  it('backs off between attempts and stays bounded by the cap', async () => {
    connection.start.mockRejectedValue(new Error('server not up'))
    const dispose = subscribe()
    await vi.advanceTimersByTimeAsync(0)
    expect(connection.start).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS - 1)
    expect(connection.start).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(connection.start).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS * 2 - 1)
    expect(connection.start).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(connection.start).toHaveBeenCalledTimes(3)

    const attemptsBefore = connection.start.mock.calls.length
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS * 10)
    expect(connection.start.mock.calls.length).toBeGreaterThan(attemptsBefore)
    dispose()
  })
})

describe('subscribeToLiveIncidents: reconnect and permanent close', () => {
  it('polls while SignalR is reconnecting and stops once it reconnects', async () => {
    const dispose = subscribe()
    await vi.advanceTimersByTimeAsync(0)

    connection.emitReconnecting()
    await vi.advanceTimersByTimeAsync(0)
    expect(states.at(-1)).toBe('reconnecting')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    connection.emitReconnected()
    await vi.advanceTimersByTimeAsync(0)
    expect(states.at(-1)).toBe('connected')

    const fetchesAtReconnect = fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(LIVE_FALLBACK_POLL_INTERVAL_MS * 3)
    expect(fetchMock).toHaveBeenCalledTimes(fetchesAtReconnect)
    dispose()
  })

  it('takes over with its own retry after SignalR gives up permanently (onclose)', async () => {
    const dispose = subscribe()
    await vi.advanceTimersByTimeAsync(0)
    expect(connection.start).toHaveBeenCalledTimes(1)

    connection.emitClose()
    await vi.advanceTimersByTimeAsync(0)
    expect(states.at(-1)).toBe('disconnected')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS)
    expect(connection.start).toHaveBeenCalledTimes(2)
    expect(states.at(-1)).toBe('connected')
    dispose()
  })
})

describe('subscribeToLiveIncidents: malformed payloads', () => {
  it('discards a malformed push without killing the subscription', async () => {
    const dispose = subscribe()
    await vi.advanceTimersByTimeAsync(0)
    updates.length = 0

    connection.emitUpdate({ snapshot: { schemaVersion: '2.0' }, collector: {} })
    expect(updates).toHaveLength(0)
    expect(errorSpy).toHaveBeenCalled()

    connection.emitUpdate(validResponse(3))
    expect(updates).toHaveLength(1)
    dispose()
  })

  it('discards a malformed initial pull without reporting a broken channel', async () => {
    connection.invoke.mockResolvedValueOnce('not an object')
    const dispose = subscribe()
    await vi.advanceTimersByTimeAsync(0)

    expect(updates).toHaveLength(0)
    expect(states.at(-1)).toBe('connected')
    expect(errorSpy).toHaveBeenCalled()
    dispose()
  })

  it('survives a failing or malformed REST poll and polls again on the next tick', async () => {
    connection.start.mockRejectedValue(new Error('server not up'))
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ snapshot: null }) })
    const dispose = subscribe()
    await vi.advanceTimersByTimeAsync(0)
    expect(updates).toHaveLength(0)
    expect(errorSpy).toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(LIVE_FALLBACK_POLL_INTERVAL_MS)
    expect(updates).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(LIVE_FALLBACK_POLL_INTERVAL_MS)
    expect(updates).toHaveLength(1)
    dispose()
  })
})

describe('subscribeToLiveIncidents: disposal', () => {
  it('stops the connection and every timer, and never calls back after disposal', async () => {
    connection.start.mockRejectedValue(new Error('server not up'))
    const dispose = subscribe()
    await vi.advanceTimersByTimeAsync(0)

    const startsAtDispose = connection.start.mock.calls.length
    const fetchesAtDispose = fetchMock.mock.calls.length
    const updatesAtDispose = updates.length
    const statesAtDispose = states.length
    dispose()

    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS * 5)
    expect(connection.stop).toHaveBeenCalled()
    expect(connection.start.mock.calls.length).toBe(startsAtDispose)
    expect(fetchMock.mock.calls.length).toBe(fetchesAtDispose)
    expect(updates).toHaveLength(updatesAtDispose)
    expect(states).toHaveLength(statesAtDispose)
  })

  it('ignores pushes and channel events that arrive after disposal', async () => {
    const dispose = subscribe()
    await vi.advanceTimersByTimeAsync(0)
    updates.length = 0
    states.length = 0
    dispose()

    connection.emitUpdate(validResponse(4))
    connection.emitReconnecting()
    connection.emitClose()
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS * 2)

    expect(updates).toHaveLength(0)
    expect(states).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not deliver an in-flight initial pull that lands after disposal', async () => {
    let resolveStart: () => void = () => {}
    connection.start.mockImplementationOnce(() => new Promise<void>(resolve => { resolveStart = resolve }))
    const dispose = subscribe()
    await vi.advanceTimersByTimeAsync(0)

    dispose()
    resolveStart()
    await vi.advanceTimersByTimeAsync(0)

    expect(updates).toHaveLength(0)
    expect(connection.invoke).not.toHaveBeenCalled()
  })

  it('waits for an in-flight negotiation before stopping the connection', async () => {
    let resolveStart: () => void = () => {}
    connection.start.mockImplementationOnce(() => new Promise<void>(resolve => { resolveStart = resolve }))
    const dispose = subscribe()
    await vi.advanceTimersByTimeAsync(0)

    dispose()
    expect(connection.stop).not.toHaveBeenCalled()

    resolveStart()
    await vi.advanceTimersByTimeAsync(0)
    expect(connection.stop).toHaveBeenCalledTimes(1)
  })
})
