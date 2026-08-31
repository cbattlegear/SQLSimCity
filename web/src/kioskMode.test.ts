import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  enterKioskFullscreen,
  fullscreenAvailable,
  kioskChrome,
  leaveKioskFullscreen,
  shouldLeaveKiosk,
  type KioskDocument,
  type KioskElement,
} from './kioskMode'

/** A stand-in element that is fullscreen-capable and records the calls it received. */
function grantingElement(): KioskElement & { calls: number } {
  const element = {
    calls: 0,
    requestFullscreen: () => {
      element.calls++
      return Promise.resolve()
    },
  }
  return element
}

function capableDocument(overrides: Partial<KioskDocument> = {}): KioskDocument {
  return { fullscreenEnabled: true, fullscreenElement: null, exitFullscreen: () => Promise.resolve(), ...overrides }
}

describe('fullscreen availability', () => {
  it('accepts a document and element that can do it', () => {
    expect(fullscreenAvailable(capableDocument(), grantingElement())).toBe(true)
  })

  /*
   * A browser with no element fullscreen -- Safari on iPhone -- leaves `requestFullscreen` undefined
   * rather than returning a promise that rejects, so calling it throws a `TypeError` synchronously
   * and there is nothing to `.catch`. It has to be checked before the call, not around it.
   */
  it('refuses to call a request method that does not exist', () => {
    expect(fullscreenAvailable(capableDocument(), {})).toBe(false)
  })

  /** A sandboxed frame without `allow="fullscreen"` reports this, and every request would reject. */
  it('respects a document that is not permitted to go fullscreen', () => {
    expect(fullscreenAvailable(capableDocument({ fullscreenEnabled: false }), grantingElement())).toBe(false)
  })

  /**
   * Absent rather than `false` is the older-browser shape, and it is capable. Treating a missing
   * property as a refusal would switch fullscreen off everywhere it is not explicitly advertised.
   */
  it('treats an unreported permission as permitted', () => {
    const doc = capableDocument()
    delete doc.fullscreenEnabled
    expect(fullscreenAvailable(doc, grantingElement())).toBe(true)
  })
})

describe('entering fullscreen', () => {
  it('reports the grant so an exit can later be recognised as ours', async () => {
    const element = grantingElement()
    await expect(enterKioskFullscreen(capableDocument(), element)).resolves.toBe(true)
    expect(element.calls).toBe(1)
  })

  /**
   * A refusal is not an error the viewer needs to see. The rail has still collapsed and the map has
   * still taken the window, which is most of what the press asked for -- so this resolves `false`
   * rather than rejecting, and kiosk mode carries on without the browser's half.
   */
  it('survives a refusal instead of rejecting into the caller', async () => {
    const doc = capableDocument()
    const element = { requestFullscreen: () => Promise.reject(new Error('not a user gesture')) }
    await expect(enterKioskFullscreen(doc, element)).resolves.toBe(false)
  })

  it('does not attempt a request the browser cannot serve', async () => {
    await expect(enterKioskFullscreen(capableDocument({ fullscreenEnabled: false }), grantingElement()))
      .resolves.toBe(false)
  })
})

describe('leaving fullscreen', () => {
  it('gives it back when we are in it', async () => {
    const exitFullscreen = vi.fn(() => Promise.resolve())
    await leaveKioskFullscreen(capableDocument({ fullscreenElement: {} as Element, exitFullscreen }))
    expect(exitFullscreen).toHaveBeenCalledOnce()
  })

  /**
   * Escape takes fullscreen away before any listener runs, so by the time the toggle is pressed the
   * document may already be out. `exitFullscreen` on a document that is not fullscreen rejects with
   * a `TypeError`, which would surface as an unhandled rejection for nothing.
   */
  it('does nothing when the browser has already taken it back', async () => {
    const exitFullscreen = vi.fn(() => Promise.resolve())
    await leaveKioskFullscreen(capableDocument({ fullscreenElement: null, exitFullscreen }))
    expect(exitFullscreen).not.toHaveBeenCalled()
  })

  it('swallows a refusal rather than rejecting into the caller', async () => {
    await expect(leaveKioskFullscreen(capableDocument({
      fullscreenElement: {} as Element,
      exitFullscreen: () => Promise.reject(new Error('nope')),
    }))).resolves.toBeUndefined()
  })
})

