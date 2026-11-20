import { Loader2, Square } from 'lucide-react'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { subscribeIdleResource } from '@wegent/chat-core/async-resource'
import { useWindowEvent } from '@wegent/collaboration/dom-events'
import { createComputerUseStatusStore } from './computerUseStatusStore'
import { CompositedSpinner } from '@/components/common/CompositedSpinner'
import { stopComputerUseCurrentAction } from '@/desktop/computerUse'
import { useTranslation } from '@/hooks/useTranslation'
import { isElectronRuntime } from '@/lib/runtime-environment'

export function ComputerUseActivityIndicator() {
  const { t } = useTranslation('common')
  const store = useMemo(() => createComputerUseStatusStore(), [])
  const status = useSyncExternalStore(
    isElectronRuntime() ? store.subscribe : subscribeIdleResource,
    store.getSnapshot,
    store.getSnapshot
  )
  const [stopping, setStopping] = useState(false)

  const stop = useCallback(async () => {
    setStopping(true)
    try {
      store.update(await stopComputerUseCurrentAction())
    } catch (error) {
      console.error('[Wework] Failed to stop computer use action:', error)
    } finally {
      setStopping(false)
    }
  }, [store])

  useWindowEvent(
    'keydown',
    event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      void stop()
    },
    { enabled: Boolean(status?.currentTool) }
  )

  if (!status?.currentTool) return null

  return (
    <div
      data-embedded-browser-occlusion
      data-testid="computer-use-activity-indicator"
      className="fixed left-1/2 top-12 z-system-popover flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-2xl border border-border bg-popover/95 px-4 py-2.5 text-sm text-text-primary shadow-xl backdrop-blur-md"
    >
      <CompositedSpinner icon={Loader2} className="h-4 w-4 text-primary" />
      <span className="min-w-0 truncate">
        {t('workbench.computer_use_current_action', { action: status.currentTool })}
      </span>
      <button
        type="button"
        data-testid="computer-use-stop-button"
        disabled={stopping}
        onClick={() => void stop()}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-text-primary px-2.5 text-xs font-medium text-background hover:opacity-85 disabled:opacity-50"
      >
        <Square className="h-3 w-3 fill-current" />
        {t('workbench.computer_use_stop')}
      </button>
      <span className="hidden text-xs text-text-muted sm:inline">
        {t('workbench.computer_use_stop_hint')}
      </span>
    </div>
  )
}
