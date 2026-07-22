import { Minus, Square, Copy, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { cn } from '@/lib/utils'

const FRAME_CONTROL_BUTTON_CLASS =
  'flex h-[30px] w-[46px] shrink-0 items-center justify-center rounded-none border-0 bg-transparent p-0 text-text-secondary transition-colors hover:bg-black/[0.08] hover:text-text-primary active:bg-black/[0.12] [&_svg]:h-4 [&_svg]:w-4 [&_svg]:stroke-[2]'

export function WindowFrameControls({ className }: { className?: string }) {
  const [isMaximized, setIsMaximized] = useState(false)

  const updateMaximized = useCallback(async () => {
    try {
      const maximized = await getCurrentWindow().isMaximized()
      setIsMaximized(maximized)
    } catch {
      // Ignore if the window API is unavailable
    }
  }, [])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    const window = getCurrentWindow()
    const listenPromise = window
      .onResized(() => {
        void updateMaximized()
      })
      .then(unlistenFn => {
        unlisten = unlistenFn
      })

    return () => {
      void listenPromise.then(() => unlisten?.())
    }
  }, [updateMaximized])

  const handleMinimize = useCallback(async () => {
    try {
      await getCurrentWindow().minimize()
    } catch {
      // Ignore
    }
  }, [])

  const handleMaximize = useCallback(async () => {
    try {
      if (isMaximized) {
        await getCurrentWindow().unmaximize()
      } else {
        await getCurrentWindow().maximize()
      }
    } catch {
      // Ignore
    }
  }, [isMaximized])

  const handleClose = useCallback(async () => {
    try {
      await invoke('close_main_window_to_tray')
    } catch {
      // Fallback to direct window close if the command is unavailable
      try {
        await getCurrentWindow().close()
      } catch {
        // Ignore
      }
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
        aria-label="最小化"
        title="最小化"
      >
        <Minus className="h-4 w-4" />
      </button>
      <button
        type="button"
        data-testid="window-maximize-button"
        onClick={handleMaximize}
        className={FRAME_CONTROL_BUTTON_CLASS}
        aria-label={isMaximized ? '还原' : '最大化'}
        title={isMaximized ? '还原' : '最大化'}
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
        aria-label="关闭"
        title="关闭"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
