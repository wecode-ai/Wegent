import { useLayoutEffect, useRef } from 'react'
import { isElectronRuntime } from '@/lib/runtime-environment'

interface WeworkDshExtensionFrameHost {
  show(container: HTMLElement): void
  hide(container: HTMLElement): void
}

declare global {
  interface Window {
    __WEWORK_DSH_EXTENSION_FRAME_HOST__?: WeworkDshExtensionFrameHost
  }
}

export function CoreDshExtensionRuntime() {
  const frameRef = useRef<HTMLIFrameElement>(null)

  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!frame || !isElectronRuntime()) return
    let activeContainer: HTMLElement | null = null
    let resizeObserver: ResizeObserver | null = null

    const hideFrame = () => {
      frame.style.pointerEvents = 'none'
      frame.style.visibility = 'hidden'
      frame.style.left = '-10000px'
      frame.style.top = '-10000px'
      frame.style.width = '1px'
      frame.style.height = '1px'
      frame.setAttribute('aria-hidden', 'true')
    }
    const syncBounds = () => {
      if (!activeContainer?.isConnected) {
        activeContainer = null
        hideFrame()
        return
      }
      const rect = activeContainer.getBoundingClientRect()
      Object.assign(frame.style, {
        height: `${Math.max(0, rect.height)}px`,
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${Math.max(0, rect.width)}px`,
      })
    }
    const host: WeworkDshExtensionFrameHost = {
      show(container) {
        activeContainer = container
        resizeObserver?.disconnect()
        resizeObserver = new ResizeObserver(syncBounds)
        resizeObserver.observe(container)
        syncBounds()
        frame.style.pointerEvents = 'auto'
        frame.style.visibility = 'visible'
        frame.removeAttribute('aria-hidden')
      },
      hide(container) {
        if (activeContainer !== container) return
        resizeObserver?.disconnect()
        resizeObserver = null
        activeContainer = null
        hideFrame()
      },
    }
    window.__WEWORK_DSH_EXTENSION_FRAME_HOST__ = host
    window.addEventListener('resize', syncBounds)
    window.addEventListener('scroll', syncBounds, true)
    hideFrame()
    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', syncBounds)
      window.removeEventListener('scroll', syncBounds, true)
      if (window.__WEWORK_DSH_EXTENSION_FRAME_HOST__ === host) {
        delete window.__WEWORK_DSH_EXTENSION_FRAME_HOST__
      }
    }
  }, [])

  if (!isElectronRuntime()) return null

  return (
    <iframe
      ref={frameRef}
      src="/"
      title="Core DSH extension runtime"
      aria-hidden="true"
      tabIndex={-1}
      data-testid="core-dsh-extension-runtime"
      className="pointer-events-none fixed z-[10] h-px w-px border-0"
    />
  )
}
