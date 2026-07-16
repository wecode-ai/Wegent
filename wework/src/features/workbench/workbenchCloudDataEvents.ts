import type { RuntimeWorkSearchRequest, RuntimeWorkSearchResponse } from '@/types/api'

export const WORKBENCH_CLOUD_SEARCH_RESULTS_EVENT = 'wework:cloud-search-results'
export const WORKBENCH_CLOUD_ARCHIVES_CHANGED_EVENT = 'wework:cloud-archives-changed'
export const WORKBENCH_MODELS_CHANGED_EVENT = 'wework:workbench-models-changed'

export interface WorkbenchCloudSearchResultsDetail {
  request: RuntimeWorkSearchRequest
  response: RuntimeWorkSearchResponse
}

export function notifyWorkbenchCloudSearchResults(detail: WorkbenchCloudSearchResultsDetail): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<WorkbenchCloudSearchResultsDetail>(WORKBENCH_CLOUD_SEARCH_RESULTS_EVENT, {
      detail,
    })
  )
}

export function notifyWorkbenchCloudArchivesChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(WORKBENCH_CLOUD_ARCHIVES_CHANGED_EVENT))
}

export function notifyWorkbenchModelsChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(WORKBENCH_MODELS_CHANGED_EVENT))
}