describe('following the browser out of fullscreen', () => {
  /**
   * Escape is the documented way out and the browser consumes it before any listener, so this event
   * is the only signal that the viewer wants out. Staying in kiosk mode then strands the rail
   * collapsed inside an ordinary window with nothing on screen explaining why.
   */
  it('leaves kiosk when the fullscreen we took is dropped', () => {
    expect(shouldLeaveKiosk({ tookFullscreen: true, fullscreenElement: null })).toBe(true)
  })

  /**
   * Kiosk mode is allowed to exist without fullscreen -- refused, or unavailable. If that state
   * followed every `fullscreenchange`, a video elsewhere on the page closing its own fullscreen
   * would fold the map's kiosk mode with it.
   */
  it('ignores an exit from a fullscreen that was never ours', () => {
    expect(shouldLeaveKiosk({ tookFullscreen: false, fullscreenElement: null })).toBe(false)
  })

  /** The same event fires on the way *in*, where reading it as an exit would undo the press. */
  it('ignores the change that put us into fullscreen', () => {
    expect(shouldLeaveKiosk({ tookFullscreen: true, fullscreenElement: {} as Element })).toBe(false)
  })
})

describe('the toggle chrome', () => {
  /**
   * The name is the action the press performs, not the state the map is in. Every fullscreen control
   * on the web reads this way, and it is the only wording that is still true mid-press.
   */
  it('names the action rather than the current state', () => {
    expect(kioskChrome(false).label).toBe('Full screen')
    expect(kioskChrome(true).label).toBe('Exit full screen')
  })

  /** One toggle with a pressed state, not two buttons that swap places under the pointer. */
  it('reports its pressed state so it reads as one control', () => {
    expect(kioskChrome(false).pressed).toBe(false)
    expect(kioskChrome(true).pressed).toBe(true)
  })
})

/* ------------------------------------------------------------------ the collapsed layout */

const css = readFileSync(new URL('./App.css', import.meta.url), 'utf8')

/** Every `selector { … }` pair, media wrappers stripped, so an assertion is about one rule's body. */
function rules(source: string): { selector: string; body: string }[] {
  const flat = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '')
  const out: { selector: string; body: string }[] = []
  for (const match of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim().replace(/\s+/g, ' ')
    if (selector.length > 0) out.push({ selector, body: match[2] })
  }
  return out
}

/**
 * The stylesheet outside any media query, and the body of the `max-width: 900px` block.
 *
 * The overlay corner is sized twice -- once at every width, once for a phone -- and the two carry
 * different numbers on purpose. Reading them from the flattened stylesheet returns whichever came
 * last, which is the wrong answer for exactly one of the two assertions below.
 */
function splitAt(maxWidth: number): { base: string; narrow: string } {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
  let base = ''
  let narrow = ''
  let cursor = 0
  while (cursor < src.length) {
    const at = src.indexOf('@media', cursor)
    if (at === -1) {
      base += src.slice(cursor)
      break
    }
    base += src.slice(cursor, at)
    const open = src.indexOf('{', at)
    let depth = 0
    let end = open
    for (; end < src.length; end++) {
      if (src[end] === '{') depth++
      else if (src[end] === '}' && --depth === 0) break
    }
    if (new RegExp(`max-width:\\s*${maxWidth}px`).test(src.slice(at, open))) narrow += `${src.slice(open + 1, end)}\n`
    cursor = end + 1
  }
  return { base, narrow }
}

const { base: baseCss, narrow: phoneCss } = splitAt(900)

/** A pixel-valued declaration read off one rule, so the two controls can be measured against each other. */
function px(source: string, selector: string, property: string): number {
  const rule = rules(source).find(one => one.selector === selector)
  if (!rule) throw new Error(`no rule for ${selector}`)
  const match = rule.body.match(new RegExp(`(?:^|;)\\s*${property}:\\s*(-?[\\d.]+)px`))
  if (!match) throw new Error(`${selector} declares no ${property} in px`)
  return Number(match[1])
}

