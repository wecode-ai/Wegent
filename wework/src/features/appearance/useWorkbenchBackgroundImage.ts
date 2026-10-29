import { useCallback, useEffect, useState } from 'react'
import { loadWorkbenchBackgroundImage } from './backgroundImage'

export interface WorkbenchBackgroundImageState {
  url: string | null
  failed: boolean
  reportLoadError: () => void
}

interface LoadedBackgroundImage {
  path: string
  url: string
}

/**
 * Resolves a configured background path to a displayable Blob URL and releases
 * the URL when the path changes or the caller unmounts.
 */
export function useWorkbenchBackgroundImage(path: string | null): WorkbenchBackgroundImageState {
  const [loaded, setLoaded] = useState<LoadedBackgroundImage | null>(null)
  const [failedPath, setFailedPath] = useState<string | null>(null)

  useEffect(() => {
    if (!path) return

    let cancelled = false
    let release: (() => void) | null = null

    loadWorkbenchBackgroundImage(path)
      .then(image => {
        if (cancelled) {
          image?.release()
          return
        }
        release = image?.release ?? null
        setLoaded(image ? { path, url: image.url } : null)
      })
      .catch(() => {
        if (!cancelled) setFailedPath(path)
      })

    return () => {
      cancelled = true
      release?.()
      setLoaded(current => (current?.path === path ? null : current))
      setFailedPath(current => (current === path ? null : current))
    }
  }, [path])

  // A loaded image belongs only to the path it was read from, so changing the
  // configured file never flashes the previous background.
  const resolved = path && loaded?.path === path ? loaded : null
  const failed = Boolean(path && failedPath === path)
  const reportLoadError = useCallback(() => setFailedPath(path), [path])

  return {
    url: failed ? null : (resolved?.url ?? null),
    failed,
    reportLoadError,
  }
}
