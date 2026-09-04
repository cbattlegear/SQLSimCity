import { describe, expect, it, vi } from 'vitest'
import { createSceneFrames } from './sceneFrames'

function fixture() {
  let ticket = 0
  const pending = new Map<number, FrameRequestCallback>()
  const draw = vi.fn()
  const frames = createSceneFrames(draw, {
    request(callback) { pending.set(++ticket, callback); return ticket },
    cancel(handle) { pending.delete(handle) },
  })
  const tick = (time = 16) => {
    const batch = [...pending]
    pending.clear()
    for (const [, callback] of batch) callback(time)
  }
  return { frames, draw, pending, tick }
}

describe('scene frame ownership', () => {
  it('updates all independent controllers before one coalesced draw', () => {
    const { frames, draw, pending, tick } = fixture()
    const updated: string[] = []
    draw.mockImplementation(() => expect(updated).toEqual(['orbit', 'vehicles', 'disasters', 'tour']))
    for (const name of ['orbit', 'vehicles', 'disasters', 'tour']) {
      frames.requestUpdate(now => {
        expect(now).toBe(16)
        updated.push(name)
        frames.requestRender()
      })
    }
    frames.requestRender()
    frames.requestRender()
    expect(pending.size).toBe(1)
    tick()
    expect(draw).toHaveBeenCalledTimes(1)
    expect(pending.size).toBe(0)
  })

  it('keeps a repeating controller alive when its sibling stops', () => {
    const { frames, draw, pending, tick } = fixture()
    let moving = true
    const vehicle = () => {
      if (!moving) return
      frames.requestRender()
      frames.requestUpdate(vehicle)
    }
    frames.requestUpdate(vehicle)
    frames.requestUpdate(() => frames.requestRender())
    tick()
    tick(32)
    expect(draw).toHaveBeenCalledTimes(2)
    expect(pending.size).toBe(1)
    moving = false
    tick(48)
    expect(pending.size).toBe(0)
    expect(draw).toHaveBeenCalledTimes(2)
  })

  it('cancels one pending update without orphaning another', () => {
    const { frames, pending, tick } = fixture()
    const cancelled = vi.fn()
    const retained = vi.fn()
    const ticket = frames.requestUpdate(cancelled)
    frames.requestUpdate(retained)
    frames.cancelUpdate(ticket)
    tick()
    expect(cancelled).not.toHaveBeenCalled()
    expect(retained).toHaveBeenCalledOnce()
    expect(pending.size).toBe(0)
  })

  it('can cancel an update in the current batch', () => {
    const { frames, tick } = fixture()
    const cancelled = vi.fn()
    let ticket = 0
    frames.requestUpdate(() => frames.cancelUpdate(ticket))
    ticket = frames.requestUpdate(cancelled)
    tick()
    expect(cancelled).not.toHaveBeenCalled()
  })

  it('cancels the native callback when its last update is removed', () => {
    const { frames, pending } = fixture()
    frames.cancelUpdate(frames.requestUpdate(vi.fn()))
    expect(pending.size).toBe(0)
  })

  it('retains a requested render when its final controller stops', () => {
    const { frames, draw, pending, tick } = fixture()
    const ticket = frames.requestUpdate(vi.fn())
    frames.requestRender()
    frames.cancelUpdate(ticket)
    expect(pending.size).toBe(1)
    tick()
    expect(draw).toHaveBeenCalledOnce()
    expect(pending.size).toBe(0)
  })

  it('disposes pending renders and controllers and rejects later scheduling', () => {
    const { frames, draw, pending, tick } = fixture()
    const update = vi.fn()
    frames.requestUpdate(update)
    frames.requestRender()
    frames.dispose()
    frames.requestUpdate(update)
    frames.requestRender()
    expect(pending.size).toBe(0)
    tick()
    expect(update).not.toHaveBeenCalled()
    expect(draw).not.toHaveBeenCalled()
  })

  it('stops the batch and draw if an update disposes the scene', () => {
    const { frames, draw, pending, tick } = fixture()
    const late = vi.fn()
    frames.requestUpdate(() => { frames.requestRender(); frames.dispose() })
    frames.requestUpdate(late)
    tick()
    expect(draw).not.toHaveBeenCalled()
    expect(late).not.toHaveBeenCalled()
    expect(pending.size).toBe(0)
  })

  it('defers invalidation during drawing rather than losing it', () => {
    const { frames, draw, pending, tick } = fixture()
    draw.mockImplementationOnce(() => frames.requestRender())
    frames.requestRender()
    tick()
    expect(draw).toHaveBeenCalledOnce()
    expect(pending.size).toBe(1)
    tick()
    expect(draw).toHaveBeenCalledTimes(2)
    expect(pending.size).toBe(0)
  })
})
