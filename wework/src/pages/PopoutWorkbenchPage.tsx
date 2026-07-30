import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { Copy, SquarePen, X } from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { DesktopWorkbenchMain } from '@/components/layout/DesktopWorkbenchMain'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import {
  findRuntimeTask,
  truncateRuntimeTaskTitle,
} from '@/features/workbench/workbenchRuntimeHelpers'
import {
  dismissPopoutWindow,
  openPopoutTaskInMain,
  setPopoutWindowExpanded,
  setPopoutWindowOverlayActive,
} from '@/tauri/popoutWindow'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { isLocalStandaloneDevice } from '@/components/chat/composer/project-work-bar-utils'
import { isOnlineDevice } from '@/lib/device-selection'
import { isWeWorkExecutorVersionCompatible } from '@/lib/device-capabilities'
import './PopoutWorkbenchPage.css'

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

export function PopoutWorkbenchPage() {
  const { t } = useTranslation('common')
  const { state, selectProject, selectStandaloneDevice, setWorkbenchError, startNewChat } =
    useWorkbench()
  const selectionInitializedRef = useRef(false)
  const restoringProjectIdRef = useRef<number | null | undefined>(undefined)
  const expanded = Boolean(state.currentRuntimeTask)
  const title = useMemo(
    () =>
      truncateRuntimeTaskTitle(
        findRuntimeTask(state.runtimeWork, state.currentRuntimeTask)?.title
      ) ?? t('workbench.popout_window_new_task_title'),
    [state.currentRuntimeTask, state.runtimeWork, t]
  )
  const closeWindow = useCallback(() => {
    void dismissPopoutWindow()
  }, [])
  const startWindowDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !(event.target instanceof Element)) return
    if (
      event.target.closest(
        'button, a, input, textarea, select, [contenteditable="true"], [role="button"], [role="textbox"], [data-popout-no-drag]'
      )
    ) {
      return
    }
    void getCurrentWindow().startDragging()
  }, [])

  useEscapeKey(closeWindow)

  useEffect(() => {
    document.documentElement.classList.add('popout-document')
    return () => document.documentElement.classList.remove('popout-document')
  }, [])

  useEffect(() => {
    if (state.isBootstrapping || selectionInitializedRef.current) return

    const rememberedProjectId = readRememberedProjectId()
    const rememberedProjectExists =
      rememberedProjectId !== null &&
      state.projects.some(project => project.id === rememberedProjectId)
    restoringProjectIdRef.current = rememberedProjectExists ? rememberedProjectId : null
    selectionInitializedRef.current = true

    if (rememberedProjectExists) {
      selectProject(rememberedProjectId)
      return
    }

    const localDevice = state.devices.find(
      device =>
        isLocalStandaloneDevice(device) &&
        isOnlineDevice(device) &&
        isWeWorkExecutorVersionCompatible(device.executor_version)
    )
    if (localDevice) {
      selectStandaloneDevice(localDevice.device_id)
    } else {
      setWorkbenchError(t('workbench.popout_window_local_device_required'))
    }
  }, [
    selectProject,
    selectStandaloneDevice,
    setWorkbenchError,
    state.devices,
    state.isBootstrapping,
    state.projects,
    t,
  ])

  useEffect(() => {
    if (!selectionInitializedRef.current || state.isBootstrapping) return

    const restoringProjectId = restoringProjectIdRef.current
    if (restoringProjectId !== undefined) {
      if ((state.currentProject?.id ?? null) !== restoringProjectId) return
      restoringProjectIdRef.current = undefined
    }
    writeRememberedProjectId(state.currentProject?.id ?? null)
  }, [state.currentProject, state.isBootstrapping])

  useEffect(() => {
    void setPopoutWindowExpanded(expanded)
  }, [expanded])

  useEffect(() => {
    let overlayActive = false
    const syncOverlayState = () => {
      const nextOverlayActive = document.querySelector(POPOUT_OVERLAY_SELECTOR) !== null
      if (nextOverlayActive === overlayActive) return
      overlayActive = nextOverlayActive
      void setPopoutWindowOverlayActive(nextOverlayActive)
    }
    const observer = new MutationObserver(syncOverlayState)
    observer.observe(document.body, { childList: true, subtree: true })
    syncOverlayState()

    return () => {
      observer.disconnect()
      if (overlayActive) {
        void setPopoutWindowOverlayActive(false)
      }
    }
  }, [])

  return (
    <main
      data-testid="popout-workbench-page"
      className={cn(
        'popout-window relative flex h-full min-h-0 flex-col overflow-hidden rounded-[20px] border border-border/70 bg-background text-text-primary shadow-xl',
        !expanded && 'popout-window-collapsed',
        !expanded && 'popout-window-compact-context'
      )}
    >
      {expanded ? (
        <header
          data-testid="popout-window-header"
          data-tauri-drag-region
          className="relative flex h-11 shrink-0 items-center border-b border-border/40 px-3"
        >
          <button
            type="button"
            data-testid="popout-window-close-button"
            onClick={closeWindow}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary"
            aria-label={t('workbench.popout_window_close')}
            title={t('workbench.popout_window_close')}
          >
            <X className="h-4 w-4" />
          </button>
          <div className="pointer-events-none absolute inset-x-14 truncate text-center text-base font-medium text-text-primary">
            {title}
          </div>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              data-testid="popout-window-new-chat-button"
              onClick={startNewChat}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary"
              aria-label={t('workbench.popout_window_new_chat')}
              title={t('workbench.popout_window_new_chat')}
            >
              <SquarePen className="h-4 w-4" />
            </button>
            <button
              type="button"
              data-testid="popout-window-open-in-main-button"
              onClick={() => {
                if (state.currentRuntimeTask) {
                  void openPopoutTaskInMain(state.currentRuntimeTask)
                }
              }}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary"
              aria-label={t('workbench.popout_window_open_in_main')}
              title={t('workbench.popout_window_open_in_main')}
            >
              <Copy className="h-4 w-4" />
            </button>
          </div>
        </header>
      ) : null}
      <div className="popout-window-content flex min-h-0 flex-1" onPointerDown={startWindowDrag}>
        <DesktopWorkbenchMain
          visible
          sidebarCollapsed
          showComposerProjectMenuAction
          onSidebarCollapsedChange={() => undefined}
          activePane={{
            currentRuntimeTask: state.currentRuntimeTask,
            currentProject: state.currentProject,
            standaloneChatKey: state.standaloneChatKey,
          }}
        />
      </div>
    </main>
  )
}
