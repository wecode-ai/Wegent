import { setPopoutWindowMode } from '@/desktop/popoutWindow'
import { isLocalStandaloneDevice } from '@/components/chat/composer/project-work-bar-utils'
import { isOnlineDevice } from '@/lib/device-selection'
import { isWeWorkExecutorVersionCompatible } from '@/lib/device-capabilities'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import { findSelectableProject } from '@/features/workbench/workbenchRuntimeHelpers'
const POPOUT_LAST_PROJECT_STORAGE_KEY = 'wework.popout.lastProjectId.v1'
const POPOUT_OVERLAY_SELECTOR = [
  '[data-testid="quick-phrase-menu"]',
  '[data-testid="project-work-menu"]',
  '[data-testid="project-execution-mode-menu"]',
  '[data-testid="model-selector-menu"]',
  '[data-testid="model-selector-submenu"]',
  '[data-testid="local-skill-autocomplete"]',
  '[data-testid="add-context-menu"]',
  '[data-testid="popout-workspace-menu"]',
].join(',')

function readRememberedProjectId(): number | null {
  try {
    const value = window.localStorage.getItem(POPOUT_LAST_PROJECT_STORAGE_KEY)
    if (!value || value === 'none') return null
    const projectId = Number(value)
    return Number.isSafeInteger(projectId) && projectId > 0 ? projectId : null
  } catch {
    return null
  }
}

function writeRememberedProjectId(projectId: number | null) {
  try {
    window.localStorage.setItem(
      POPOUT_LAST_PROJECT_STORAGE_KEY,
      projectId === null ? 'none' : String(projectId)
    )
  } catch {
    // The in-memory selection remains usable when storage is unavailable.
  }
}

type PopoutInput = Pick<
  WorkbenchContextValue,
  'state' | 'selectProject' | 'selectStandaloneDevice' | 'setWorkbenchError'
> & { localDeviceRequired: string }
/** The popout owns native window geometry, overlay observations and its initial workspace choice. */
export function createPopoutWindowSource() {
  let input: PopoutInput | undefined
  let initialized = false
  let restoring: ((state: PopoutInput['state']) => boolean) | undefined
  let snapshot = { overlayOpen: false, ready: false }
  let persistedProject: number | null | undefined
  let mode: 'conversation' | 'menu' | 'composer' | undefined
  let observer: MutationObserver | undefined
  const listeners = new Set<() => void>()
  const synchronize = () => {
    if (!input || !listeners.size) return
    const { state, selectProject, selectStandaloneDevice, setWorkbenchError } = input
    if (!state.isBootstrapping && !initialized) {
      const remembered = readRememberedProjectId()
      const project =
        remembered === null
          ? null
          : findSelectableProject(state.projects, state.runtimeWork, remembered)
      initialized = true
      if (project) {
        restoring = current => current.currentProject?.id === project.id
        selectProject(project.id, { navigate: false })
      } else {
        const local = state.devices.find(
          device =>
            isLocalStandaloneDevice(device) &&
            isOnlineDevice(device) &&
            isWeWorkExecutorVersionCompatible(device.executor_version)
        )
        if (local) {
          restoring = current => current.standaloneChatKey !== state.standaloneChatKey
          selectStandaloneDevice(local.device_id, { navigate: false })
        } else setWorkbenchError(input.localDeviceRequired)
      }
    }
    if (initialized && !state.isBootstrapping) {
      if (!restoring || restoring(state)) {
        restoring = undefined
        if (!snapshot.ready) {
          snapshot = { ...snapshot, ready: true }
          for (const listener of listeners) listener()
        }
        const projectId = state.currentProject?.id ?? null
        if (persistedProject !== projectId) {
          persistedProject = projectId
          writeRememberedProjectId(projectId)
        }
      }
    }
    const nextMode = state.currentRuntimeTask
      ? 'conversation'
      : snapshot.overlayOpen
        ? 'menu'
        : 'composer'
    if (mode !== nextMode) {
      mode = nextMode
      void setPopoutWindowMode(nextMode)
    }
  }
  const observeOverlay = () => {
    const next = document.querySelector(POPOUT_OVERLAY_SELECTOR) !== null
    if (next !== snapshot.overlayOpen) {
      snapshot = { ...snapshot, overlayOpen: next }
      for (const listener of listeners) listener()
    }
    synchronize()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void, next: PopoutInput) {
      input = next
      listeners.add(listener)
      if (!observer) {
        document.documentElement.classList.add('popout-document')
        observer = new MutationObserver(observeOverlay)
        observer.observe(document.body, { childList: true, subtree: true })
      }
      observeOverlay()
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size) return
          observer?.disconnect()
          observer = undefined
          document.documentElement.classList.remove('popout-document')
          mode = undefined
        })
      }
    },
  }
}
