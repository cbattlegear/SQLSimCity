type FrameHost = {
  request(callback: FrameRequestCallback): number
  cancel(handle: number): void
}

/**
 * Independent controllers own update tickets, never renderer submissions. Every update queued for
 * a browser frame runs before its single draw; updates queued during it belong to the next frame.
 */
export function createSceneFrames(
  draw: () => void,
  host: FrameHost = {
    request: callback => requestAnimationFrame(callback),
    cancel: handle => cancelAnimationFrame(handle),
  },
) {
  const updates = new Map<number, FrameRequestCallback>()
  let nextTicket = 1
  let handle: number | null = null
  let dirty = false
  let running = false
  let disposed = false

  const schedule = () => {
    if (disposed || running || handle !== null || (!dirty && updates.size === 0)) return
    handle = host.request(flush)
  }

  function flush(timestamp: number) {
    handle = null
    if (disposed) return
    running = true
    try {
      for (const [ticket, update] of [...updates]) {
        if (disposed) break
        if (!updates.delete(ticket)) continue
        update(timestamp)
      }
      if (dirty && !disposed) {
        dirty = false
        draw()
      }
    } finally {
      running = false
      schedule()
    }
  }

  return {
    requestRender() {
      if (disposed) return
      dirty = true
      schedule()
    },
    requestUpdate(update: FrameRequestCallback): number {
      if (disposed) return 0
      const ticket = nextTicket++
      updates.set(ticket, update)
      schedule()
      return ticket
    },
    cancelUpdate(ticket: number) {
      updates.delete(ticket)
      if (!dirty && updates.size === 0 && handle !== null) {
        host.cancel(handle)
        handle = null
      }
    },
    dispose() {
      disposed = true
      updates.clear()
      dirty = false
      if (handle !== null) host.cancel(handle)
      handle = null
    },
  }
}
