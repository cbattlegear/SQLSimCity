import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { MapViewMode } from './mapStyle'
import { enterKioskFullscreen, kioskChrome, leaveKioskFullscreen, shouldLeaveKiosk } from './kioskMode'

/**
 * Shell primitives for the map-first layout.
 *
 * The map is the page: `MapShell` pins itself to the viewport and hands the remaining space to a
 * single canvas. Everything else — search, lists, legends, status, warnings — either lives in the
 * sidebar or floats over the canvas as an overlay. Nothing scrolls the map off screen.
 */

export type { MapViewMode }

export function MapShell({ sidebar, children, kiosk = false }: {
  sidebar: ReactNode
  children: ReactNode
  /** Kiosk mode: the rail is folded away and the stage takes the whole shell. See `kioskMode.ts`. */
  kiosk?: boolean
}) {
  return (
    <div className={`map-shell${kiosk ? ' is-kiosk' : ''}`}>
      {/*
        * Hidden by the stylesheet rather than unmounted.
        *
        * `display: none` takes the rail out of the tab order and off the accessibility tree, so a
        * collapsed sidebar is genuinely gone for a keyboard or a screen reader. Unmounting would do
        * that too, and would also throw away everything the rail is holding -- the address search
        * term, which drawer is open, the plan finder's results -- and pay to rebuild the whole
        * address book on the way back out. Leaving is meant to be as cheap as entering.
        */}
      <div className={`map-sidebar${kiosk ? ' is-collapsed' : ''}`}>{sidebar}</div>
      <div className="map-stage">{children}</div>
    </div>
  )
}

/**
 * Kiosk mode's state, and the browser fullscreen it tries to bring with it.
 *
 * The pure half is in `kioskMode.ts` and tested there; what is left here is the wiring that cannot
 * be, since `web/` has no React testing library. Fullscreen is best effort — if the browser refuses
 * it, the rail still collapses and the map still takes the window.
 */
export function useKioskMode(): { kiosk: boolean; toggleKiosk: () => void } {
  const [kiosk, setKiosk] = useState(false)
  /** Whether *our* request for fullscreen succeeded, which is what makes an exit ours to follow. */
  const tookFullscreen = useRef(false)

  useEffect(() => {
    if (!kiosk) return
    const onFullscreenChange = () => {
      if (!shouldLeaveKiosk({
        tookFullscreen: tookFullscreen.current,
        fullscreenElement: document.fullscreenElement,
      })) return
      tookFullscreen.current = false
      setKiosk(false)
    }
    /*
     * Escape is handled here only for the case where fullscreen was never granted. With fullscreen
     * the browser consumes Escape itself, before any listener, and `fullscreenchange` above is the
     * signal instead -- so this must not fire then, or a single press would be read twice.
     */
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && document.fullscreenElement == null) setKiosk(false)
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [kiosk])

  // Navigating away mid-kiosk must not leave the browser fullscreen behind on whatever renders next.
  useEffect(() => () => {
    if (tookFullscreen.current) void leaveKioskFullscreen(document)
  }, [])

  const toggleKiosk = useCallback(() => {
    if (kiosk) {
      tookFullscreen.current = false
      setKiosk(false)
      void leaveKioskFullscreen(document)
      return
    }
    setKiosk(true)
    /*
     * Requested from the click, not from an effect. A fullscreen request is only granted while the
     * browser still considers itself inside a user gesture, and a state update defers past that.
     */
    void enterKioskFullscreen(document, document.documentElement).then(took => {
      tookFullscreen.current = took
    })
  }, [kiosk])

  return { kiosk, toggleKiosk }
}

/**
 * The full-screen toggle, pinned above the view switch in the map's bottom-left corner.
 *
 * Drawn as an inline SVG rather than a glyph: the obvious characters for this (`⛶`, `⤢`) are missing
 * from enough system fonts to render as tofu, and the control would then be a blank square.
 */
export function KioskToggle({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  const { label, pressed } = kioskChrome(active)
  return (
    <button
      type="button"
      className={`kiosk-toggle${active ? ' is-active' : ''}`}
      onClick={onToggle}
      aria-pressed={pressed}
      aria-label={label}
      title={label}
    >
      <svg className="kiosk-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        {active ? (
          <path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6" />
        ) : (
          <path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6" />
        )}
      </svg>
    </button>
  )
}

