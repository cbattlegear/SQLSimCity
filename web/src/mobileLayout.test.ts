import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('./App.css', import.meta.url), 'utf8')
const tray = readFileSync(new URL('./MapTray.tsx', import.meta.url), 'utf8')
const city = readFileSync(new URL('./DatabaseCityViewport.tsx', import.meta.url), 'utf8')

/** The width below which the map overlays fold into the tray, read from the component itself. */
const NARROW = (() => {
  const match = tray.match(/NARROW_QUERY = '\(max-width: (\d+)px\)'/)
  if (!match) throw new Error('MapTray no longer declares NARROW_QUERY as a max-width query')
  return Number(match[1])
})()

/** Source offset of the last `@media (max-width: Npx)` block that mentions `selector`. */
function lastNarrowRuleFor(selector: string): number {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`@media \\(max-width: \\d+px\\)[\\s\\S]*?${escaped}\\s*\\{`, 'g')
  let last = -1
  for (const match of css.matchAll(pattern)) last = match.index ?? last
  return last
}

/**
 * Every `selector { … }` pair in the stylesheet, flattened.
 *
 * Regex over a whole stylesheet is what made the first version of these tests wrong twice: a
 * `[^{}]*` run walks straight past the rule it was aimed at into the next one, so `.map-tray` matched
 * a `display: none` that belonged to `.map-tray-panel .hud-legend > summary`. Splitting into rules
 * first means every assertion below is about one rule's own body.
 */