describe('the kiosk layout', () => {
  /**
   * The shell is a two-column grid on a wide screen and a two-*row* grid at <=860px, and one class
   * has to answer for both. Resetting only the columns leaves the sheet's 42% row in place, so on a
   * phone the map would "go full screen" into the top 58% of the window with a hole under it.
   */
  it('resets both grid axes, not just the columns', () => {
    const rule = rules(baseCss).find(one => one.selector === '.map-shell.is-kiosk')
    expect(rule, '.map-shell.is-kiosk is not declared').toBeDefined()
    expect(rule!.body).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/)
    expect(rule!.body).toMatch(/grid-template-rows:\s*minmax\(0, 1fr\)/)
  })

  /**
   * `display: none`, not `visibility` or a zero width. The rail is still mounted so that leaving
   * kiosk mode is as cheap as entering it, which means the only thing keeping a collapsed sidebar
   * out of the tab order and off the accessibility tree is this declaration.
   */
  it('takes the collapsed rail out of the tab order', () => {
    const rule = rules(baseCss).find(one => one.selector === '.map-sidebar.is-collapsed')
    expect(rule, 'the kiosk rail is not hidden').toBeDefined()
    expect(rule!.body).toMatch(/display:\s*none/)
  })

  /**
   * Both controls are pinned to the same corner, so the toggle's `bottom` has to clear the whole
   * view-mode tile or it is drawn on top of it. Arithmetic rather than taste, and checked at both
   * sizes because the tile is 74px wide and 56px on a phone -- a narrow override that changes one
   * without the other puts the full-screen button over the 3D switch.
   */
  it('clears the view-mode tile at both sizes', () => {
    for (const [label, source] of [['at every width', baseCss], ['on a phone', phoneCss]] as const) {
      const tileTop = px(source, '.view-mode-tile', 'bottom') + px(source, '.view-mode-tile', 'height')
      expect(px(source, '.kiosk-toggle', 'bottom'), `the toggle overlaps the view switch ${label}`)
        .toBeGreaterThanOrEqual(tileTop)
    }
  })

  /** Same corner, so a change to one edge that skips the other leaves the pair visibly ragged. */
  it('shares the left edge of the view switch', () => {
    for (const source of [baseCss, phoneCss]) {
      expect(px(source, '.kiosk-toggle', 'left')).toBe(px(source, '.view-mode-tile', 'left'))
    }
  })

  /**
   * The compress glyph is four elbows pointing inward, and the gaps between them are what say
   * "inward" rather than "plus sign". Rendered at the real 34px button and measured against five
   * other geometries, every one of them collapsed into a plus below roughly 20px -- the expand
   * glyph stays legible either way, so the size is set by the harder of the two. This is a
   * legibility floor, not a taste, and it is the sort of number a later tidy-up would shave.
   */
  it('keeps the glyph large enough to read as a compress', () => {
    expect(px(baseCss, '.kiosk-icon', 'width')).toBeGreaterThanOrEqual(20)
    expect(px(baseCss, '.kiosk-icon', 'height')).toBeGreaterThanOrEqual(20)
  })

  /**
   * The floor above pushes against the button, which is 34px wide and only 38px on a phone. The
   * icon is centred by `place-items`, so an icon larger than its button does not clip -- it
   * silently overflows the border and sits on the map.
   */
  it('keeps the glyph inside the button at both sizes', () => {
    const icon = px(baseCss, '.kiosk-icon', 'width')
    for (const [label, source] of [['at every width', baseCss], ['on a phone', phoneCss]] as const) {
      expect(px(source, '.kiosk-toggle', 'width'), `the glyph overflows its button ${label}`)
        .toBeGreaterThan(icon)
    }
  })

  /**
   * Kiosk mode hides the rail, so the button is the only thing on screen still saying the map is
   * folded away. Colour alone carries that, and it is borrowed from the pressed treatment the HUD
   * results list already uses rather than invented here.
   */
  it('marks the engaged toggle the way the rest of the HUD marks a pressed control', () => {
    const rule = rules(baseCss).find(one => one.selector === '.kiosk-toggle.is-active')
    expect(rule, 'the engaged toggle is not distinguished').toBeDefined()
    expect(rule!.body).toMatch(/border-color:\s*#72f4c4/)
    expect(rule!.body).toMatch(/background:\s*#0f2029/)
  })
})
