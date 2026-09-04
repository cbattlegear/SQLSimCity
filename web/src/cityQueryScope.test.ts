import { describe, expect, it } from 'vitest'
import { cityQueryScope } from './cityQueryScope'
import type { Evidence } from './contracts'

const evidence: Evidence = { source: 'CatalogSnapshot', status: 'Available', observedAt: null, freshUntil: null, reason: 'Catalog read' }
describe('authoritative city to Query Store scope', () => {
  it('uses only the server mapping, never the visible database basename', () => {
    expect(cityQueryScope({ databaseId: 'endpoint/database/Sales', queryStoreDatabaseId: 'ProvenNamespace', evidence }, 'live'))
      .toEqual({ databaseId: 'ProvenNamespace', directPlanIds: true, reason: null })
  })
  it.each(['endpoint-a/database/Sales', 'endpoint-b/database/Sales'])('does not guess scope from %s on an old connected backend', databaseId => {
    expect(cityQueryScope({ databaseId, evidence }, 'live')).toMatchObject({ databaseId: null, directPlanIds: false })
  })
  it.each(['live', 'archive', 'edge'] as const)('treats explicit null as unproven in %s mode', mode => {
    expect(cityQueryScope({ databaseId: 'Sales', queryStoreDatabaseId: null, evidence }, mode))
      .toMatchObject({ databaseId: null, directPlanIds: false })
  })
  it.each(['archive', 'edge'] as const)('permits only same-ID legacy %s lookup with verified plan membership', mode => {
    expect(cityQueryScope({ databaseId: 'opaque/full/id', evidence }, mode))
      .toEqual({ databaseId: 'opaque/full/id', directPlanIds: false, reason: null })
  })
  it('maps a fixture namespace without treating numeric-looking IDs as connected proof', () => {
    expect(cityQueryScope({ databaseId: 'FixtureSales', queryStoreDatabaseId: 'sales', evidence: { ...evidence, source: 'Fixture' } }, 'live'))
      .toEqual({ databaseId: 'sales', directPlanIds: false, reason: null })
  })
})
