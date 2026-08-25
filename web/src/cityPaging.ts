import type {
  DatabaseCityObjectWaitShare,
  DatabaseCityPage,
  DatabaseCityQueryFamily,
  DatabaseCityRoute,
  DatabaseCitySchema,
  DatabaseCityWaitAttribution,
  QueryAttributionConfidence,
} from './databaseCityContracts'

/**
 * Folds a later bounded object page onto everything already loaded.
 *
 * Object inventory arrives one bounded page at a time, and only some of what a page carries is a
 * statement about the whole database. The rest is a statement about that page, and replacing the
 * previous page wholesale — which is what the view used to do — silently threw those parts away:
 *
 * - `objects` is obviously per-page, and was already being merged.
 * - `routes` is per-page too, and is the one that showed. A database whose co-references all sit
 *   among the first fifty objects returns them on page one and returns *none* on page two, so
 *   appending a page erased every road ribbon on the map.
 * - `schemas` carries the count of that page's objects per schema, not the database's. Summing is
 *   what makes the count the city is laid out from converge on the real one.
 * - `topQueryFamilies` is *not* database-wide, which is the assumption this used to make and the bug
 *   behind "no loaded object named" on plans that plainly touch several tables. A family's object
 *   references are resolved against only the current page's objects, so a reference to a real table
 *   on a different page lands nowhere and drops out of `objectIds`. Different pages therefore resolve
 *   different subsets of the same family, and taking the newest page wholesale left every family
 *   carrying only the last page's handful of ids. It is folded by `familyId` here so a family
 *   accumulates every object any page could resolve for it.
 * - `totalObjects` and `otherWorkload` are database-wide and identical on every page, so the newer
 *   copy is taken as-is.
 *
 * The merge is order-independent and idempotent: folding the same page twice changes nothing, which
 * matters because a retried or duplicated request must not double a schema's count or re-append a
 * merge note to a family's rationale.
 */
export function mergeCityPage(previous: DatabaseCityPage, next: DatabaseCityPage): DatabaseCityPage {
  const objects = new Map(previous.objects.map(object => [object.objectId, object]))
  for (const object of next.objects) objects.set(object.objectId, object)

  const routes = new Map<string, DatabaseCityRoute>(
    previous.routes.map(route => [route.routeId, route]))
  for (const route of next.routes) routes.set(route.routeId, route)

  return {
    ...next,
    schemas: mergeSchemas(previous.schemas, next.schemas, objects.size === previous.objects.length),
    objects: [...objects.values()],
    routes: [...routes.values()],
    topQueryFamilies: mergeQueryFamilies(previous.topQueryFamilies, next.topQueryFamilies),
    // The token always comes from the newest page: it is the cursor's own state.
    nextPageToken: next.nextPageToken,
    totalObjects: next.totalObjects ?? previous.totalObjects,
  }
}

/**
 * Folds each query family's per-page attribution across pages, keyed by `familyId`.
 *
 * Families keep the newest page's ranking order; a family only an earlier page carried is retained
 * and appended after, never dropped. Folding is idempotent because a family folded onto itself
 * unions to the same set and rebuilds its rationale from the newest page's prose rather than from
 * the already-merged copy.
 */
function mergeQueryFamilies(
  previous: readonly DatabaseCityQueryFamily[],
  next: readonly DatabaseCityQueryFamily[],
): DatabaseCityQueryFamily[] {
  const earlierById = new Map(previous.map(family => [family.familyId, family]))
  const seen = new Set<string>()
  const merged: DatabaseCityQueryFamily[] = []
  for (const family of next) {
    seen.add(family.familyId)
    const earlier = earlierById.get(family.familyId)
    merged.push(earlier ? foldFamily(earlier, family) : family)
  }
  for (const family of previous) {
    if (!seen.has(family.familyId)) merged.push(family)
  }
  return merged
}

/**
 * Combines an earlier and a newer resolution of the same family.
 *
 * The counters (`executionCount`, the totals, `waitMillisecondsByCategory`, `queryHash`, `evidence`)
 * are database-wide and identical on every page, so `...next` carries them through untouched. Only
 * the page-relative parts — which objects resolved, the confidence that follows from them, the wait
 * split, and the rationale — are rebuilt from the union.
 */
