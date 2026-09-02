import { Loader2, Square } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { CompositedSpinner } from '@/components/common/CompositedSpinner'
import {
  getComputerUseStatus,
  stopComputerUseCurrentAction,
  type ComputerUseStatus,
} from '@/desktop/computerUse'
import { useTranslation } from '@/hooks/useTranslation'
import { isElectronRuntime } from '@/lib/runtime-environment'

export function ComputerUseActivityIndicator() {
  const { t } = useTranslation('common')
  const [status, setStatus] = useState<ComputerUseStatus | null>(null)
  const [stopping, setStopping] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setStatus(await getComputerUseStatus())
    } catch (error) {
      console.error('[Wework] Failed to load computer use activity:', error)
    }
  }, [])

  useEffect(() => {
    if (!isElectronRuntime()) return
    const initial = window.setTimeout(() => void refresh(), 0)
    const timer = window.setInterval(() => void refresh(), 1_000)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(timer)
    }
  }, [refresh])

  const stop = useCallback(async () => {
    setStopping(true)
    try {
      setStatus(await stopComputerUseCurrentAction())
    } catch (error) {
      console.error('[Wework] Failed to stop computer use action:', error)
    } finally {
      setStopping(false)
    }
  }, [])

  useLayoutEffect(() => {
    if (!status?.currentTool) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      void stop()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [status?.currentTool, stop])

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
