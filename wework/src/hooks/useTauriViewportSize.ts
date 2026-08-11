import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect, useState } from 'react'

interface ViewportSize {
  width: number
  height: number
}

export function useTauriViewportSize(isTauri: boolean): ViewportSize | null {
  const [viewportSize, setViewportSize] = useState<ViewportSize | null>(() => {
    if (!isTauri || window.innerWidth <= 0 || window.innerHeight <= 0) return null
    return { width: window.innerWidth, height: window.innerHeight }
  })

  useEffect(() => {
    if (!isTauri) return undefined

    const appWindow = getCurrentWindow()
    let disposed = false
    let latestUpdate = 0
    let unlistenResize: (() => void) | undefined
    let unlistenScale: (() => void) | undefined

    const applyPhysicalSize = async (
      physicalSize:
        | Awaited<ReturnType<typeof appWindow.innerSize>>
        | ReturnType<typeof appWindow.innerSize>,
      scaleFactor: number | ReturnType<typeof appWindow.scaleFactor>
    ) => {
      const update = ++latestUpdate
      const [resolvedSize, resolvedScaleFactor] = await Promise.all([physicalSize, scaleFactor])
      if (disposed || update !== latestUpdate) return

      const logicalSize = resolvedSize.toLogical(resolvedScaleFactor)
      if (logicalSize.width <= 0 || logicalSize.height <= 0) return
      setViewportSize(current =>
        current?.width === logicalSize.width && current.height === logicalSize.height
          ? current
          : { width: logicalSize.width, height: logicalSize.height }
      )
    }

    void Promise.all([
      appWindow.onResized(({ payload }) => {
        void applyPhysicalSize(payload, appWindow.scaleFactor()).catch(error => {
          console.error('[Wework] Failed to update the Tauri viewport size:', error)
        })
      }),
      appWindow.onScaleChanged(({ payload }) => {
        void applyPhysicalSize(payload.size, payload.scaleFactor)
      }),
    ])
      .then(([unlistenResizeFn, unlistenScaleFn]) => {
        if (disposed) {
          unlistenResizeFn()
          unlistenScaleFn()
          return
        }
        unlistenResize = unlistenResizeFn
        unlistenScale = unlistenScaleFn
        void applyPhysicalSize(appWindow.innerSize(), appWindow.scaleFactor()).catch(error => {
          console.error('[Wework] Failed to read the Tauri viewport size:', error)
        })
      })
      .catch(error => {
        console.error('[Wework] Failed to listen for Tauri viewport changes:', error)
      })

    return () => {
      disposed = true
      unlistenResize?.()
      unlistenScale?.()
    }
  }, [isTauri])

  return viewportSize
}