export function SidebarHeader({ brand, title, subtitle, onBack, backLabel }: {
  brand?: ReactNode
  title: string
  subtitle?: ReactNode
  onBack?: () => void
  backLabel?: string
}) {
  return (
    <header className="sidebar-header">
      {brand}
      <div className="sidebar-title">
        {onBack && (
          <button type="button" className="sidebar-back" onClick={onBack} aria-label={backLabel ?? 'Back'}>
            <span aria-hidden="true">←</span>
          </button>
        )}
        <div>
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
      </div>
    </header>
  )
}

export function SearchField({ value, onChange, placeholder, label }: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  label: string
}) {
  const id = useId()
  return (
    <div className="search-field">
      <label className="visually-hidden" htmlFor={id}>{label}</label>
      <span className="search-icon" aria-hidden="true">⌕</span>
      <input
        id={id}
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={event => onChange(event.target.value)}
      />
      {value !== '' && (
        <button type="button" className="search-clear" onClick={() => onChange('')} aria-label="Clear search">
          <span aria-hidden="true">✕</span>
        </button>
      )}
    </div>
  )
}

/**
 * The Map/3D switch, drawn as a labelled preview tile in the bottom-left corner.
 *
 * The tile always previews and names the mode it will switch *to*, which is the convention every
 * web map uses and the only one that reads correctly at a glance.
 */
export function ViewModeTile({ mode, onChange }: {
  mode: MapViewMode
  onChange: (mode: MapViewMode) => void
}) {
  const next: MapViewMode = mode === 'map' ? 'city' : 'map'
  const label = next === 'city' ? '3D' : 'Map'
  return (
    <button
      type="button"
      className={`view-mode-tile is-${next}`}
      onClick={() => onChange(next)}
      aria-label={`Switch to ${next === 'city' ? '3D city' : 'flat map'} view`}
    >
      <span className="view-mode-preview" aria-hidden="true" />
      <span className="view-mode-label">{label}</span>
    </button>
  )
}

export function MapControlCluster({ heading, onZoomIn, onZoomOut, onReset, onRotate }: {
  heading: number
  onZoomIn: () => void
  onZoomOut: () => void
  onReset: () => void
  onRotate?: (direction: -1 | 1) => void
}) {
  return (
    <div className="map-controls">
      <button
        type="button"
        className="map-control compass"
        onClick={onReset}
        aria-label={`Reset view. Camera heading ${Math.round(heading)} degrees`}
      >
        <span className="compass-needle" style={{ transform: `rotate(${-heading}deg)` }} aria-hidden="true">▲</span>
      </button>
      {onRotate && (
        <div className="map-control-pair">
          <button type="button" className="map-control" onClick={() => onRotate(-1)} aria-label="Rotate left">↺</button>
          <button type="button" className="map-control" onClick={() => onRotate(1)} aria-label="Rotate right">↻</button>
        </div>
      )}
      <div className="map-control-pair">
        <button type="button" className="map-control" onClick={onZoomIn} aria-label="Zoom in">+</button>
        <button type="button" className="map-control" onClick={onZoomOut} aria-label="Zoom out">−</button>
      </div>
    </div>
  )
}

export function StatusChip({ degraded, children, title }: {
  degraded: boolean
  children: ReactNode
  title?: string
}) {
  return (
    <div className={`status-chip ${degraded ? 'is-degraded' : ''}`} title={title} aria-label={title}>
      <span className="status-dot" aria-hidden="true" />
      {children}
    </div>
  )
}

/**
 * A dismissible card floating over the bottom of the map.
 *
 * Used for the deployment-security notice and the archive/edge provenance banners. These used to be
 * page-flow blocks; floating them keeps the map whole without hiding them, and each one still
 * defaults to visible so a warning is never suppressed by the layout change.
 */
export function FloatingCard({ tone, title, onDismiss, children }: {
  tone: 'warning' | 'info'
  title: ReactNode
  onDismiss?: () => void
  children?: ReactNode
}) {
  return (
    <section className={`floating-card is-${tone}`} role={tone === 'warning' ? 'note' : undefined}>
      <div className="floating-card-head">
        <strong>{title}</strong>
        {onDismiss && (
          <button type="button" onClick={onDismiss} aria-label={`Dismiss: ${typeof title === 'string' ? title : 'notice'}`}>
            <span aria-hidden="true">✕</span>
          </button>
        )}
      </div>
      {children && <div className="floating-card-body">{children}</div>}
    </section>
  )
}

/** A popover anchored to a control, closed by Escape or a click outside it. */
export function Popover({ open, onClose, children, className }: {
  open: boolean
  onClose: () => void
  children: ReactNode
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [open, onClose])
  if (!open) return null
  return <div className={`popover ${className ?? ''}`} ref={ref}>{children}</div>
}
