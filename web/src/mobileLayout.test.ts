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
   * A folded tray must never read as all-clear. The chip's own label carries the finding, and a
   * genuine incident opens its panel without being asked.
   */
  it('states the incident finding on the chip and opens a real incident unasked', () => {
    expect(city).toContain('label: incidentSummaryLabel(incidents)')
    expect(city).toContain('alert: incidentDemandsAttention(incidents)')
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

  it('delegates the incident wording to the module that holds the evidence', () => {
    expect(city).toContain('label: incidentSummaryLabel(incidents)')
    expect(city).toContain('tone: incidentSummaryTone(incidents)')
    expect(city).toContain('alert: incidentDemandsAttention(incidents)')
    // No local copy left behind to drift out of step with the projection.
    expect(city).not.toContain('function incidentChipLabel')
  })

  it('lets Escape close the tray outright rather than bouncing back to the alert', () => {
    expect(tray).toMatch(/event\.key === 'Escape'\) setOpenId\(null\)/)
    // Bouncing back would be a no-op whenever the alerting panel is the open one.
    expect(tray).not.toMatch(/Escape'\) setOpenId\(alerting\)/)
  })

  it('orders incidents ahead of the feed, so the self-opening panel is the blocking probe', () => {
    expect(city.indexOf("id: 'incidents'")).toBeLessThan(city.indexOf("id: 'live'"))
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
      .toMatch(/max-height:\s*46vh/)
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
   * The drawer shrinks, but never past the control you open it with.
   *
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
describe('two drawers in one rail share one height budget', () => {
  const cityMarkup = readFileSync(new URL('./DatabaseCityView.tsx', import.meta.url), 'utf8')
  const atlasMarkup = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

  /** The wrapper carries the whole budget, so the drawer region costs what one drawer costs. */
  it('caps the wrapper rather than each drawer', () => {
    const wrapper = desktopRule('.sidebar-drawers')
    expect(wrapper, '.sidebar-drawers has no rule at all').not.toBeNull()
    expect(wrapper, 'the budget is not declared').toMatch(/--sidebar-drawer-budget:\s*46vh/)
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
      .toMatch(/--sidebar-drawer-cap:\s*calc\(var\(--sidebar-drawer-budget\)\s*\/\s*2\)/)
  })

  /**
   * `:has()` widens, it never narrows, and it is written without `:where()`.
   *
   * The default is the half share, which always fits, and the conditional rule relaxes it when only
   * one drawer is open. That direction is the whole safety argument: `:not()` takes a *non-forgiving*
   * selector list, so an engine without `:has()` invalidates and drops the widening rule and lands on
   * the half share.
   *
   * `:where()` inside `:has()` inverts that, dangerously. `:has()` takes a relative selector list, in
   * which a selector may begin with a combinator; `:where()` takes a *complex* selector list, in which
   * it may not. So `:where(> .sidebar-drawer[open] ~ ...)` has its argument dropped by forgiving
   * parsing rather than failing -- Chromium reads the rule back as literally `:not(:has(:where()))`,
   * an empty list matches nothing, `:not()` is therefore always true, and the widened cap applies with
   * both drawers open. Verified by reading `selectorText` off the parsed `CSSStyleSheet`: the
   * `:where()` form matched all three fixtures including both-open, the plain form matched only the
   * two that should widen. In the browser, with the real rule: 0 matches with both drawers open, 1
   * with one open.
   */
  it('widens the cap for a lone drawer instead of narrowing it for two', () => {
    const conditional = rules().find((one) => /^\.sidebar-drawers:not\(:has\(/.test(one.selector))
    expect(conditional, 'no conditional cap rule at all').toBeDefined()
    expect(conditional!.selector, ':where() drops its argument here and inverts the rule')
      .not.toMatch(/:where\(/)
    expect(conditional!.selector)
      .toContain(':not(:has(> .sidebar-drawer[open] ~ .sidebar-drawer[open]))')
    // It relaxes the cap, so an engine that drops the rule keeps the share that always fits.
    expect(conditional!.body)
      .toMatch(/--sidebar-drawer-cap:\s*calc\(var\(--sidebar-drawer-budget\)\s*-\s*2\.5rem\)/)
    // And it comes after the base rule it relaxes, or it would lose on source order.
    expect(css.indexOf('.sidebar-drawers:not('), 'the conditional rule is not in the stylesheet')
      .toBeGreaterThan(css.indexOf('\n.sidebar-drawers {'))
  })

  /** A budget nothing is inside is not a budget. Both drawers have to be in the wrapper. */
  it('renders both city drawers inside the wrapper', () => {
    const open = cityMarkup.indexOf('<div className="sidebar-drawers">')
    expect(open, 'DatabaseCityView renders no .sidebar-drawers wrapper').toBeGreaterThan(-1)
    const close = cityMarkup.indexOf('</div>', open)
    const wrapped = cityMarkup.slice(open, close)
    expect(wrapped, 'the plan finder is outside the budget').toContain('{planFinder}')
    expect(wrapped, 'the legend drawer is outside the budget').toContain('<LegendDrawer')
    // The metric stays outside: it is `flex: none` and shrinking it was never the problem.
    expect(wrapped).not.toContain('sidebar-metric')
  })

  /**
   * The atlas is deliberately not wrapped. It renders one drawer, so it has nothing to divide, and
   * wrapping it would halve a cap that already fits -- a regression dressed as consistency. The
   * `46vh` fallback is what makes leaving it alone a no-op rather than an omission.
   */
  it('leaves the single-drawer atlas column unwrapped', () => {
    expect(atlasMarkup).toContain('className="sidebar-drawer"')
    expect(atlasMarkup, 'the atlas has one drawer and nothing to share a budget with')
      .not.toContain('sidebar-drawers')
    expect((cityMarkup.match(/className="sidebar-drawer"/g) ?? []).length,
      'the city rail no longer has the two drawers this budget exists for').toBe(2)
  })

  /**
   * At <=860px the wrapper stops generating a box, so the sheet is structurally what it was before
   * the wrapper existed rather than re-patched around it.
   *
   * The load-bearing part is subtle: custom properties inherit through `display: contents`, so the
   * drawers below go on inheriting `--sidebar-drawer-cap` -- a 23vh half-share, *tighter* than the
   * 46vh that predates this change. `max-height: none` in the same block is the only thing discarding
   * it. Weaken that override and the sheet's drawers do not return to their old cap, they get a worse
   * one, which is why it is pinned here as well as in the sheet suite above.
   */
  it('dissolves the wrapper in the narrow sheet', () => {
    expect(narrowRule('.sidebar-drawers'), '.sidebar-drawers has no narrow rule')
      .toMatch(/display:\s*contents/)
    expect(narrowRule('.sidebar-drawer'), 'the inherited half-share cap is no longer discarded')
      .toMatch(/max-height:\s*none/)
    // In the last block, or a media query with no extra specificity loses to the base rule.
    const block = css.lastIndexOf(`@media (max-width: ${SHEET}px)`)
    expect(css.slice(block)).toMatch(/\.sidebar-drawers\s*\{[^}]*display:\s*contents/)
    expect(block, 'the wrapper is dissolved before it is defined')
      .toBeGreaterThan(css.indexOf('\n.sidebar-drawers {'))
  })
})
