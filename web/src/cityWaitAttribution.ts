import type { DatabaseCityQueryFamily, DatabaseCityWaitAttribution } from './databaseCityContracts'
import {
  familyTrafficMeasurement, trafficBasis, trafficCoverageNote, trafficInteger, type TrafficBasis,
} from './cityTrafficWindow'

/**
 * Collecting the wait time each building was apportioned, across every ranked query family.
 *
 * The measurement being spread is Query Store's: one wait total per query family. The spreading is
 * the optimizer's estimated cost share for the objects that family's plans read. So a building's
 * figure here is **measured milliseconds multiplied by a modelled ratio** — real time, placed by an
 * estimate. That is a different claim from the strict attributed exposure a building already
 * carries, which is only ever assigned when a family named that object and nothing else, and it must
 * never be presented as though it were the same thing.
 *
 * What this does inherit from the strict rule is the refusal that makes it safe: the collector only
 * publishes shares for objects the page actually draws. Cost a plan spent on an off-page table,
 * another database, or on no object at all stays in the family's unattributed remainder and never
 * lands on a building here. Summing every building's attributed wait therefore gives less than the
 * workload's total wait, and the difference is reported rather than hidden.
 */

export interface BuildingWait {
  readonly objectId: string
  /** Apportioned wait milliseconds, summed across families. Exact. */
  readonly milliseconds: bigint
  /** Families that contributed, for drill-down. */
  readonly familyIds: readonly string[]
}

export interface WaitAttributionTotals {
  readonly byObject: ReadonlyMap<string, BuildingWait>
  /** Wait milliseconds no drawn building was given, summed across families. */
  readonly unattributed: bigint
  /** Total measured wait across the families considered. */
  readonly measured: bigint
  /** Families that carried an apportionment at all. */
  readonly apportioned: number
  readonly basis: TrafficBasis
  /** These families have no usable wait measurement; they are excluded, not counted as zero. */
  readonly unknownFamilyIds: readonly string[]
  readonly note: string
}

function parse(value: string | null | undefined): bigint {
  return trafficInteger(value) ?? 0n
}

/** The attribution a family carries, or null when it carries none. */
export function familyAttribution(
  family: DatabaseCityQueryFamily,
  basis: TrafficBasis = trafficBasis([family]),
): DatabaseCityWaitAttribution | null {
  const attribution = familyTrafficMeasurement(family, basis).attribution
  if (!attribution) return null
  return attribution.objects.length === 0 ? null : attribution
}

/** Apportioned wait milliseconds per object for one family. Empty when nothing was apportioned. */
export function familyWaitByObject(
  family: DatabaseCityQueryFamily,
  basis: TrafficBasis = trafficBasis([family]),
): Map<string, bigint> {
  const waits = new Map<string, bigint>()
  const attribution = familyAttribution(family, basis)
  if (!attribution) return waits
  for (const entry of attribution.objects) {
    const milliseconds = parse(entry.waitMilliseconds)
    if (milliseconds <= 0n) continue
    waits.set(entry.objectId, (waits.get(entry.objectId) ?? 0n) + milliseconds)
  }
  return waits
}

/** Historical plan shares fix visit order. Recent runtime weights must never move the geography. */
export function familyCostShares(family: DatabaseCityQueryFamily): Map<string, number> {
  const shares = new Map<string, number>()
  const attribution = family.waitAttribution
  if (!attribution) return shares
  for (const entry of attribution.objects) {
    if (!Number.isFinite(entry.estimatedCostShare)) continue
    shares.set(entry.objectId, (shares.get(entry.objectId) ?? 0) + entry.estimatedCostShare)
  }
  return shares
}

/**
 * Folds every family's apportionment into one figure per building, keeping the unapportioned
 * remainder alongside it so the page can say how much of the workload's waiting it is not showing.
 */
export function attributedWaits(
  families: readonly DatabaseCityQueryFamily[],
  drawnObjectIds?: ReadonlySet<string>,
  basis: TrafficBasis = trafficBasis(families),
): WaitAttributionTotals {
  const byObject = new Map<string, { milliseconds: bigint; familyIds: string[] }>()
  let unattributed = 0n
  let measured = 0n
  let apportioned = 0
  const unknownFamilyIds: string[] = []

  for (const family of families) {
    const sample = familyTrafficMeasurement(family, basis)
    if (sample.waitMilliseconds === null) {
      unknownFamilyIds.push(family.familyId)
      continue
    }
    measured += sample.waitMilliseconds
    const attribution = sample.attribution
    if (!attribution) {
      unattributed += sample.waitMilliseconds
      continue
    }

    unattributed += parse(attribution.unattributedWaitMilliseconds)
    if (attribution.objects.length > 0) apportioned += 1

    for (const entry of attribution.objects) {
      const milliseconds = parse(entry.waitMilliseconds)
      if (milliseconds <= 0n) continue
      // A building the page is not drawing cannot show its share, and quietly dropping it would make
      // the parts stop adding up to the measurement they came from.
      if (drawnObjectIds && !drawnObjectIds.has(entry.objectId)) {
        unattributed += milliseconds
        continue
      }
      const existing = byObject.get(entry.objectId)
      if (existing) {
        existing.milliseconds += milliseconds
        existing.familyIds.push(family.familyId)
      } else {
        byObject.set(entry.objectId, { milliseconds, familyIds: [family.familyId] })
      }
    }
  }

  const totals = new Map<string, BuildingWait>()
  for (const [objectId, entry] of byObject) {
    totals.set(objectId, { objectId, milliseconds: entry.milliseconds, familyIds: entry.familyIds })
  }

  return {
    byObject: totals,
    unattributed,
    measured,
    apportioned,
    basis,
    unknownFamilyIds,
    note: `${trafficCoverageNote(families, basis)} ${describe(totals.size, apportioned, families.length, unattributed, measured)}`
      + (unknownFamilyIds.length > 0 ? ' Totals describe only measured contributors; unknown waits are not zero.' : ''),
  }
}

function describe(
  buildings: number,
  apportioned: number,
  families: number,
  unattributed: bigint,
  measured: bigint,
): string {
  if (families === 0) return 'No ranked query family was captured for this page, so no wait time is placed.'
  if (apportioned === 0) {
    return 'No usable wait split in this window was supplied for these families, so their measured wait time is not placed on any building.'
  }
  const share = measured > 0n ? Number((unattributed * 1000n) / measured) / 10 : 0
  return (
    `${apportioned.toLocaleString()} of ${families.toLocaleString()} ranked families carry an estimated cost split, ` +
    `placing measured wait time on ${buildings.toLocaleString()} building(s). ` +
    `${share.toFixed(1)}% of the captured wait stays unplaced: cost the plans spent on no object, or on objects this page does not draw. ` +
    'The milliseconds are measured; the split between buildings is the optimizer\u2019s cost estimate, not a measurement of where the waiting happened.'
  )
}
