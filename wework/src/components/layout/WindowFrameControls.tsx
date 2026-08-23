import { Minus, Square, Copy, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { useTranslation } from '@/hooks/useTranslation'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { cn } from '@/lib/utils'

const FRAME_CONTROL_BUTTON_CLASS =
  'flex h-[30px] w-[46px] shrink-0 items-center justify-center rounded-none border-0 bg-transparent p-0 text-text-secondary transition-colors hover:bg-black/[0.08] hover:text-text-primary active:bg-black/[0.12] [&_svg]:h-4 [&_svg]:w-4 [&_svg]:stroke-[2]'

export function WindowFrameControls({ className }: { className?: string }) {
  const { t } = useTranslation('common')
  const [isMaximized, setIsMaximized] = useState(false)

  const updateMaximized = useCallback(async () => {
    try {
      if (isElectronRuntime()) {
        const state = await invokeDesktopHost<{ maximized: boolean }>('window.getState')
        setIsMaximized(state.maximized)
      } else {
        setIsMaximized(await getCurrentWindow().isMaximized())
      }
    } catch {
      // Ignore if the window API is unavailable
    }
  }, [])

  useEffect(() => {
    if (isElectronRuntime()) {
      const handleResize = () => void updateMaximized()
      const initialUpdateFrame = requestAnimationFrame(() => void updateMaximized())
      window.addEventListener('resize', handleResize)
      return () => {
        cancelAnimationFrame(initialUpdateFrame)
        window.removeEventListener('resize', handleResize)
      }
    }
    let unlisten: (() => void) | undefined
    const targetWindow = getCurrentWindow()
    const listenPromise = targetWindow
      .onResized(() => {
        void updateMaximized()
      })
      .then(unlistenFn => {
        unlisten = unlistenFn
        void updateMaximized()
      })

    return () => {
      void listenPromise.then(() => unlisten?.())
    }
  }, [updateMaximized])

  const handleMinimize = useCallback(async () => {
    try {
      if (isElectronRuntime()) await invokeDesktopHost<void>('window.minimize')
      else await getCurrentWindow().minimize()
    } catch {
      // Ignore
    }
  }, [])

  const handleMaximize = useCallback(async () => {
    try {
      if (isElectronRuntime()) {
        await invokeDesktopHost<void>('window.toggleMaximize')
        await updateMaximized()
      } else if (isMaximized) {
        await getCurrentWindow().unmaximize()
      } else {
        await getCurrentWindow().maximize()
      }
    } catch {
      // Ignore
    }
  }, [isMaximized, updateMaximized])

  const handleClose = useCallback(async () => {
    try {
      if (isElectronRuntime()) await invokeDesktopHost<void>('window.close')
      else await getCurrentWindow().close()
    } catch {
      // Ignore
    }
  }, [])

  return (
    <div
      data-testid="window-frame-controls"
      data-tauri-drag-region={false}
      className={cn('flex h-full shrink-0 items-center', className)}
    >
      <button
        type="button"
        data-testid="window-minimize-button"
        onClick={handleMinimize}
        className={FRAME_CONTROL_BUTTON_CLASS}
        aria-label={t('window.minimize')}
        title={t('window.minimize')}
      >
        <Minus className="h-4 w-4" />
      </button>
      <button
        type="button"
        data-testid="window-maximize-button"
        onClick={handleMaximize}
        className={FRAME_CONTROL_BUTTON_CLASS}
        aria-label={isMaximized ? t('window.restore') : t('window.maximize')}
        title={isMaximized ? t('window.restore') : t('window.maximize')}
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
        aria-label={t('window.close')}
        title={t('window.close')}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
