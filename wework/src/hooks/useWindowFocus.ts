import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauriRuntime } from '@/lib/runtime-environment'

export function useWindowFocus(): boolean {
  const [focused, setFocused] = useState(() =>
    typeof document === 'undefined' ? true : document.hasFocus()
  )

  useEffect(() => {
    const handleFocus = () => setFocused(true)
    const handleBlur = () => setFocused(false)
    const listenToBrowserFocus = () => {
      window.addEventListener('focus', handleFocus)
      window.addEventListener('blur', handleBlur)
    }
    const unlistenFromBrowserFocus = () => {
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('blur', handleBlur)
    }

    if (!isTauriRuntime()) {
      listenToBrowserFocus()
      return unlistenFromBrowserFocus
    }

    let disposed = false
    let unlisten: (() => void) | undefined
    let browserFallbackActive = false
    void Promise.resolve()
      .then(async () => {
        const currentWindow = getCurrentWindow()
        if (
          typeof currentWindow?.isFocused !== 'function' ||
          typeof currentWindow?.onFocusChanged !== 'function'
        ) {
          throw new Error('Tauri window focus API is unavailable')
        }
        setFocused(await currentWindow.isFocused())
        unlisten = await currentWindow.onFocusChanged(event => {
          if (!disposed) setFocused(event.payload)
        })
        if (disposed) unlisten()
      })
      .catch(() => {
        if (disposed) return
        browserFallbackActive = true
        listenToBrowserFocus()
      })
    return () => {
      disposed = true
      unlisten?.()
      if (browserFallbackActive) unlistenFromBrowserFocus()
    }
  }, [])

  return focused
}
