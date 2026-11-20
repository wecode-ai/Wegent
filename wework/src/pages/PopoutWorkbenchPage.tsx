import { DesktopWorkbenchMain } from '@/components/layout/DesktopWorkbenchMain'
import type { WorkbenchPaneIdentity } from '@/components/layout/workbenchPaneIdentity'
import { dismissPopoutWindow, openPopoutTaskInMain } from '@/desktop/popoutWindow'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { SystemDragBridge } from '@/features/system-drag/SystemDragBridge'
import { isElectronRuntime } from '@/lib/runtime-environment'
import {
  findRuntimeTask,
  truncateRuntimeTaskTitle,
} from '@/features/workbench/workbenchRuntimeHelpers'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Copy, SquarePen, X } from 'lucide-react'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import './PopoutWorkbenchPage.css'
import { createPopoutWindowSource } from './popoutWindowSource'

export function PopoutWorkbenchPage() {
  const { t } = useTranslation('common')
  const { state, selectProject, selectStandaloneDevice, setWorkbenchError, startNewChat } =
    useWorkbench()
  const activePane = useMemo<WorkbenchPaneIdentity>(
    () => ({
      currentRuntimeTask: state.currentRuntimeTask,
      currentProject: state.currentProject,
      standaloneChatKey: state.standaloneChatKey,
    }),
    [state.currentProject, state.currentRuntimeTask, state.standaloneChatKey]
  )
  const [windowSource] = useState(createPopoutWindowSource)
  const localDeviceRequired = t('workbench.popout_window_local_device_required')
  const subscribeWindow = useCallback(
    (listener: () => void) =>
      windowSource.subscribe(listener, {
        state,
        selectProject,
        selectStandaloneDevice,
        setWorkbenchError,
        localDeviceRequired,
      }),
    [
      windowSource,
      state,
      selectProject,
      selectStandaloneDevice,
      setWorkbenchError,
      localDeviceRequired,
    ]
  )
  const { overlayOpen, ready } = useSyncExternalStore(
    subscribeWindow,
    windowSource.getSnapshot,
    windowSource.getSnapshot
  )
  const expanded = Boolean(state.currentRuntimeTask)
  const mode = expanded ? 'conversation' : overlayOpen ? 'menu' : 'composer'
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

  return (
    <main
      data-testid="popout-workbench-page"
      data-popout-mode={mode}
      className={cn(
        'popout-window relative flex h-full min-h-0 flex-col overflow-hidden rounded-[20px] border border-border/70 bg-background text-text-primary shadow-xl',
        !expanded && 'popout-window-compact'
      )}
    >
      {ready && isElectronRuntime() && <SystemDragBridge />}
      {expanded ? (
        <header
          data-testid="popout-window-header"
          className="relative flex h-11 shrink-0 items-center border-b border-border/40 px-3"
        >
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="popout-window-close-button"
            onClick={closeWindow}
            className="electron-titlebar-interactive-region inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary"
            aria-label={t('workbench.popout_window_close')}
            title={t('workbench.popout_window_close')}
          >
            <X className="h-4 w-4" />
          </ControlButton>
          <div className="electron-titlebar-drag-region h-full min-w-0 flex-1" />
          <div className="pointer-events-none absolute inset-x-14 truncate text-center text-base font-medium text-text-primary">
            {title}
          </div>
          <div className="electron-titlebar-interactive-region flex items-center gap-1">
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="popout-window-new-chat-button"
              onClick={startNewChat}
              className="electron-titlebar-interactive-region inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary"
              aria-label={t('workbench.popout_window_new_chat')}
              title={t('workbench.popout_window_new_chat')}
            >
              <SquarePen className="h-4 w-4" />
            </ControlButton>
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="popout-window-open-in-main-button"
              onClick={() => {
                if (state.currentRuntimeTask) {
                  void openPopoutTaskInMain(state.currentRuntimeTask)
                }
              }}
              className="electron-titlebar-interactive-region inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary"
              aria-label={t('workbench.popout_window_open_in_main')}
              title={t('workbench.popout_window_open_in_main')}
            >
              <Copy className="h-4 w-4" />
            </ControlButton>
          </div>
        </header>
      ) : null}
      <div className="popout-window-content flex min-h-0 flex-1">
        <DesktopWorkbenchMain
          visible
          sidebarCollapsed
          presentation="popout"
          onSidebarCollapsedChange={() => undefined}
          activePane={activePane}
        />
      </div>
    </main>
  )
}
