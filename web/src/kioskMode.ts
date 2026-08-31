/**
 * Kiosk mode: the city map with nothing else on the screen.
 *
 * One button does two things that are usually two buttons — it collapses the sidebar rail and asks
 * the browser for fullscreen — because they are one intent. The case this exists for is a map left
 * up on a wall display all day, where the rail is chrome nobody is reading and the browser's own
 * toolbar is worse.
 *
 * The two halves fail independently, which is the whole reason this module exists. Fullscreen can be
 * unavailable (an `iframe` without `allow="fullscreen"`, iOS Safari on a phone, which has no element
 * fullscreen at all) or refused (the click is not treated as a user gesture), and it can be dropped
 * out from under us at any moment because Escape is wired to it by the browser and cannot be
 * intercepted. Collapsing the rail never fails. So kiosk is *our* state, fullscreen is a best-effort
 * addition to it, and the rules for keeping them in step are pure functions here rather than
 * conditionals buried in an effect — `web/` has no React testing library, so anything left in the
 * component cannot be tested at all.
 */

/** The part of `Document` this module touches, narrowed so the decisions below are testable. */
export interface KioskDocument {
  /** `false` when the document is not permitted to go fullscreen, e.g. a sandboxed frame. */
  fullscreenEnabled?: boolean
  /** The element currently displayed fullscreen, or `null`. */
  fullscreenElement: Element | null
  exitFullscreen?: () => Promise<void>
}

/** The part of `Element` this module touches. */
export interface KioskElement {
  requestFullscreen?: (options?: FullscreenOptions) => Promise<void>
}

/**
 * Whether asking for fullscreen is worth attempting at all.
 *
 * Checked before the call rather than relying on the rejection, because a browser with no element
 * fullscreen leaves `requestFullscreen` undefined and calling it throws a `TypeError` instead of
 * returning a promise to catch.
 */
export function fullscreenAvailable(doc: KioskDocument, element: KioskElement): boolean {
  return doc.fullscreenEnabled !== false
    && typeof element.requestFullscreen === 'function'
    && typeof doc.exitFullscreen === 'function'
}

/**
 * Take browser fullscreen if we can, and report whether we actually got it.
 *
 * The boolean is load-bearing: it is what {@link shouldLeaveKiosk} uses to tell "the viewer pressed
 * Escape and left fullscreen" apart from "we never had fullscreen in the first place". Without it, a
 * `fullscreenchange` fired by anything else on the page would collapse kiosk mode for no reason.
 */
export async function enterKioskFullscreen(doc: KioskDocument, element: KioskElement): Promise<boolean> {
  if (!fullscreenAvailable(doc, element)) return false
  try {
    await element.requestFullscreen!()
    return true
  } catch {
    // A refusal is not an error the viewer needs to see: the rail has still collapsed and the map
    // has still taken the window, which is most of what was asked for.
    return false
  }
}

/** Give fullscreen back, tolerating a browser that has already taken it back itself. */
export async function leaveKioskFullscreen(doc: KioskDocument): Promise<void> {
  if (doc.fullscreenElement == null || typeof doc.exitFullscreen !== 'function') return
  try {
    await doc.exitFullscreen()
  } catch {
    /* Already out, or refused. Either way there is nothing left to undo. */
  }
}

export interface FullscreenChange {
  /** Whether our own request for fullscreen succeeded. */
  tookFullscreen: boolean
  /** `document.fullscreenElement` as it stands after the change. */
  fullscreenElement: Element | null
}

/**
 * Whether a `fullscreenchange` means the viewer left kiosk mode.
 *
 * Escape is the documented way out of fullscreen and the browser handles it before any listener, so
 * this event is the *only* signal that the viewer wants out. Leaving kiosk on at that point strands
 * the rail collapsed in a normal window with no obvious cause.
 *
 * Both guards matter. Without `tookFullscreen`, kiosk entered without fullscreen (refused, or
 * unavailable) would be torn down by an unrelated element exiting fullscreen elsewhere on the page.
 * Without the `null` check, *entering* fullscreen would immediately exit the mode that asked for it.
 */
export function shouldLeaveKiosk({ tookFullscreen, fullscreenElement }: FullscreenChange): boolean {
  return tookFullscreen && fullscreenElement == null
}

export interface KioskChrome {
  /** The button's accessible name, which is also its tooltip. */
  label: string
  /** `aria-pressed`, so the control reads as the toggle it is rather than two different buttons. */
  pressed: boolean
}

/**
 * What the toggle says, as a function of the mode it is in.
 *
 * The name describes the action the press performs, not the state the map is in, which is the
 * convention every fullscreen control uses and the only one that reads correctly mid-press.
 */
export function kioskChrome(active: boolean): KioskChrome {
  return {
    label: active ? 'Exit full screen' : 'Full screen',
    pressed: active,
  }
}
