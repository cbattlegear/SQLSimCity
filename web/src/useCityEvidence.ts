import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { fetchDatabaseCity } from './api'
import { CityEvidenceController, cityEvidenceDisclosure, type CitySourceMode } from './cityEvidence'

function nextPaint(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

export function useCityEvidence(databaseId: string, metric: string, sourceMode: CitySourceMode) {
  const controller = useMemo(
    () => new CityEvidenceController(databaseId, metric, sourceMode, fetchDatabaseCity, nextPaint, () => document.hidden),
    [databaseId, metric, sourceMode],
  )
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  useEffect(() => {
    controller.start()
    return () => controller.dispose()
  }, [controller])
  return { ...state, disclosure: cityEvidenceDisclosure(state, sourceMode), refresh: controller.refresh, loadMore: controller.loadMore }
}
