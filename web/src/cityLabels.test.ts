import { describe, expect, it } from 'vitest'
import {
  buildingLabelText,
  createCityLabels,
  elideMiddle,
  labelAnchor,
  labelWorldWidth,
  LABEL_MAX_CHARS,
  LABEL_WORLD_HEIGHT,
} from './cityLabels'

describe('buildingLabelText', () => {
  it('qualifies a building label with its schema, which is what the district tint used to say', () => {
    expect(buildingLabelText('Sales', 'Orders')).toBe('Sales.Orders')
  })

  it('falls back to the bare name when there is no schema to qualify with', () => {
    expect(buildingLabelText('', 'Orders')).toBe('Orders')
  })

  it('elides a qualified name that would rasterize into an unreadably wide plate', () => {
    const label = buildingLabelText('WarehouseStaging', 'FactInventorySnapshotDailyRollup')
    expect([...label]).toHaveLength(LABEL_MAX_CHARS)
    expect(label).toContain('…')
  })
})

describe('elideMiddle', () => {
  it('leaves a name that already fits exactly untouched', () => {
    const text = 'a'.repeat(LABEL_MAX_CHARS)
    expect(elideMiddle(text, LABEL_MAX_CHARS)).toBe(text)
  })

  it('keeps the tail, because that is often the only thing distinguishing two names', () => {
    const archive = elideMiddle('dbo.orders_2024_q3_archive', 20)
    const current = elideMiddle('dbo.orders_2024_q3_current', 20)
    expect(archive).not.toBe(current)
    expect(archive.endsWith('archive')).toBe(true)
    expect(current.endsWith('current')).toBe(true)
  })

  it('never returns more characters than asked for', () => {
    for (const limit of [2, 3, 7, 12, 31]) {
      expect([...elideMiddle('x'.repeat(100), limit)]).toHaveLength(limit)
    }
  })

  it('degenerates safely rather than throwing at tiny limits', () => {
    expect(elideMiddle('abcdef', 1)).toBe('…')
    expect(elideMiddle('abcdef', 0)).toBe('')
    expect(elideMiddle('abcdef', -4)).toBe('')
  })

  it('counts astral characters as single glyphs so an emoji name is not cut in half', () => {
    const cut = elideMiddle('🏙🏙🏙🏙🏙🏙', 3)
    expect([...cut]).toHaveLength(3)
    expect(cut).not.toContain('\ufffd')
  })
})

describe('labelWorldWidth', () => {
  it('preserves the rasterized aspect ratio at the fixed world height', () => {
    expect(labelWorldWidth(400, 80, 4)).toBeCloseTo(20)
  })

  it('defaults to the shared label height', () => {
    expect(labelWorldWidth(160, 80)).toBeCloseTo(LABEL_WORLD_HEIGHT * 2)
  })

  it('claims no width for a degenerate raster instead of producing NaN or Infinity', () => {
    expect(labelWorldWidth(0, 80)).toBe(0)
    expect(labelWorldWidth(400, 0)).toBe(0)
    expect(labelWorldWidth(Number.NaN, 80)).toBe(0)
  })
})

describe('createCityLabels', () => {
  /**
   * Minimal 2D canvas stub. Vitest runs in a node environment with no DOM, but the sprite decisions
   * worth locking down — depth behaviour, render order, world size — are settled at sprite creation
   * and need no GPU to observe.
   */
  function stubCanvas() {
    const context = {
      font: '',
      textAlign: '',
      textBaseline: '',
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      measureText: (text: string) => ({ width: text.length * 30 }),
      beginPath: () => {},
      moveTo: () => {},
      arcTo: () => {},
      closePath: () => {},
      fill: () => {},
      stroke: () => {},
      fillText: () => {},
    }
    const previous = globalThis.document
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElement: () => ({
          width: 0,
          height: 0,
          getContext: (kind: string) => (kind === '2d' ? context : null),
        }),
      },
    })
    return () => {
      if (previous === undefined) delete (globalThis as { document?: unknown }).document
      else Object.defineProperty(globalThis, 'document', { configurable: true, value: previous })
    }
  }

  it('draws labels without depth testing, so a building never hides another building\'s name', () => {
    const restore = stubCanvas()
    try {
      const labels = createCityLabels()
      const sprite = labels.make('dbo.Customer')
      expect(sprite).not.toBeNull()
      // The whole point: identity survives every camera angle.
      expect(sprite!.material.depthTest).toBe(false)
      // Still never writes depth, so a label cannot occlude the geometry it floats over.
      expect(sprite!.material.depthWrite).toBe(false)
      // Above the road (1) and halo (2) render orders used by the scene.
      expect(sprite!.renderOrder).toBeGreaterThan(2)
      labels.dispose()
    } finally {
      restore()
    }
  })

  it('sizes a sprite to the shared world height, preserving its rasterized aspect', () => {
    const restore = stubCanvas()
    try {
      const labels = createCityLabels()
      const sprite = labels.make('dbo.Customer')!
      expect(sprite.scale.y).toBeCloseTo(LABEL_WORLD_HEIGHT)
      expect(sprite.scale.x).toBeGreaterThan(0)
      labels.dispose()
    } finally {
      restore()
    }
  })

  it('reuses one material per distinct string, so a rebuild does not churn textures', () => {
    const restore = stubCanvas()
    try {
      const labels = createCityLabels()
      const first = labels.make('dbo.Customer')!
      const second = labels.make('dbo.Customer')!
      const other = labels.make('dbo.OrderHeader')!
      expect(second.material).toBe(first.material)
      expect(other.material).not.toBe(first.material)
      labels.dispose()
    } finally {
      restore()
    }
  })
})

describe('labelAnchor', () => {
  it('pushes the label off the footprint toward the street the building fronts', () => {
    expect(labelAnchor(10, 10, 10, 30, 5)).toEqual({ x: 10, z: 15 })
    expect(labelAnchor(10, 10, 30, 10, 5)).toEqual({ x: 15, z: 10 })
  })

  it('moves exactly the requested distance along a diagonal frontage', () => {
    const anchor = labelAnchor(0, 0, 30, 40, 10)
    expect(anchor.x).toBeCloseTo(6)
    expect(anchor.z).toBeCloseTo(8)
    expect(Math.hypot(anchor.x, anchor.z)).toBeCloseTo(10)
  })

  it('stays at the centre when the access point coincides, rather than dividing by zero', () => {
    expect(labelAnchor(12, -4, 12, -4, 6)).toEqual({ x: 12, z: -4 })
  })
})