function foldFamily(
  previous: DatabaseCityQueryFamily,
  next: DatabaseCityQueryFamily,
): DatabaseCityQueryFamily {
  // The union is sound because plan hydration is deterministic: plans are ordered by `planId` with a
  // fixed per-family and per-page budget, so pages differ only in which references were resolvable,
  // never in which plans a family owns. Sorted so the merged order does not depend on page order.
  const objectIds = [...new Set([...previous.objectIds, ...next.objectIds])].sort()
  const namedOffNewestPage = objectIds.some(id => !next.objectIds.includes(id))
  return {
    ...next,
    objectIds,
    confidence: mergedConfidence(objectIds, previous, next),
    waitAttribution: mergeWaitAttribution(
      previous.waitAttribution, next.waitAttribution, next.totalWaitMilliseconds),
    // Keep the newest page's prose but, when an earlier page resolved objects this page could not,
    // add a sentence so the server's "named no object on this page" wording cannot silently
    // contradict a set that now spans several pages. Rebuilt from `next.rationale` every fold, so a
    // repeated page produces the identical string rather than stacking the note.
    rationale: namedOffNewestPage
      ? `${next.rationale} Earlier pages resolved objects this page did not, so the merged set spans more than the newest page named.`
      : next.rationale,
  }
}

/**
 * Recomputes confidence from the merged object set rather than inheriting a page's verdict.
 *
 * A total that belongs to more than one building cannot be confirmed against any single one, so a
 * union past one object is only ever `Probable`. A union of exactly one keeps the confidence of the
 * contribution that actually named that object, and an empty union is `Unknown` — no object carries
 * the total at all.
 */
function mergedConfidence(
  objectIds: readonly string[],
  previous: DatabaseCityQueryFamily,
  next: DatabaseCityQueryFamily,
): QueryAttributionConfidence {
  if (objectIds.length === 0) return 'Unknown'
  if (objectIds.length > 1) return 'Probable'
  const only = objectIds[0]
  if (next.objectIds.includes(only)) return next.confidence
  return previous.confidence
}

/**
 * Unions two pages' wait splits for one family and restores the contract's sum invariant.
 *
 * `DatabaseCityWaitAttribution` promises the per-object shares plus `unattributedWaitMilliseconds`
 * sum to exactly `totalWaitMilliseconds`. Unioning shares from two pages would break that unless the
 * unattributed remainder is recomputed, so it is rebuilt with `BigInt` from the family total the
 * merge is keeping. A share string that will not parse is a malformed contribution we cannot sum
 * safely, so the newest contribution is taken untouched rather than emitting a wrong remainder.
 *
 * The shares of two pages should never overtop the family total — each page apportions that one
 * total across the objects it could place and leaves the rest unattributed, so shares for distinct
 * objects are disjoint slices of the same whole. If they do overtop it, the inputs disagree about
 * what the family measured and there is no honest remainder to publish, so the newest contribution
 * is taken whole rather than reporting a negative unattributed figure that the contract forbids.
 */
function mergeWaitAttribution(
  previous: DatabaseCityWaitAttribution | null | undefined,
  next: DatabaseCityWaitAttribution | null | undefined,
  totalWaitMilliseconds: string,
): DatabaseCityWaitAttribution | null | undefined {
  if (previous === null || previous === undefined) return next
  if (next === null || next === undefined) return previous

  const shares = new Map<string, DatabaseCityObjectWaitShare>()
  for (const share of previous.objects) shares.set(share.objectId, share)
  for (const share of next.objects) shares.set(share.objectId, share)
  const unioned = [...shares.values()]

  let total: bigint
  let sum = 0n
  try {
    total = BigInt(totalWaitMilliseconds)
    for (const share of unioned) sum += BigInt(share.waitMilliseconds)
  } catch {
    return next
  }
  if (sum > total) return next

  return {
    objects: unioned,
    unattributedWaitMilliseconds: String(total - sum),
    plansRead: Math.max(previous.plansRead, next.plansRead),
    rationale: next.rationale,
  }
}

/**
 * Adds a page's per-schema counts to the running totals.
 *
 * `repeated` guards the idempotence promise: if the incoming page contributed no object that was
 * not already held, it is the same page arriving twice and its counts are already included.
 */
function mergeSchemas(
  previous: readonly DatabaseCitySchema[],
  next: readonly DatabaseCitySchema[],
  repeated: boolean,
): DatabaseCitySchema[] {
  const merged = new Map(previous.map(schema => [schema.schemaId, schema]))
  for (const schema of next) {
    const existing = merged.get(schema.schemaId)
    if (!existing) {
      merged.set(schema.schemaId, schema)
      continue
    }
    if (repeated) continue
    merged.set(schema.schemaId, {
      ...existing,
      objectCount: String((parseCount(existing.objectCount) ?? 0) + (parseCount(schema.objectCount) ?? 0)),
    })
  }
  return [...merged.values()].sort((left, right) =>
    left.neighborhoodOrdinal - right.neighborhoodOrdinal ||
    (left.schemaId < right.schemaId ? -1 : left.schemaId > right.schemaId ? 1 : 0))
}

/** Counts arrive as decimal strings because they can exceed `Number.MAX_SAFE_INTEGER`. */
function parseCount(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}
