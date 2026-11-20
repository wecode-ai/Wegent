import { Minus, Square, Copy, X } from 'lucide-react'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

const FRAME_CONTROL_BUTTON_CLASS =
  'flex h-11 w-[46px] shrink-0 items-center justify-center rounded-none border-0 bg-transparent p-0 text-text-secondary transition-colors hover:bg-muted hover:text-text-primary active:bg-text-primary/10 md:h-[30px] [&_svg]:h-4 [&_svg]:w-4 [&_svg]:stroke-[2]'

const WEWORK_NEUTRAL_FRAME_COLORS = 'wework:hover:bg-black/[0.08] wework:active:bg-black/[0.12]'

export function WindowFrameControls({ className }: { className?: string }) {
  const { t } = useTranslation('common')
  const windowState = useMemo(() => createWindowFrameState(), [])
  const isMaximized = useSyncExternalStore(
    windowState.subscribe,
    windowState.getSnapshot,
    () => false
  )
  const updateMaximized = windowState.refresh

  const handleMinimize = useCallback(async () => {
    try {
      await invokeDesktopHost<void>('window.minimize')
    } catch {
      // Ignore
    }
  }, [])

  const handleMaximize = useCallback(async () => {
    try {
      await invokeDesktopHost<void>('window.toggleMaximize')
      await updateMaximized()
    } catch {
      // Ignore
    }
  }, [updateMaximized])

  const handleClose = useCallback(async () => {
    try {
      await invokeDesktopHost<void>('window.close')
    } catch {
      // Ignore
    }
  }, [])

  return (
    <div
      data-testid="window-frame-controls"
      className={cn(
        'electron-titlebar-interactive-region flex h-full shrink-0 items-center',
        className
      )}
    >
      <button
        type="button"
        data-testid="window-minimize-button"
        onClick={handleMinimize}
        className={cn(FRAME_CONTROL_BUTTON_CLASS, WEWORK_NEUTRAL_FRAME_COLORS)}
        aria-label={t('common.window.minimize')}
        title={t('common.window.minimize')}
      >
        <Minus className="h-4 w-4" />
      </button>
      <button
        type="button"
        data-testid="window-maximize-button"
        onClick={handleMaximize}
        className={cn(FRAME_CONTROL_BUTTON_CLASS, WEWORK_NEUTRAL_FRAME_COLORS)}
        aria-label={isMaximized ? t('common.window.restore') : t('common.window.maximize')}
        title={isMaximized ? t('common.window.restore') : t('common.window.maximize')}
      >
        {isMaximized ? <Copy className="h-4 w-4" /> : <Square className="h-4 w-4" />}
      </button>
      <button
        type="button"
        data-testid="window-close-button"
        onClick={handleClose}
        className={cn(
          FRAME_CONTROL_BUTTON_CLASS,
          'hover:bg-[#e81123] hover:text-white active:bg-[#f1707a] active:text-white'
        )}
        aria-label={t('common.window.close')}
        title={t('common.window.close')}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

function createWindowFrameState() {
  let maximized = false
  let revision = 0
  let frame = 0
  const listeners = new Set<() => void>()
  const refresh = async () => {
    if (!listeners.size) return
    const request = ++revision
    try {
      const state = await invokeDesktopHost<{ maximized: boolean }>('window.getState')
      if (request !== revision || !listeners.size || state.maximized === maximized) return
      maximized = state.maximized
      listeners.forEach(listener => listener())
    } catch {
      // Native window state is unavailable outside a desktop host.
    }
  }
  return {
    refresh,
    getSnapshot: () => maximized,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) {
        frame = requestAnimationFrame(() => void refresh())
        window.addEventListener('resize', refresh)
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          revision++
          cancelAnimationFrame(frame)
          window.removeEventListener('resize', refresh)
        }
      }
    },
  }
}
