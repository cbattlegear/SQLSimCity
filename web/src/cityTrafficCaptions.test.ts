import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('traffic captions match measurement semantics', () => {
  it('does not imply that grey roads only mean no family named their endpoints', () => {
    const viewport = source('DatabaseCityViewport.tsx')
    expect(viewport).not.toMatch(/grey means no captured family named both/)
    expect(viewport).toMatch(/missing runtime coverage or same-window wait allocation/)
  })
  it('distinguishes modelled street placement from whole-family query paths', () => {
    const viewport = source('DatabaseCityViewport.tsx')
    expect(viewport).toMatch(/same disclosed window/)
    expect(viewport).toMatch(/modelled from plan cost shares/)
    expect(viewport).toMatch(/Query paths use whole-family totals/)
  })
  it('does not promise automatic polling for a static fixture city', () => {
    expect(source('DatabaseCityView.tsx')).toContain("page.evidence.source === 'Fixture' ? 'fixture'")
  })
})