function rules(source: string = css): { selector: string; body: string }[] {
  const flat = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@media[^{]*\{/g, '')
  const out: { selector: string; body: string }[] = []
  for (const match of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim().replace(/\s+/g, ' ')
    if (selector.length > 0) out.push({ selector, body: match[2] })
  }
  return out
}

/** The body of the last rule whose selector list targets exactly `selector`, optionally in a state. */
function ownRule(selector: string, source: string = css): string | null {
  const own = rules(source).filter((rule) => rule.selector
    .split(',')
    .some((one) => new RegExp(`(^|\\s)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(:[a-z-]+(\\([^)]*\\))?)?$`)
      .test(one.trim())))
  return own.length === 0 ? null : own[own.length - 1].body
}

/**
 * The width below which the sidebar becomes a bottom sheet.
 *
 * Deliberately not `NARROW`: the tray folds the map overlays at 900px, the sidebar becomes a sheet at
 * 860px, and they are separate decisions about separate surfaces. Reading the sheet's rules out of
 * the tray's breakpoint silently picks up the wrong media block.
 */
const SHEET = 860

/**
 * The stylesheet split into the rules that apply at every width and the rules that only apply in the
 * narrow bottom sheet.
 *
 * `ownRule` reads the *last* matching rule with the `@media` wrappers stripped, which is the right
 * answer for an overlay whose narrow override is the interesting one -- and exactly the wrong answer
 * for the sidebar, where the desktop rail and the narrow sheet now hold deliberately opposite
 * contracts. Without this split, adding a narrow override silently retargets every desktop assertion
 * below at the rule that overrides it.
 */
function splitByMedia(source: string): { desktop: string; narrow: string } {
  const src = source.replace(/\/\*[\s\S]*?\*\//g, '')
  let desktop = ''
  let narrow = ''
  let cursor = 0
  while (cursor < src.length) {
    const at = src.indexOf('@media', cursor)
    if (at === -1) {
      desktop += src.slice(cursor)
      break
    }
    desktop += src.slice(cursor, at)
    const open = src.indexOf('{', at)
    let depth = 0
    let end = open
    for (; end < src.length; end++) {
      if (src[end] === '{') depth++
      else if (src[end] === '}' && --depth === 0) break
    }
    if (new RegExp(`max-width:\\s*${SHEET}px`).test(src.slice(at, open))) {
      narrow += `${src.slice(open + 1, end)}\n`
    }
    cursor = end + 1
  }
  return { desktop, narrow }
}

const { desktop: desktopCss, narrow: narrowCss } = splitByMedia(css)

/** The rule as it stands outside any media query: the desktop rail's contract. */
function desktopRule(selector: string): string | null {
  return ownRule(selector, desktopCss)
}

/** The rule as the narrow bottom sheet overrides it. */
function narrowRule(selector: string): string | null {
  return ownRule(selector, narrowCss)
}

describe('map overlays on a narrow viewport', () => {
  /**
   * The tray and the stylesheet have to agree on one width, or there is a band of viewports where
   * the component thinks the panels are still in their corners and the CSS has already moved them.
   * The first attempt at this shipped an 861-900px band where the legend rendered and was then
   * hidden by a rule written for a different breakpoint.
   */
  it('shares one breakpoint between MapTray and the stylesheet', () => {
    expect(css).toContain(`@media (max-width: ${NARROW}px)`)
    expect(lastNarrowRuleFor('.view-mode-tile')).toBeGreaterThan(-1)
  })

  /**
   * A media query and the base rule it overrides have the same specificity, so source order decides.
   * These rules were originally written above the overlay definitions and silently lost every one of
   * their overrides -- the phone kept the desktop sizes and the screenshot looked untouched.
   */
  it('declares its narrow overrides after the rules they override', () => {
    for (const selector of ['.view-mode-tile', '.hud-camera', '.status-chip', '.hud-bottom-right']) {
      const base = css.indexOf(`\n${selector} {`)
      expect(base, `${selector} base rule`).toBeGreaterThan(-1)
      expect(lastNarrowRuleFor(selector), `${selector} narrow override`).toBeGreaterThan(base)
    }
  })

  /**
   * The rule the whole layout is written to: a warning a narrow screen hides is a warning that was
   * not given. Folding a panel into a chip is allowed; deleting it is not.
   */
  it('never hides a map overlay outright', () => {
    for (const selector of ['.hud-bottom-left', '.map-tray', '.map-tray-chips', '.incident-summary']) {
      const body = ownRule(selector)
      expect(body, `${selector} has no rule at all`).not.toBeNull()
      expect(body, `${selector} is switched off`).not.toMatch(/display:\s*none/)
    }
  })

  /** Every overlay that leaves its corner has to turn up in the tray, not simply stop rendering. */
  it('moves the legend and the finder into the tray rather than dropping them', () => {
    expect(city).toContain('{!narrow && <div className="hud hud-bottom-left">{legend}</div>}')
    expect(city).toContain('{!narrow && finder && <div className="hud hud-top-left">{finder}</div>}')
    expect(city).toMatch(/narrow \? \[\{ id: 'legend'/)
    expect(city).toMatch(/narrow && finder \? \[\{ id: 'find'/)
  })

  /**
   * A folded control must never read as all-clear.
   *
   * Incidents left the tray for a sidebar drawer, and on a narrow viewport that drawer is inside the
   * bottom sheet rather than gone: `.sidebar-drawers` is `display: contents` there, so the drawers
   * are still rendered and still scroll with the sheet. The guarantee travels with them -- the
   * closed summary carries the finding, and a real incident opens the drawer unasked. The tray keeps
   * its own self-opening mechanism for the panels it still holds.
   */
  it('states the incident finding on the closed control and opens a real incident unasked', () => {
    const view = readFileSync(new URL('./DatabaseCityView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('{incidentSummaryLabel(incidents)}')
    expect(view.replace(/\/\*[\s\S]*?\*\//g, '')).toContain("open={openRegion === 'activity'}")
    // Still reachable at narrow width: the wrapper dissolves, the drawers do not.
    expect(narrowRule('.sidebar-drawers')).toMatch(/display:\s*contents/)
    expect(narrowRule('.sidebar-drawer'), 'the sheet drawers are switched off')
      .not.toMatch(/display:\s*none/)
    expect(tray).toContain('if (alerting) setOpenId(alerting)')
  })

  /** Touch targets. Anything smaller than this is a control you aim at rather than press. */
  it('keeps the compacted controls tappable', () => {
    const camera = css.slice(lastNarrowRuleFor('.hud-camera button'))
    const size = camera.match(/min-width:\s*(\d+)px;\s*min-height:\s*(\d+)px/)
    expect(size).not.toBeNull()
    expect(Number(size?.[1])).toBeGreaterThanOrEqual(36)
    expect(Number(size?.[2])).toBeGreaterThanOrEqual(36)
    expect(css).toMatch(/\.map-tray-chip\s*\{[^}]*min-height:\s*3[4-9]px/)
  })

  /**
   * The feed chip is centred at the top on a wide screen, which is exactly where the tray chips go
   * on a narrow one. Measured on a phone they overlapped, so the narrow layout stacks them.
   */
  it('stacks the feed chip above the tray chips instead of over them', () => {
    const status = css.slice(lastNarrowRuleFor('.status-chip'))
    expect(status).toMatch(/\.status-chip\s*\{[^}]*transform:\s*none/)
    expect(css.slice(lastNarrowRuleFor('.hud-top-right'))).toMatch(/\.hud-top-right\s*\{[^}]*top:\s*46px/)
  })

  /**
   * An open tray panel has to stop short of the camera controls in the opposite corner. The cap goes
   * on the tray container, and the container has to be flex there: an auto grid row overflows a
   * capped parent instead of shrinking into it, which put the last legend rows under the zoom
   * buttons the first time this was written.
   */
  it('bounds an open tray panel inside the map', () => {
    const rule = ownRule('.hud-top-right')
    expect(rule).not.toBeNull()
    expect(rule).toMatch(/max-height:\s*calc\(100% - \d+px\)/)
    expect(rule).toMatch(/display:\s*flex/)
    expect(rule).toMatch(/min-height:\s*0/)
    expect(ownRule('.map-tray')).toMatch(/min-height:\s*0/)
    expect(ownRule('.map-tray-panel')).toMatch(/overflow:\s*auto/)
  })

  /**
   * A schema-qualified object name is a single unbreakable word and some run past fifty characters.
   * Measured on a phone they ran off the side of the sidebar and were clipped: no ellipsis, no
   * scroll, no way to read the end of the name you were searching for.
   */
  it('wraps long object names in the address list instead of clipping them', () => {
    const rule = ownRule('.address-text > \\*')
    expect(css).toMatch(/\.address-text > \*\s*\{[^}]*overflow-wrap:\s*anywhere/)
    expect(css).toMatch(/\.address-text > \*\s*\{[^}]*min-width:\s*0/)
    expect(rule === null || rule.length > 0).toBe(true)
  })

  /** The narrow overrides only take effect at the narrow width, so the desktop layout is untouched. */
  it('leaves the wide layout as a grid with the panels in their own corners', () => {
    const all = rules().filter((rule) => rule.selector === '.hud-top-right')
    expect(all.length).toBeGreaterThanOrEqual(2)
    // The base rule keeps the grid and never caps its own height; only the narrow override does.
    expect(all[0].body).toMatch(/justify-items:\s*end/)
    expect(all[0].body).not.toMatch(/max-height/)
    expect(all[0].body).not.toMatch(/display:\s*flex/)
    // display: contents, so on a wide screen the tray wrapper leaves no trace in the grid.
    expect(ownRule('.tray-open')).toMatch(/display:\s*contents/)
  })
})

/**
 * A folded panel is only honest if the chip in front of it carries the finding. These pin the two
 * ways that can fail: a chip that softens a warning into a name, and a dismissal that a live warning
 * makes impossible.
 */
describe('the tray cannot fold a warning away', () => {
  const view = readFileSync(new URL('./DatabaseCityView.tsx', import.meta.url), 'utf8')

  it('says the feed connection on the chip, so a dead feed is not just "Feed"', () => {
    expect(city).toContain('`Feed · ${feedState}`')
    expect(city).toMatch(/alert:\s*feedState !== undefined && feedState !== 'connected'/)
    expect(city).toMatch(/tone:\s*feedState && feedState !== 'connected' \? 'is-unknown' : ''/)
  })

  it('is actually handed the feed state by the view that owns it', () => {
    expect(city).toMatch(/feedState\?:\s*LiveFeedConnectionState/)
    expect(view).toContain('feedState={feedState}')
  })

  /**
   * The incident wording moved out of the tray and into a sidebar drawer, and the guarantee moved
   * with it: whatever the summary says, it is said by the module holding the evidence, and it is
   * said on the closed control rather than only inside it.
   */
  it('delegates the incident wording to the module that holds the evidence', () => {
    expect(view).toContain('{incidentSummaryLabel(incidents)}')
    expect(view.replace(/\/\*[\s\S]*?\*\//g, '')).toContain("const alerting = incidentDemandsAttention(incidents)")
    // No local copy left behind to drift out of step with the projection.
    expect(view).not.toContain('function incidentChipLabel')
    // And the tray no longer carries a second, competing copy of it.
    expect(city, 'the incident summary is in two places at once')
      .not.toContain("id: 'incidents'")
  })

  it('lets Escape close the tray outright rather than bouncing back to the alert', () => {
    expect(tray).toMatch(/event\.key === 'Escape'\) setOpenId\(null\)/)
    // Bouncing back would be a no-op whenever the alerting panel is the open one.
    expect(tray).not.toMatch(/Escape'\) setOpenId\(alerting\)/)
  })

  /**
   * The drawer opens itself when something is actually wrong.
   *
   * This is the same promise the self-opening tray panel made, kept after the move. A live warning
   * folded behind a summary is a warning that was not given, and `incidentDemandsAttention` is the
   * one place that decides what counts -- an unreported probe, a blocked waiter, an off-page waiter,
   * or a retained deadlock.
   *
   * How it opens itself changed with the accordion. `open={incidentDemandsAttention(incidents)}`
   * used to be passed straight to the element and got away with it because React writes a DOM
   * property only when the prop *changes*, so a close click stuck until the condition flipped. One
   * shared piece of state has no such prop, so the "only when it changes" part is now written out
   * against a ref -- and it has to stay written out. Setting the region on every render where a
   * warning stands would reopen live activity underneath the reader and make the other three regions
   * impossible to keep open, which is a worse failure than the one this guards.
   */
  it('opens the live activity drawer by itself when the projection demands attention', () => {
    const drawer = view.slice(view.indexOf('const liveActivityDrawer'))
    const end = drawer.indexOf('</details>')
    expect(end, 'no live activity drawer in the city view').toBeGreaterThan(-1)
    const body = drawer.slice(0, end)
    expect(body).toContain('className="sidebar-drawer"')
    expect(body, 'the drawer is no longer driven by the accordion')
      .toContain("open={openRegion === 'activity'}")
    expect(view, 'the drawer does not open itself for a live warning')
      .toMatch(/if \(alerting && !wasAlerting\.current\) setChosenRegion\('activity'\)/)
    expect(view, 'a standing warning reopens the drawer on every render, pinning the rail')
      .toMatch(/const wasAlerting = useRef\(false\)/)
    expect(view, 'incidentDemandsAttention is no longer what decides')
      .toMatch(/const alerting = incidentDemandsAttention\(incidents\)/)
    expect(body, 'the closed summary does not carry the finding')
      .toContain('{incidentSummaryLabel(incidents)}')
    expect(body, 'the drawer holds no summary to read').toContain('<IncidentSummary')
  })

  it('no longer claims neighbourhood names are always drawn, because declutter drops some', () => {
    expect(city).not.toContain('Neighbourhood names are always drawn')
    expect(city).toContain('the smaller neighbourhood’s name is dropped')
  })
})

/**
 * The sidebar column has to hand its overflow to a scroll container.
 *
 * `.map-sidebar` is `overflow: hidden`, which is correct -- the map is the page and the rail must not
 * grow the document -- but it means the column is only usable if something inside it scrolls. The
 * stylesheet defined that scroller as `.sidebar-body` while the markup had been renamed to
 * `.sidebar-scroll`, so for four rendered call sites there was no rule at all and everything past the
 * fold was clipped with no way to reach it. These tests pin both halves of that contract: the class
 * the markup renders is the class the stylesheet styles, and that class actually scrolls.
 */
describe('the sidebar column scrolls its own overflow', () => {
  const markup = ['App.tsx', 'AddressPanel.tsx', 'DatabaseCityView.tsx', 'MapShell.tsx']
    .map((name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'))
    .join('\n')

  /** Every `sidebar-*` class the JSX actually puts on an element. */
  const rendered = [...new Set([...markup.matchAll(/className="([^"{}]*)"/g)]
    .flatMap((match) => match[1].split(/\s+/))
    .filter((name) => name.startsWith('sidebar-')))]

  /** The first rule for a selector, i.e. the base one rather than a narrow-viewport override. */
  function baseRule(selector: string): string | null {
    const own = rules().filter((rule) => rule.selector === selector)
    return own.length === 0 ? null : own[0].body
  }

  /**
   * The guard that would have caught this bug. A wrapper the markup renders and the stylesheet has
   * never heard of is invisible: it looks like a styled element and behaves like a bare div.
   */
  it('styles every sidebar wrapper the markup renders', () => {
    expect(rendered.length).toBeGreaterThan(6)
    for (const name of rendered) {
      expect(ownRule(`.${name}`), `.${name} is rendered but has no rule in App.css`).not.toBeNull()
    }
  })

  /** The other direction of the same drift: a scroller styled for a class nobody renders. */
  it('keeps no rule for the renamed-away .sidebar-body', () => {
    expect(css).not.toContain('.sidebar-body')
    expect(markup).not.toContain('sidebar-body')
  })

  it('gives the clipped column a scroll container', () => {
    expect(baseRule('.map-sidebar')).toMatch(/overflow:\s*hidden/)
    const scroll = desktopRule('.sidebar-scroll')
    expect(scroll, '.sidebar-scroll has no rule at all').not.toBeNull()
    expect(scroll).toMatch(/overflow:\s*auto/)
    // Without this a flex child refuses to shrink below its content and the scroller never engages.
    expect(scroll).toMatch(/min-height:\s*0/)
  })

  /**
   * The basis is `auto` on purpose. The atlas has three of these call sites and renders two of them
   * at once, so a `0` basis would divide the free space evenly between them whether or not either one
   * needed it, which moves the layout on a screen that was never overflowing in the first place.
   */
  it('sizes the scroll regions from their content rather than splitting evenly', () => {
    expect(desktopRule('.sidebar-scroll')).toMatch(/flex:\s*1\s+1\s+auto/)
  })

  /** The original intent: the header and the search box stay put, only the body moves. */
  it('keeps the header and the search box pinned', () => {
    for (const selector of ['.sidebar-header', '.sidebar-search']) {
      const body = desktopRule(selector)
      expect(body, `${selector} has no rule at all`).not.toBeNull()
      expect(body, `${selector} can be shrunk by the scrolling regions`).toMatch(/flex:\s*none/)
    }
  })

  /**
   * On the desktop rail the column is a fixed height and the sections shrink into it. The place card
   * and the legend drawer were each capped at 46vh, and two sections that cannot shrink and together
   * outgrow their container leave the address list exactly nothing. The cap sits on the wrapper,
   * which can shrink below it, instead of on the card inside it, which could not.
   *
   * This is the desktop mechanism only. The narrow sheet no longer shrinks anything -- it scrolls --
   * so these rules are switched off there; see the bottom-sheet suite below.
   */
  it('lets the capped sections shrink inside the desktop rail', () => {
    expect(desktopRule('.sidebar-place-card'), '.sidebar-place-card lost its height cap')
      .toMatch(/max-height:\s*16vh/)
    // The drawer reads its cap from the wrapper's budget instead of writing 46vh itself; see the
    // shared-budget suite below for why, and for the 46vh fallback that keeps an unwrapped drawer
    // -- the atlas -- exactly as it was.
    expect(desktopRule('.sidebar-drawer'), '.sidebar-drawer lost its height cap')
      .toMatch(/max-height:\s*var\(--sidebar-drawer-cap,\s*46vh\)/)
    for (const selector of ['.sidebar-place-card', '.sidebar-drawer']) {
      const body = desktopRule(selector)
      expect(body, `${selector} is not shrinkable`).toMatch(/flex:\s*0\s+1\s+auto/)
      // A column layout, or the section below the cap cannot be told to scroll instead of overflow.
      expect(body, `${selector} is not a column`).toMatch(/flex-direction:\s*column/)
    }
    // The inner sections no longer pin a height of their own, or the wrapper could not shrink them.
    expect(desktopRule('.sidebar-drawer-body')).not.toMatch(/max-height/)
    expect(css).not.toMatch(/\.sidebar-place-card \.place-card\s*\{[^}]*max-height/)
  })

  /**
   * A query route takes the whole rail over. When one is open the address book is not rendered, so
   * the route card is the only section under the header and must fill the column rather than sit
   * under the shared-with-a-list `46vh` cap that would strand the rest of the rail empty. The base
   * card keeps its cap (asserted above); the `.is-full` modifier lifts it and lets the card grow.
   *
   * The narrow sheet shrinks nothing -- it scrolls -- so the modifier's desktop `flex: 1 1 auto`,
   * which outweighs `.map-sidebar > *`'s `flex: none` on specificity, is put back to `none` there.
   */
  it('lets a full-takeover route card fill the desktop rail and stay content-sized in the sheet', () => {
    const full = desktopRule('.sidebar-place-card.is-full')
    expect(full, '.sidebar-place-card.is-full has no desktop rule').not.toBeNull()
    expect(full, '.is-full does not fill the rail').toMatch(/flex:\s*1\s+1\s+auto/)
    expect(full, '.is-full keeps a height cap').toMatch(/max-height:\s*none/)
    expect(narrowRule('.sidebar-place-card.is-full'), '.is-full still grows in the sheet')
      .toMatch(/flex:\s*none/)
  })

  /**
   * And lifting the cap means the card has to be able to give way, which is #120.
   *
   * A flex item's automatic minimum is its content size clamped by its own *definite* `max-height`.
   * The base card is capped at `16vh`, so it can never overflow the rail; `.is-full` removes the cap
   * and removes that clamp with it, and without `min-height: 0` the card floors at its content and
   * `flex-shrink` has nothing to act on. Measured at 1440x900 before the fix: the card held 1028px
   * inside a 900px `overflow: hidden` rail and 229px of the routed plan was unreachable by any means.
   *
   * `.hud-slideover` needs the same floor removed. It is the card's own flex item, so it floors on
   * its content in exactly the same way, and shrinking the card alone would move the overflow one
   * box inwards rather than resolve it. It already carries `overflow: auto`, so once it can shrink
   * it scrolls.
   *
   * This does not contradict `never squeezes the place card past its own evidence` below, which bans
   * the same declaration on the *base* card. That ban exists because the base card shares the rail
   * with the address list and the drawers, and a card that can shrink is the one that loses. In the
   * takeover state none of them are rendered, so this card is the column's only flex item: `flex: 1
   * 1 auto` makes it take all the space rather than less, and there is nothing to squeeze it.
   */
  it('lets a full-takeover route card give way to the rail instead of overflowing it', () => {
    expect(desktopRule('.sidebar-place-card.is-full'),
      '.is-full floors on its content and will overflow the rail').toMatch(/min-height:\s*0/)

    const slideover = rules().filter((one) => one.selector.split(',')
      .some((part) => part.trim() === '.sidebar-place-card > .hud-slideover'))
    expect(slideover.length, "no rule lets the route card's slideover shrink").toBeGreaterThan(0)
    expect(slideover.some((one) => /min-height:\s*0/.test(one.body)),
      'the slideover floors on its content, so the card shrinking only moves the overflow inwards')
      .toBe(true)
  })

  /**
   * `min-height: 0` here is the difference between "the legend collapses to its summary" and "the
   * legend collapses to ten pixels and you can no longer click it", which is what a full column
   * actually did when this was first written. Leaving the drawer's minimum at `auto` floors it on its
   * content clamped by its own `max-height` -- measured at 368px in an 800px viewport, with the
   * summary always inside that -- so the control stays clickable however hard the column pushes.
   *
   * The ban is checked at every width, not just on the desktop rule, because a narrow override would
   * apply to the same element. Note the filter is an exact string match: it is deliberately blind to
   * `.sidebar-drawer::details-content`, which is a different box and *is* meant to shrink, but it is
   * equally blind to any future rule that reaches this element by some other selector.
   */
  it('never shrinks the legend drawer past its own summary', () => {
    const drawerRules = rules().filter((one) => one.selector.split(',')
      .some((part) => part.trim() === '.sidebar-drawer'))
    // Or the loop below would pass by matching nothing at all.
    expect(drawerRules.length, 'no .sidebar-drawer rule to check').toBeGreaterThan(1)
    for (const rule of drawerRules) {
      expect(rule.body, 'a .sidebar-drawer rule sets min-height: 0').not.toMatch(/min-height:\s*0/)
    }
    expect(desktopRule('.sidebar-drawer-body')).toMatch(/min-height:\s*0/)
    expect(css).toMatch(/\.sidebar-drawer > summary \{[^}]*flex:\s*none/)
  })

  /**
   * The layers panel names itself with a heading it owns, not with a `<legend>`.
   *
   * A `legend` is a *rendered legend*: the browser lifts it out of flow into the block-start border,
   * centred on the border line. That border is also the top edge of a floating panel, so the upper
   * half of "LAYERS" was drawn above the panel against the map and read as clipped. Nothing in CSS
   * puts it back -- `padding-top` on the box and `margin-top` on the legend were both measured and
   * both moved it not at all -- so the fix is to stop using the element whose whole purpose is to sit
   * in the border.
   *
   * Worth knowing if this is ever revisited: `getBoundingClientRect` reported the legend flush with
   * the fieldset, because a fieldset's box is measured from its rendered legend's top. The geometry
   * looked correct while the pixels did not, and only a screenshot settled it.
   */
  /**
   * The address book is now a disclosure, because the live feed took the rail's default subject.
   *
   * That makes it the fourth `<details>` in this layout and it inherits every trap the drawers
   * already documented: the floor lives on `::details-content`, never on the `<details>` itself,
   * and a rule written into the wrong `@media` block loses on source order without failing.
   */
  it('collapses the address book behind a disclosure rather than dropping it', () => {
    const address = readFileSync(new URL('./AddressPanel.tsx', import.meta.url), 'utf8')
    expect(address, 'the address book is no longer a <details>')
      .toMatch(/<details\s[\s\S]{0,120}?className="sidebar-directory"/)
    expect(address, 'the disclosure has no summary to click').toMatch(/<summary/)
    expect(desktopRule('.sidebar-directory'), '.sidebar-directory has no rule at all').not.toBeNull()
  })

  /*
   * The 10px-drawer defect, transplanted. `min-height: 0` on the <details> shrinks the box that
   * holds the summary, so the control you click to open the directory gets clipped away and the
   * address book becomes unreachable rather than merely closed.
   */
  it('never shrinks the directory past its own summary', () => {
    const own = rules().filter((one) => one.selector.split(',')
      .some((part) => part.trim() === '.sidebar-directory'))
    expect(own.length, 'no .sidebar-directory rule to check').toBeGreaterThan(0)
    for (const rule of own) {
      expect(rule.body, 'a .sidebar-directory rule sets min-height: 0').not.toMatch(/min-height:\s*0/)
    }
    // The floor belongs on the box that is actually the flex item.
    expect(css).toMatch(/\.sidebar-directory::details-content \{[^}]*min-height:\s*0/)
    expect(css).toMatch(/\.sidebar-directory > summary \{[^}]*flex:\s*none/)
  })

  /*
   * `::details-content` is `display: block` with `min-height: auto`, so it floors on its own content
   * however hard the column pushes. Making it a flex column is what lets the shrink reach the
   * scroller inside, which is the only reason the directory can give way at all.
   */
  it('lets the shrink reach the scroller inside the directory', () => {
    const content = ownRule('.sidebar-directory::details-content')
    expect(content, '.sidebar-directory::details-content has no rule').not.toBeNull()
    expect(content).toMatch(/display:\s*flex/)
    expect(content).toMatch(/flex-direction:\s*column/)
  })

  /*
   * A definite max-height is what gives the directory a bounded automatic minimum, so it cannot
   * floor at the full height of a 60-object address list and push the feed out of the rail.
   */
  it('caps the open directory so a long address list cannot evict the feed', () => {
    expect(desktopRule('.sidebar-directory')).toMatch(/max-height:\s*\d+(?:\.\d+)?vh/)
  })

  /*
   * The cap above is not enough on its own, and pairing it with an explicit floor is what fixes the
   * defect this guards.
   *
   * A flex item's *automatic* minimum is its content size clamped by its own definite `max-height`.
   * So with `min-height: auto` the cap acted as a floor as well as a ceiling: a directory holding a
   * 60-entry address list floored at the whole 62vh and could not give way at all, and the rail
   * overflowed behind `overflow: hidden`. Measured with the directory open, 249px of the column was
   * unreachable at 1440x900 and 271px at 1115x800 -- the AGENTS.md clipping signature. Naming a
   * floor replaces the automatic minimum, and the same six states then measure 0 unreachable.
   *
   * `.sidebar-feed` never had this problem because it already names an explicit `min-height`, which
   * is what made the asymmetry easy to miss.
   *
   * The floor has to be small enough to be a floor rather than a second cap, and large enough that
   * the summary can never be clipped -- the 10px-drawer invariant, guarded separately above.
   */
  it('gives the directory an explicit floor so its cap cannot become one', () => {
    const own = desktopRule('.sidebar-directory')
    expect(own, '.sidebar-directory has no rule at all').not.toBeNull()
    const floor = own!.match(/min-height:\s*([\d.]+)rem/)
    expect(floor, '.sidebar-directory names no explicit min-height, so it floors at its max-height')
      .not.toBeNull()
    const rem = Number(floor![1])
    expect(rem, 'the directory floor is a second cap, not a floor').toBeLessThan(6)
    expect(rem, 'the directory floor is too low to keep the summary clickable')
      .toBeGreaterThanOrEqual(2.5)
  })

  /*
   * The point of collapsing it: with the directory shut there is nothing competing for the rail, so
   * the feed should take the space rather than sitting at its own cap with dead air beneath it.
   *
   * `:has()` and not `:where()` inside it -- `:has()` takes a relative selector list, `:where()` a
   * complex one, so a leading combinator inside `:where()` is dropped by forgiving parsing and the
   * rule silently matches everything.
   */
  it('gives the feed the rail back when the directory is closed', () => {
    const lifted = css.match(/\.map-sidebar:has\(> \.sidebar-directory:not\(\[open\]\)\)[^{]*\{[^}]*\}/)
    expect(lifted, 'no rule lifts the feed cap when the directory is closed').not.toBeNull()
    expect(lifted![0]).toMatch(/max-height:\s*none/)
    expect(lifted![0], 'a :where() inside :has() is dropped by forgiving parsing')
      .not.toMatch(/:where\(/)
  })

  /*
   * Source order, the trap AGENTS.md calls out: base sidebar rules sit after the FIRST
   * max-width:860px block, so a narrow override written into that block loses to them silently.
   *
   * `lastNarrowRuleFor` is no use here because it only matches a selector that owns its own brace,
   * and this override rides in a comma group with the other capped sections. Comparing raw offsets
   * is the same check without that assumption.
   */
  it('declares the directory narrow override after the base rule it overrides', () => {
    const base = css.indexOf('\n.sidebar-directory {')
    expect(base, 'no base .sidebar-directory rule').toBeGreaterThan(-1)

    const override = css.lastIndexOf('.sidebar-directory,')
    expect(override, 'no grouped narrow override for .sidebar-directory').toBeGreaterThan(-1)
    expect(override, 'the narrow override is declared before the rule it overrides')
      .toBeGreaterThan(base)

    // And specifically inside the last narrow block, not merely later in the file.
    const lastSheetBlock = css.lastIndexOf(`@media (max-width: ${SHEET}px)`)
    expect(override, 'the override is not in the last narrow block').toBeGreaterThan(lastSheetBlock)
  })

  /*
   * In the sheet the rail's caps are lifted wholesale, because the sheet scrolls as one column
   * instead of dividing a fixed height. A directory left capped at a fraction of the viewport there
   * would scroll inside a page that is already scrolling.
   */
  it('lifts the directory cap in the bottom sheet', () => {
    expect(narrowRule('.sidebar-directory')).toMatch(/max-height:\s*none/)
  })

  it('gives the layers panel a heading rather than a legend in its border', () => {
    expect(city, 'the layers panel is back to a fieldset/legend').not.toMatch(/<legend>/)
    expect(city, 'the layers panel is no longer a labelled group')
      .toMatch(/className="hud-layers" role="group" aria-labelledby=/)
    // The accessible name has to be the visible string, not a second copy that can drift from it.
    expect(city, 'the heading the group points at is not rendered')
      .toMatch(/className="hud-layers-title" id=\{layersTitleId\}>Layers</)
    expect(desktopRule('.hud-layers-title'), '.hud-layers-title has no rule at all').not.toBeNull()
    // And the old rule is gone, or it would style an element nobody renders.
    expect(css, '.hud-layers legend still has a rule').not.toMatch(/\.hud-layers legend/)
  })

  /**
   * The place card gets the same floor the drawer has, and for the same reason.
   *
   * With `min-height: 0` the card was the only section on the rail that could give way, so it gave
   * way entirely: flex distributes shrink in proportion to flex-basis, and the address list's basis
   * is its whole scroll height, so the list kept its space while the card lost nearly all of its own.
   * Measured at 1440x900 with both drawers open, the card held 72px of 472px of content -- the title
   * and nothing else -- and 414px of the selected object's measured evidence was reachable only by
   * scrolling a 72px window. 47px at 1280x720; 81px at 1115x800, which is the case AGENTS.md already
   * described. Leaving the minimum at `auto` floors the card at its content clamped by its own cap:
   * 252px, 202px and 224px at those three sizes, with five rows of the evidence list on screen at
   * 1440x900 and the rest reachable inside the card's own scroller.
   *
   * Checked at every width, like the drawer's ban: a narrow override would reach the same element.
   */
  it('never squeezes the place card past its own evidence', () => {
    const cardRules = rules().filter((one) => one.selector.split(',')
      .some((part) => part.trim() === '.sidebar-place-card'))
    // Or the loop below would pass by matching nothing at all.
    expect(cardRules.length, 'no .sidebar-place-card rule to check').toBeGreaterThan(1)
    for (const rule of cardRules) {
      expect(rule.body, 'a .sidebar-place-card rule sets min-height: 0').not.toMatch(/min-height:\s*0/)
    }
    // The floor is only a floor because the cap is definite; without it the card would floor on its
    // full content instead and overflow the rail.
    expect(desktopRule('.sidebar-place-card'), '.sidebar-place-card lost the cap its floor depends on')
      .toMatch(/max-height:\s*16vh/)
  })

  /**
   * And the card's floor is paid for by the drawers, not by the address list.
   *
   * Three sections claim one rail. Taking the card's floor out of the list left the list at 78px at
   * 1440x900 and at 0px at 1280x720 with 6px of the rail unreachable -- a column that does not
   * overflow and is still useless, which is the failure AGENTS.md warns measuring overflow alone
   * does not catch. Yielding the drawers' budget instead holds the list at 231px and 141px.
   *
   * A sibling combinator, not `:has()`: the card precedes the drawers, so no parent selector is
   * needed, and an engine without `:has()` still applies this one -- where the widened-cap rule
   * above drops out and leaves every drawer on the third share, which is the safe direction.
   *
   * 18vh rather than the 16vh two drawers shared or the 24vh three did. Another drawer does not make
   * the region cheaper: 16vh three ways is 42.6px at an 800px viewport, a 35px summary and a 7.6px
   * body, which overflows nothing and is unreadable -- the "necessary, not sufficient" failure again.
   * 24vh four ways reproduced it exactly: measured at 1115x800 the live query feed held 15px of body
   * at rest and 12px with everything open, and widening to 28vh only took that to 26px and 5px. The
   * feed is a region of its own now (see `.sidebar-feed`), so these three are reference material
   * again and the budget goes back down -- the 10vh released pays for the feed's floor instead.
   */
  it('makes an open place card take its share from the drawers', () => {
    const yielded = desktopRule('.sidebar-drawers.is-yielding')
    expect(yielded, 'the drawers do not yield to an open place card').not.toBeNull()
    expect(yielded, 'the yielded budget is not smaller than the default')
      .toMatch(/--sidebar-drawer-budget:\s*18vh/)
    // The default the drawers keep when no card is open, which this reduces from.
    expect(desktopRule('.sidebar-drawers')).toMatch(/--sidebar-drawer-budget:\s*34vh/)
    // Still a share of a budget, so each drawer keeps flooring at min(content, cap) and its summary
    // stays inside that: measured 72px and 58px against a 35px summary.
    expect(desktopRule('.sidebar-drawer')).toMatch(/max-height:\s*var\(--sidebar-drawer-cap,\s*46vh\)/)
    // And the markup actually sets it, or the rule above is styling nothing.
    expect(markup, 'the drawers wrapper never gets the yielding modifier')
      .toMatch(/sidebar-drawers\$\{\s*placeCard \? ' is-yielding' : ''\s*\}/)
  })

  /**
   * The box the drawer actually shrinks (#63).
   *
   * `details` wraps everything after its summary in a `::details-content` box, and *that* box is the
   * second flex item of `.sidebar-drawer` -- not the summary, and not `.sidebar-drawer-body`. It is
   * `display: block; min-height: auto`, so it floored on its own content (479.688px measured) while
   * the drawer's `max-height: 46vh` held the drawer at 368px, and the 147px difference spilled out of
   * a `.map-sidebar` that is `overflow: hidden`, unreachable.
   *
   * `.sidebar-drawer-body` was already a `min-height: 0` scroller, but a block box in front of it
   * absorbed no shrink and forwarded none, so it never had a height to scroll inside of. Making the
   * content box shrinkable *and* a flex column is what connects the two.
   */
  it('lets the drawer shrink the box that actually holds its content', () => {
    const content = desktopRule('.sidebar-drawer::details-content')
    expect(content, '.sidebar-drawer::details-content has no rule at all').not.toBeNull()
    // Without this the box floors on its content and no flex arrangement above it can win.
    expect(content, 'the drawer content box still refuses to shrink').toMatch(/min-height:\s*0/)
    // And the pressure has to reach the scroller inside, or the box just clips instead.
    expect(content, 'the drawer content box does not forward its shrink').toMatch(/display:\s*flex/)
    expect(content).toMatch(/flex-direction:\s*column/)
    expect(desktopRule('.sidebar-drawer-body'), 'nothing to receive the shrink').toMatch(/overflow:\s*auto/)
    // The drawer element itself is untouched: it still caps, and it still floors on its content.
    expect(desktopRule('.sidebar-drawer')).toMatch(/max-height:\s*var\(--sidebar-drawer-cap,\s*46vh\)/)
  })
})

/**
 * The narrow bottom sheet scrolls as one region.
 *
 * At <=860px the sidebar is 42% of the viewport -- 293px at 800x700 -- and the desktop column does
 * not survive that height. Measured with the legend drawer open, the sections' minimums totalled
 * 427px in a 293px sheet: the address list was squeezed to 0px and 134px of the drawer was clipped
 * with no way to reach it. The drawer would not give way because `details` wraps its children in a
 * `::details-content` box that is the flex item, and that box is `display: block; min-height: auto`,
 * so it floors on its content no matter how hard the column pushes.
 *
 * So the sheet is now a single scroll container, the way every mobile map behaves: the header and the
 * search box scroll with the content, every section sizes to its content, and the sheet takes the
 * overflow. These are the parts of that contract a source-text test can see. What it cannot see is
 * the measurement itself -- that the sheet's scrollHeight is now reachable rather than clipped -- so
 * that is verified in a browser, which is how the ten-pixel drawer got past this file the first time.
 */
describe('the narrow bottom sheet scrolls as one region', () => {
  /** The sheet takes the overflow itself, instead of clipping it as the desktop rail does. */
  it('makes the sheet the scroll container', () => {
    const sheet = narrowRule('.map-sidebar')
    expect(sheet, '.map-sidebar has no narrow rule').not.toBeNull()
    expect(sheet).toMatch(/overflow:\s*auto/)
    // The page is position: fixed, so a chained scroll has nowhere to go.
    expect(sheet).toMatch(/overscroll-behavior:\s*contain/)
    // And the desktop rail still clips, because there the sections scroll instead.
    expect(desktopRule('.map-sidebar')).toMatch(/overflow:\s*hidden/)
  })

  /**
   * Nothing in the sheet shrinks. Shrinking is what produced the 0px address list: the sections that
   * could give way gave way entirely, the one that could not kept its size, and the column still
   * overflowed. Sized from content it simply outgrows the sheet, which the sheet now handles.
   *
   * Both halves of the selector matter. `.sidebar-drawers` is `display: contents` here, which removes
   * the wrapper's box but not the wrapper: the drawers become flex items of the sheet while
   * `.map-sidebar > *` goes on matching the wrapper, where `flex` is inert. Drop the second half and
   * the drawers hold their size only by their content-based automatic minimum -- true today, and true
   * by accident.
   */
  it('sizes every section from its content instead of shrinking it', () => {
    expect(narrowRule('.map-sidebar > *'), 'the sheet lets its sections shrink').toMatch(/flex:\s*none/)
    expect(narrowRule('.sidebar-drawers > *'), 'flex: none no longer reaches the drawers')
      .toMatch(/flex:\s*none/)
  })

  /**
   * A nested scroller inside a scrolling sheet is a gesture trap: you drag over the address list
   * expecting the sheet to move and the list swallows it. Every scroller the desktop rail defines
   * inside the sidebar has to be switched off here.
   *
   * This is also what keeps the desktop `::details-content` fix (#63) out of the sheet. That rule is
   * not media-scoped -- it forwards shrink to `.sidebar-drawer-body` at every width -- but a forwarded
   * shrink only becomes a scroller if the body scrolls, and here it does not. Measured at 800x700
   * with the drawer open, the sheet has zero nested scrollers before and after that change.
   */
  it('leaves no scroller nested inside the scrolling sheet', () => {
    for (const selector of ['.sidebar-scroll', '.sidebar-drawer-body', '.sidebar-place-card .place-card']) {
      expect(desktopRule(selector), `${selector} is not a desktop scroller`).toMatch(/overflow:\s*auto/)
      expect(narrowRule(selector), `${selector} still scrolls inside the sheet`).toMatch(/overflow:\s*visible/)
    }
  })

  /**
   * And nothing shrinks the drawer here either, so the content box has nothing to forward.
   *
   * `.map-sidebar > *` is `flex: none` and the drawer's cap is dropped, so the drawer sizes to its
   * content and the `::details-content` box is never compressed. If a future change gives the drawer
   * a height in the sheet, this is the assertion that should start failing.
   */
  it('never compresses the drawer content box inside the sheet', () => {
    expect(narrowRule('.sidebar-drawer'), '.sidebar-drawer keeps a cap in the sheet').toMatch(/max-height:\s*none/)
    expect(narrowRule('.map-sidebar > *')).toMatch(/flex:\s*none/)
    expect(narrowRule('.sidebar-drawers > *')).toMatch(/flex:\s*none/)
    // The desktop fix is defined once, outside any media query, and is inert here rather than undone.
    expect(desktopRule('.sidebar-drawer::details-content')).not.toBeNull()
    expect(narrowRule('.sidebar-drawer::details-content')).toBeNull()
  })

  /**
   * The 46vh caps exist to let a section shrink inside a fixed-height column. There is no such column
   * here any more, and a cap on a section of a scrolling sheet only reintroduces a nested scroller.
   */
  it('drops the height caps the scrolling sheet no longer needs', () => {
    for (const selector of ['.sidebar-place-card', '.sidebar-drawer']) {
      expect(narrowRule(selector), `${selector} keeps a cap in the sheet`).toMatch(/max-height:\s*none/)
    }
  })

  /**
   * A media query carries no extra specificity, so source order decides. These overrides target rules
   * defined *below* the stylesheet's first narrow block -- `.sidebar-drawer` is near the end of the
   * file -- so written there they would every one of them lose, silently.
   */
  it('declares the sheet overrides after the rules they override', () => {
    // The block these overrides live in, which has to come after every base rule it overrides.
    const block = css.lastIndexOf(`@media (max-width: ${SHEET}px)`)
    expect(block).toBeGreaterThan(-1)
    for (const selector of ['.map-sidebar', '.sidebar-scroll', '.sidebar-place-card', '.sidebar-drawer']) {
      const base = css.indexOf(`\n${selector} {`)
      expect(base, `${selector} base rule`).toBeGreaterThan(-1)
      expect(block, `${selector} is overridden before it is defined`).toBeGreaterThan(base)
    }
    // And the overrides really are in that last block rather than an earlier, losing one.
    expect(css.slice(block)).toMatch(/\.map-sidebar\s*\{[^}]*overflow:\s*auto/)
    expect(css.slice(block)).toMatch(/\.sidebar-drawer\s*\{[^}]*max-height:\s*none/)
  })
})

/**
 * Two drawers in one rail share one height budget (#65).
 *
 * A flex item's automatic minimum is its content height clamped by its own definite `max-height`, so
 * a capped drawer floors at `min(content, cap)` and the column cannot push it lower. That floor is
 * the point -- it is what keeps the summary clickable, and removing it is the ten-pixel-drawer defect
 * pinned above -- but it does not compose. Two drawers each capped at a flat 46vh floor at 46vh
 * *each*, and the city rail has two: the plan finder and the legend.
 *
 * Measured in Chromium at 1115x800 against a live backend, with the plan finder holding 12 real
 * captured plans and both drawers open: `.map-sidebar` 800 client / 967 scroll, `overflow: hidden`,
 * 167px unreachable, `.sidebar-scroll` squeezed to 0px, and the address entries no longer clickable
 * -- a trusted Playwright click timed out after 8s. After the wrapper: 800/800, 0 unreachable,
 * `.sidebar-scroll` 154px, trusted click passes in 9ms.
 *
 * So the budget moves up one level, onto a wrapper the drawers divide. What this file can check is
 * the shape of that arrangement; that the resulting column is *usable* rather than merely
 * non-overflowing is a browser measurement, which is how both previous defects here got past a green
 * suite.
 */
describe('three drawers in one rail share one height budget', () => {
  const cityMarkup = readFileSync(new URL('./DatabaseCityView.tsx', import.meta.url), 'utf8')
  const atlasMarkup = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

  /** The wrapper carries the whole budget, so the drawer region costs what one drawer costs. */
  it('caps the wrapper rather than each drawer', () => {
    const wrapper = desktopRule('.sidebar-drawers')
    expect(wrapper, '.sidebar-drawers has no rule at all').not.toBeNull()
    expect(wrapper, 'the budget is not declared').toMatch(/--sidebar-drawer-budget:\s*34vh/)
    expect(wrapper, 'the wrapper does not cap at the budget')
      .toMatch(/max-height:\s*var\(--sidebar-drawer-budget\)/)
    expect(wrapper, 'the wrapper cannot shrink into the rail').toMatch(/flex:\s*0\s+1\s+auto/)
    // A column, or the shrink never reaches the drawers inside.
    expect(wrapper).toMatch(/display:\s*flex/)
    expect(wrapper).toMatch(/flex-direction:\s*column/)
  })

  /**
   * And never `min-height: 0` on the wrapper either. It is `overflow: visible`, so a shrinkable
   * wrapper would simply spill its drawers back out of a clipped rail -- the #63 defect one level out.
   */
  it('never lets the wrapper shrink out from under its drawers', () => {
    const wrapperRules = rules().filter((one) => one.selector.split(',')
      .some((part) => part.trim() === '.sidebar-drawers'))
    expect(wrapperRules.length, 'no .sidebar-drawers rule to check').toBeGreaterThan(0)
    for (const rule of wrapperRules) {
      expect(rule.body, 'a .sidebar-drawers rule sets min-height: 0').not.toMatch(/min-height:\s*0/)
    }
  })

  /**
   * The drawer reads the cap; it does not write one. The `46vh` fallback is what an *unwrapped*
   * drawer gets, which is the atlas, so that column is byte-identical -- measured at 1115x800 as
   * 800/800, 0 unreachable, drawer at 368px, legend body scrolling 332 internally, before and after.
   */
  it('hands each drawer a share of the budget, with the old cap as the fallback', () => {
    expect(desktopRule('.sidebar-drawer'))
      .toMatch(/max-height:\s*var\(--sidebar-drawer-cap,\s*46vh\)/)
    expect(desktopRule('.sidebar-drawers'))
      .toMatch(/--sidebar-drawer-cap:\s*calc\(var\(--sidebar-drawer-budget\)\s*\/\s*3\)/)
  })

  /**
   * `:has()` relaxes the share, it never tightens it, and it is written without `:where()`.
   *
   * The default is the tightest share -- all three open -- which always fits, and the conditional
   * rules relax it for smaller open counts. That direction is the whole safety argument: neither
   * `:has()` nor the `:not()` around it is forgiving, so an engine without `:has()` invalidates and
   * drops every conditional rule and lands on the third share.
   *
   * Each conditional matches exactly one open count -- `:has(N)` and not `:has(N+1)` -- so no two of
   * them ever apply to the same element and neither source order nor specificity decides between
   * them. This is not tidiness. A plain run of `:not(:has(N open))` rules, widening as drawers close,
   * is silently broken, because `:has()` takes its specificity from its argument: the three-link
   * chain scores (0,7,0) and the two-link (0,5,0), so the tightest rule outranks every rule meant to
   * relax it no matter what order they are written in. Measured in Chromium at 1115x800 with two of
   * four drawers open, the cap came back `calc((24vh - 2.5rem) / 3)` -- the three-open share -- and
   * one open drawer got the same, 50.7px against a 35px summary.
   *
   * `:where()` would flatten that specificity, and must still not be used. `:has()` takes a relative
   * selector list, in which a selector may begin with a combinator; `:where()` takes a *complex*
   * selector list, in which it may not. So `:where(> .sidebar-drawer[open] ~ ...)` has its argument
   * dropped by forgiving parsing rather than failing, and Chromium reads the rule back with an empty
   * list. Verified by reading `selectorText` off the parsed `CSSStyleSheet`.
   */
  it('relaxes the cap for smaller open counts without letting the rules compete', () => {
    const conditionals = rules().filter((one) => /^\.sidebar-drawers:has\(/.test(one.selector))
    expect(conditionals.length, 'two conditional cap rules are needed for three drawers').toBe(2)
    for (const rule of conditionals) {
      expect(rule.selector, ':where() drops its argument here and breaks the rule')
        .not.toMatch(/:where\(/)
    }

    const chain = (count: number) =>
      `> ${Array.from({ length: count }, () => '.sidebar-drawer[open]').join(' ~ ')}`
    /** Exactly `count` open: has that many, and does not have one more. */
    const exactly = (count: number) =>
      `.sidebar-drawers:has(${chain(count)}):not(:has(${chain(count + 1)}))`

    const [oneOpen, twoOpen] = conditionals

    expect(oneOpen.selector, 'the lone-drawer rule does not match exactly one open drawer')
      .toBe(exactly(1))
    expect(oneOpen.body, 'a lone drawer may spend the budget less two collapsed summaries')
      .toMatch(/--sidebar-drawer-cap:\s*calc\(var\(--sidebar-drawer-budget\)\s*-\s*4\.375rem\)/)

    expect(twoOpen.selector, 'the two-drawer rule does not match exactly two open drawers')
      .toBe(exactly(2))
    expect(twoOpen.body, 'two drawers must divide the budget less the third summary')
      .toMatch(/--sidebar-drawer-cap:\s*calc\(\(var\(--sidebar-drawer-budget\)\s*-\s*2\.1875rem\)\s*\/\s*2\)/)

    /*
     * The allowance is per *collapsed* summary, and a collapsed summary costs 35px -- 2.1875rem
     * against this stylesheet's 16px root. Not 34px: `box-sizing` is `border-box` and every drawer
     * carries a 1px `border-top`, so its border box is the 34px summary plus that rule. Under-pricing
     * it by that 1px puts the region over its budget in a rail that is `overflow: hidden` -- measured
     * at 1115x800, 3px of the column out of reach with one drawer open and 2px with two. Over-pricing
     * it, as the 2.5rem this rule used to, spends 5px a drawer that nothing ever claims, so the
     * region costs less than its budget and the address list jumps whenever a drawer opens. Exact is
     * the only value that does neither.
     */
    for (const [index, rule] of conditionals.entries()) {
      const closed = 2 - index
      const allowance = Number(/-\s*([\d.]+)rem/.exec(rule.body)?.[1])
      expect(allowance, `the ${index + 1}-open rule does not spend a summary allowance`).not.toBeNaN()
      expect(allowance, `the ${index + 1}-open rule misprices ${closed} collapsed summaries`)
        .toBeCloseTo(closed * (35 / 16), 5)
    }
    /*
     * And the 1px the allowance pays for is really there and really inside the box. Change either and
     * the arithmetic above is wrong by a pixel per closed drawer, which is a clipped rail rather than
     * a visible mistake.
     */
    expect(desktopRule('.sidebar-drawer'), 'the drawer lost the border the allowance prices in')
      .toMatch(/border-top:\s*1px\s+solid/)
    expect(
      readFileSync(new URL('./index.css', import.meta.url), 'utf8'),
      'nothing sets border-box, so the cap no longer includes that border',
    ).toMatch(/\*\s*\{[^}]*box-sizing:\s*border-box/)

    // And all of them come after the base rule they relax, or they would lose on source order.
    expect(css.indexOf('.sidebar-drawers:has('), 'the conditional rule is not in the stylesheet')
      .toBeGreaterThan(css.indexOf('\n.sidebar-drawers {'))
  })

  /** A budget nothing is inside is not a budget. All three drawers have to be in the wrapper. */
  it('renders every city drawer inside the wrapper', () => {
    // Matched by prefix rather than as a literal: the wrapper also carries the `is-yielding`
    // modifier that hands its budget to an open place card, so pinning the exact opening tag here
    // would fail for a change that has nothing to do with what this test is about.
    const open = cityMarkup.search(/<div className=[{"`]+sidebar-drawers/)
    expect(open, 'DatabaseCityView renders no .sidebar-drawers wrapper').toBeGreaterThan(-1)
    const close = cityMarkup.indexOf('</div>', open)
    const wrapped = cityMarkup.slice(open, close)
    expect(wrapped, 'live activity is outside the budget').toContain('{liveActivityDrawer}')
    expect(wrapped, 'the plan finder is outside the budget').toContain('{planFinder}')
    expect(wrapped, 'the legend drawer is outside the budget').toContain('<LegendDrawer')
    // The metric stays outside: it is `flex: none` and shrinking it was never the problem.
    expect(wrapped).not.toContain('sidebar-metric')
    /*
     * And the live query feed is deliberately *not* in it. As a fourth drawer sharing this budget it
     * measured 26px of body at rest and 5px with everything open at 1115x800 -- a fraction of one
     * 54px row -- because an evenly divided budget cannot say that one surface is the primary one.
     * It is a region of its own now; see `.sidebar-feed`.
     */
    expect(wrapped, 'the live query feed is back inside the drawer budget that starved it')
      .not.toContain('liveQueryFeed')
  })

  /**
   * The feed is the rail's other scrolling region, and it takes its space like one.
   *
   * `flex: 1 1 auto` sizes it from content so a column with room to spare is unchanged, and both
   * bounds are load-bearing against the same failure in opposite directions. The feed's content is
   * the whole 60-row log, an order of magnitude taller than the address list beside it, and flex
   * distributes shrink in proportion to base size: without the floor the address list absorbs almost
   * all of it and hits 0px before the feed gives up anything, and without the cap the feed claims its
   * full content height and does the same thing harder. 132px is the head plus two whole 54px rows.
   */
  it('gives the live query feed a floor and a ceiling of its own', () => {
    const feed = desktopRule('.sidebar-feed')
    expect(feed, '.sidebar-feed has no rule at all').not.toBeNull()
    expect(feed, 'the feed does not take its space from content').toMatch(/flex:\s*1\s+1\s+auto/)
    expect(feed, 'the feed has no floor, so the address list pays for the whole squeeze')
      .toMatch(/min-height:\s*162px/)
    expect(feed, 'the feed has no ceiling, so it claims the rail')
      .toMatch(/max-height:\s*22vh/)
    // A column, or the shrink never reaches the scroller inside.
    expect(feed).toMatch(/display:\s*flex/)
    expect(feed).toMatch(/flex-direction:\s*column/)

    /*
     * The scroller is the body, not the region: the head stays pinned while the log moves under it,
     * and `min-height: 0` is what lets the body shrink into a scroller at all in a flex column.
     */
    const body = desktopRule('.sidebar-feed-body')
    expect(body, '.sidebar-feed-body has no rule at all').not.toBeNull()
    expect(body, 'the feed body cannot shrink, so the region overflows instead of scrolling')
      .toMatch(/min-height:\s*0/)
    expect(body, 'the feed body does not scroll').toMatch(/overflow:\s*auto/)
    expect(desktopRule('.sidebar-feed-head'), 'the feed head would shrink with the log')
      .toMatch(/flex:\s*none/)
  })

  /**
   * No CSS-wide keyword inside a `font` shorthand, anywhere in the stylesheet.
   *
   * `inherit` is not a legal *component* of a shorthand -- only a whole value -- so `font: 600
   * .74rem/1.2 inherit` is invalid and the entire declaration is dropped, while a bare `font:
   * inherit` is perfectly fine and is used all over this file to stop buttons from opting out of the
   * page's type. Nothing errors and nothing overflows; the element simply keeps whatever it
   * inherited, which for an `h2` is the UA's 1.5em bold. Measured at 1115x800 that took the feed's
   * head to 94px of the region's 131 and left the log 36px -- two thirds of one row, with every
   * reachability number clean.
   *
   * Checked across the whole file rather than on the one rule that had it, because the failure is
   * invisible at the point of writing and the file already contained a second instance.
   */
  it('never puts a CSS-wide keyword inside a font shorthand', () => {
    const wide = /\b(?:inherit|initial|unset|revert|revert-layer)\b/
    const offenders = rules()
      .flatMap((one) => (one.body.match(/(?:^|[;{])\s*font:\s*[^;}]+/g) ?? [])
        .map((match) => ({
          selector: one.selector,
          value: match.replace(/^[\s;{]*font:\s*/, '').trim(),
        })))
      // A whole value that is just the keyword is legal; a keyword beside anything else is not.
      .filter(({ value }) => wide.test(value) && !/^(?:inherit|initial|unset|revert|revert-layer)$/.test(value))
    expect(offenders, 'a font shorthand names a CSS-wide keyword, so the whole declaration is dropped')
      .toEqual([])
  })

  /**
   * The feed sits above the address book and below the place card, and renders with the address book.
   *
   * Ordering is what ties a row appearing to a car pulling away on the map: it is the first thing
   * under the card, so a reader who catches movement out of the corner of an eye has somewhere to
   * look. It is gated on the same condition as the address book because a full-takeover route card
   * owns the whole rail, and a feed wedged beside it would be the squeeze this change just undid.
   */
  it('renders the feed as a rail region beside the address list', () => {
    const declaration = cityMarkup.indexOf('const liveQueryFeed =')
    expect(declaration, 'there is no live query feed').toBeGreaterThan(-1)
    expect(cityMarkup.slice(declaration, cityMarkup.indexOf('</section>', declaration)),
      'the feed is no longer a region of the rail')
      .toMatch(/<section className="sidebar-feed"/)

    const rendered = cityMarkup.indexOf('{sidebarMode.showsAddressBook && !selectedRoad && liveQueryFeed}')
    expect(rendered, 'the feed does not render with the address book').toBeGreaterThan(-1)
    expect(rendered, 'the feed is not above the address book')
      .toBeLessThan(cityMarkup.indexOf('<AddressBook'))
    expect(rendered, 'the feed is not below the place card')
      .toBeGreaterThan(cityMarkup.indexOf('className={`sidebar-place-card'))
  })

  /**
   * The atlas is deliberately not wrapped. It renders one drawer, so it has nothing to divide, and
   * wrapping it would cut a cap that already fits to a third -- a regression dressed as consistency.
   * The `46vh` fallback is what makes leaving it alone a no-op rather than an omission.
   */
  it('leaves the single-drawer atlas column unwrapped', () => {
    expect(atlasMarkup).toContain('className="sidebar-drawer"')
    expect(atlasMarkup, 'the atlas has one drawer and nothing to share a budget with')
      .not.toContain('sidebar-drawers')
    expect((cityMarkup.match(/className="sidebar-drawer"/g) ?? []).length,
      'the city rail no longer has the drawers this budget exists for').toBe(3)
  })

  /**
   * At <=860px the wrapper stops generating a box, so the sheet is structurally what it was before
   * the wrapper existed rather than re-patched around it.
   *
   * The load-bearing part is subtle: custom properties inherit through `display: contents`, so the
   * drawers below go on inheriting `--sidebar-drawer-cap` -- an 11.5vh quarter-share, *tighter* than
   * the 46vh that predates this change. `max-height: none` in the same block is the only thing
   * discarding it. Weaken that override and the sheet's drawers do not return to their old cap, they
   * get a worse one, which is why it is pinned here as well as in the sheet suite above.
   */
  it('dissolves the wrapper in the narrow sheet', () => {
    expect(narrowRule('.sidebar-drawers'), '.sidebar-drawers has no narrow rule')
      .toMatch(/display:\s*contents/)
    expect(narrowRule('.sidebar-drawer'), 'the inherited quarter-share cap is no longer discarded')
      .toMatch(/max-height:\s*none/)
    // In the last block, or a media query with no extra specificity loses to the base rule.
    const block = css.lastIndexOf(`@media (max-width: ${SHEET}px)`)
    expect(css.slice(block)).toMatch(/\.sidebar-drawers\s*\{[^}]*display:\s*contents/)
    expect(block, 'the wrapper is dissolved before it is defined')
      .toBeGreaterThan(css.indexOf('\n.sidebar-drawers {'))
  })
})

/*
 * The count that rides beside a drawer title.
 *
 * Measured in Chromium before the fix, at 1440x900, 1115x800 and 820x900 alike: the gap between the
 * title's last glyph box and the badge's first was **0.00px** at every one of them, which is what
 * "City directory114 places" and "Live activityNo blocks" are. `.drawer-badge` simply had no rule.
 * After: 188.31px / 120.31px / 601.31px, each badge inset 16px from the trailing edge, still one
 * 34px line.
 *
 * These live in this file so they read the desktop/sheet split above rather than growing a fourth
 * private stylesheet parser -- and because the trap that split exists for applies here directly: a
 * narrow override for `.drawer-badge` would silently retarget the desktop assertion at itself.
 */
describe('the count beside a drawer title', () => {
  it('is separated from the title by CSS, because the markup cannot carry a space', () => {
    const rule = desktopRule('.drawer-badge')
    expect(rule, '.drawer-badge has no rule at all -- the title and the count run together').not.toBeNull()
    expect(rule, 'nothing holds the count off the title').toMatch(/padding-inline-start:\s*[^;]+/)
  })

  /*
   * The failure this pins is a *silent* one, which is why it is asserted rather than left to review.
   * `margin-inline-start: auto` is the idiomatic way to push a child to the trailing edge and it does
   * nothing at all here: it only resolves against free space inside a flex or grid container, and
   * `<summary>` is `display: list-item`. It parses, it survives every linter, and the badge stays
   * exactly where it was.
   */
  it('reaches the trailing edge by a means that works outside flex and grid', () => {
    const rule = desktopRule('.drawer-badge') ?? ''
    expect(rule, 'the count no longer reaches the trailing edge').toMatch(/float:\s*inline-end/)
    expect(rule, 'margin auto is inert on a list-item summary and will not move the badge')
      .not.toMatch(/margin-inline-start:\s*auto/)
  })

  /*
   * The other way to right-align this is `display: flex` on the summary, which works and takes the
   * disclosure triangle with it -- the triangle is `display: list-item`'s marker, and it is the only
   * thing on the row saying the row opens. So the badge must not be paid for out of the summary's
   * display type.
   */
  /*
   * Deliberately not `desktopRule`. `ownRule` returns the *last* rule matching the selector and its
   * optional pseudo-class, and the rule after each of these summaries is its own `:hover` -- so
   * `desktopRule('.sidebar-drawer > summary')` hands back `color: #dbe5ed` and an assertion about
   * `display` passes against a stylesheet that does set `display: flex`. That was caught by mutating
   * the stylesheet and watching this very test keep passing, which is the whole reason to run the
   * mutation rather than trust the green tick. Every rule targeting the summary has to be checked,
   * because any one of them can carry the declaration.
   */
  it('does not cost the summary its disclosure marker', () => {
    for (const selector of ['.sidebar-drawer > summary', '.sidebar-directory > summary']) {
      const matching = rules(desktopCss).filter((rule) => rule.selector
        .split(',')
        .some((one) => one.trim() === selector || one.trim().startsWith(`${selector}:`)))
      expect(matching.length, `no rule targets ${selector} any more`).toBeGreaterThan(0)
      for (const rule of matching) {
        expect(rule.body, `${selector} became a flex container, which drops the disclosure triangle`)
          .not.toMatch(/display:\s*(flex|grid|inline-flex|inline-grid)/)
      }
    }
  })

  it('reads as secondary to the title rather than competing with it', () => {
    const rule = desktopRule('.drawer-badge') ?? ''
    expect(rule, 'the count is not dimmed against the title').toMatch(/color:\s*#[0-9a-f]{6}/i)
    // Counts change in place while you watch them; proportional digits make the row twitch.
    expect(rule).toMatch(/font-variant-numeric:\s*tabular-nums/)
  })

  it('covers every summary that carries one, not just the one that was reported', () => {
    const panels = [
      readFileSync(new URL('./AddressPanel.tsx', import.meta.url), 'utf8'),
      readFileSync(new URL('./DatabaseCityView.tsx', import.meta.url), 'utf8'),
    ].join('\n')
    const uses = panels.match(/className="drawer-badge"/g) ?? []
    expect(uses.length, 'the badge class is no longer what the summaries use').toBeGreaterThanOrEqual(3)
  })
})
describe('the rail accordion', () => {
  /*
   * The measured defect this replaces, recorded so the numbers are not lost: at 1440x900 on
   * `AdventureWorks` with all four regions open, live activity, the plan finder and the legend each
   * held **18px of body** against 134px, 81px and 84,953px of content, while the directory held
   * 178px against 11,712px. The rail reported **0 unreachable pixels** the whole time -- every one
   * of those bodies is an `overflow: auto` scroller, and an 18px scroller clips nothing at all. That
   * is the "zero unreachable is necessary and not sufficient" failure, reached by a third route.
   *
   * The grant is what makes one open region worth opening. Without `max-height: none` the region
   * still divides the 34vh budget with three closed siblings.
   */
  it('gives the one open region the column instead of a share of a budget', () => {
    const grant = ownRule('.sidebar-drawer[open]', desktopCss)
    expect(grant, 'no rule grants an open drawer the column').not.toBeNull()
    expect(grant!, 'the open drawer still divides the budget').toMatch(/max-height:\s*none/)
    expect(grant!, 'the open drawer cannot grow into the column').toMatch(/flex:\s*1 1 auto/)
  })

  /*
   * Lifting the cap lifts the floor with it. A flex item's *automatic* minimum is its content size
   * clamped by its own definite `max-height`, so `max-height: none` on the legend floors it at the
   * whole 84,953px -- unshrinkable, and straight back out of a rail that is `overflow: hidden`.
   *
   * And the floor is emphatically not `0`: that is the 10px-drawer defect, where the summary you
   * click to close the region gets clipped along with everything else.
   */
  it('names a floor for the open region that is a floor and not a second cap', () => {
    for (const selector of ['.sidebar-drawer[open]', '.sidebar-directory[open]']) {
      const grant = ownRule(selector, desktopCss)
      expect(grant, `${selector} has no rule at all`).not.toBeNull()
      const floor = grant!.match(/min-height:\s*([\d.]+)rem/)
      expect(floor, `${selector} names no explicit floor, so it floors on its own content`)
        .not.toBeNull()
      const rem = Number(floor![1])
      expect(rem, `${selector} floors too low to keep its summary clickable`)
        .toBeGreaterThanOrEqual(2.5)
      expect(rem, `${selector} floor is a second cap, not a floor`).toBeLessThan(6)
    }
  })

  /*
   * The wrapper caps its drawers, so granting a drawer the column does nothing while the wrapper
   * itself is still pinned to 34vh. Both halves are needed; either alone is a no-op.
   */
  it('lets the drawer wrapper take the column when it holds the open region', () => {
    const rule = desktopRule('.sidebar-drawers.is-open')
    expect(rule, 'no rule lifts the wrapper when a drawer inside it is open').not.toBeNull()
    expect(rule!).toMatch(/max-height:\s*none/)
    expect(rule!).toMatch(/flex:\s*1 1 auto/)
  })

  /*
   * `.sidebar-drawers` is `overflow: visible`, so a wrapper that can shrink below its contents
   * spills the drawers back out of the clipped rail -- the #63 defect one level out, which is why
   * the base wrapper is guarded against `min-height: 0` above. Lifting its cap means it needs a real
   * number in place of the automatic minimum it just lost.
   *
   * The arithmetic, not taste: two collapsed siblings at 35px each (34px of summary plus their 1px
   * `border-top`, measured) plus the open drawer's own 2.75rem floor is 114px.
   */
  it('floors the lifted wrapper above its own collapsed summaries', () => {
    const rule = desktopRule('.sidebar-drawers.is-open') ?? ''
    const floor = rule.match(/min-height:\s*([\d.]+)rem/)
    expect(floor, 'the lifted wrapper names no floor, so it floors on the open drawer content')
      .not.toBeNull()
    expect(Number(floor![1]) * 16, 'the wrapper can be squeezed until a summary clips')
      .toBeGreaterThanOrEqual(35 * 2 + 44)
  })

  /*
   * The atlas drawer has no wrapper, and `max-height: var(--sidebar-drawer-cap, 46vh)` is what keeps
   * it byte-identical. A grant written on `.sidebar-drawer[open]` alone would reach it and change a
   * column this work never measured.
   */
  it('leaves the unwrapped atlas drawer alone', () => {
    const grants = rules(desktopCss).filter((rule) => rule.selector
      .split(',')
      .some((one) => /\.sidebar-drawer\[open\]$/.test(one.trim())))
    expect(grants.length, 'no grant rule for an open drawer').toBeGreaterThan(0)
    for (const rule of grants) {
      const part = rule.selector.split(',').map((one) => one.trim())
        .find((one) => /\.sidebar-drawer\[open\]$/.test(one))!
      expect(part, 'the grant reaches a drawer outside .sidebar-drawers, which is the atlas')
        .toMatch(/^\.sidebar-drawers > /)
    }
  })

  /*
   * `[open]` and never `:not([open])`. `ownRule()` matches a selector part ending in the one asked
   * for, optionally followed by a pseudo-class -- and `:not([open])` *is* a pseudo-class, so
   * `.sidebar-drawer:not([open])` reads to the helper as `.sidebar-drawer`. Being later in the file
   * it would silently retarget every assertion about the base drawer at the accordion override,
   * which is the `ownRule()` trap AGENTS.md documents. This is the guard for that.
   */
  it('does not retarget the base drawer and directory assertions', () => {
    expect(desktopRule('.sidebar-drawer'), 'the base drawer rule is no longer what ownRule finds')
      .toMatch(/max-height:\s*var\(--sidebar-drawer-cap, 46vh\)/)
    expect(desktopRule('.sidebar-directory'), 'the base directory rule was retargeted')
      .toMatch(/max-height:\s*\d+(?:\.\d+)?vh/)
    expect(css, 'a :not([open]) selector will retarget ownRule() lookups')
      .not.toMatch(/\.sidebar-(?:drawer|directory):not\(\[open\]\)\s*[,{]/)
  })

  /*
   * "Directory closed" used to mean "nothing else is claiming the column". It stopped meaning that
   * once an open drawer could claim it: the feed kept its lifted, content-sized height while the
   * legend beside it was squeezed -- the opposite of what opening the legend asks for.
   */
  it('takes the feed lift away while any region is open', () => {
    const lifted = css.match(/\.map-sidebar:has\(> \.sidebar-directory:not\(\[open\]\)\)[^{]*\{[^}]*\}/)
    expect(lifted, 'no rule lifts the feed cap when the directory is closed').not.toBeNull()
    expect(lifted![0], 'an open drawer no longer takes the feed lift away')
      .toMatch(/:not\(:has\(\.sidebar-drawer\[open\]\)\)/)
    // Same trap as everywhere else: a :where() inside :has() is dropped by forgiving parsing.
    expect(lifted![0]).not.toMatch(/:where\(/)
  })

  /*
   * Nothing in the sheet shrinks, and the grants outrank the rules that say so:
   * `.sidebar-directory[open]` scores (0,2,0) and `.sidebar-drawers > .sidebar-drawer[open]` scores
   * (0,3,0) against `.map-sidebar > *` and `.sidebar-drawers > *` at (0,1,0). So the override has to
   * match on the same selectors -- and live in the LAST narrow block, because the base rules it
   * overrides are declared after the first one.
   */
  it('hands the accordion grants back in the bottom sheet', () => {
    expect(narrowRule('.sidebar-drawer[open]'), 'the open drawer still flexes in the sheet')
      .toMatch(/flex:\s*none/)
    expect(narrowRule('.sidebar-directory[open]'), 'the open directory still flexes in the sheet')
      .toMatch(/flex:\s*none/)
    expect(narrowRule('.sidebar-drawer[open]'), 'the sheet keeps a desktop floor it cannot use')
      .toMatch(/min-height:\s*auto/)

    const override = css.lastIndexOf('.sidebar-drawers > .sidebar-drawer[open] { flex: none')
    expect(override, 'no narrow override for the accordion grants').toBeGreaterThan(-1)
    expect(override, 'the override is not in the last narrow block')
      .toBeGreaterThan(css.lastIndexOf(`@media (max-width: ${SHEET}px)`))
  })
})
