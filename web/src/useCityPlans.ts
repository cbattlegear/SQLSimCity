import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { fetchPlan, fetchQueryFamilies, fetchQueryFamily } from './api'
import { CityPlanSearch } from './cityPlanSearch'
import { CityPlanNavigation } from './cityPlanNavigation'
import type { CityQueryScope } from './cityQueryScope'

const api = { fetchPlan, fetchFamily: fetchQueryFamily, fetchFamilies: fetchQueryFamilies }
export function useCityPlans(databaseId: string, metric: string, scope: CityQueryScope) {
  const { databaseId: queryStoreDatabaseId, directPlanIds, reason } = scope
  const finder = useMemo(() => new CityPlanSearch(queryStoreDatabaseId, metric, api, { directPlanIds, reason }), [databaseId, queryStoreDatabaseId, directPlanIds, reason, metric])
  const navigation = useMemo(() => new CityPlanNavigation(queryStoreDatabaseId, api, { directPlanIds, reason }), [databaseId, queryStoreDatabaseId, directPlanIds, reason])
  const search = useSyncExternalStore(finder.subscribe, finder.getSnapshot)
  const selection = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot)
  useEffect(() => () => finder.cancel(), [finder])
  useEffect(() => () => navigation.cancel(), [navigation])
  return { finder, navigation, search, selection }
}
