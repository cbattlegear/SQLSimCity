import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { fetchPlan, fetchQueryFamilies, fetchQueryFamily } from './api'
import { CityPlanSearch } from './cityPlanSearch'
import { CityPlanNavigation } from './cityPlanNavigation'

const api = { fetchPlan, fetchFamily: fetchQueryFamily, fetchFamilies: fetchQueryFamilies }
export function useCityPlans(databaseId: string, metric: string) {
  const finder = useMemo(() => new CityPlanSearch(databaseId, metric, api), [databaseId, metric])
  const navigation = useMemo(() => new CityPlanNavigation(databaseId, api), [databaseId])
  const search = useSyncExternalStore(finder.subscribe, finder.getSnapshot)
  const selection = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot)
  useEffect(() => () => finder.cancel(), [finder])
  useEffect(() => () => navigation.cancel(), [navigation])
  return { finder, navigation, search, selection }
}
