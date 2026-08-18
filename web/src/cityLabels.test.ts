import { describe, expect, it } from 'vitest'
import {
  buildingLabelText,
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
