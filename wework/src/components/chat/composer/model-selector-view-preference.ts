export const MODEL_SELECTOR_VIEW_CHANGED_EVENT = 'wework:model-selector-view-changed'

const MODEL_SELECTOR_VIEW_STORAGE_KEY = 'wework:model-selector-view'

export function readModelSelectorPowerViewPreference(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(MODEL_SELECTOR_VIEW_STORAGE_KEY) === 'power'
  } catch {
    return false
  }
}

export function writeModelSelectorPowerViewPreference(powerViewOpen: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      MODEL_SELECTOR_VIEW_STORAGE_KEY,
      powerViewOpen ? 'power' : 'details'
    )
  } catch {
    // The current in-memory state remains authoritative when storage is unavailable.
  }
  window.dispatchEvent(
    new CustomEvent<boolean>(MODEL_SELECTOR_VIEW_CHANGED_EVENT, { detail: powerViewOpen })
  )
}
