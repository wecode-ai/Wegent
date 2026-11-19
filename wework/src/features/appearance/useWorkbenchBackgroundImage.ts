import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { loadWorkbenchBackgroundImage } from './backgroundImage'

export interface WorkbenchBackgroundImageState {
  url: string | null
  failed: boolean
  reportLoadError: () => void
}

/** Each configured path owns its Blob URL, including responses arriving after unmount. */
export function useWorkbenchBackgroundImage(path: string | null): WorkbenchBackgroundImageState {
  const resource = useMemo(
    () =>
      path
        ? createAsyncResource(path, () => loadWorkbenchBackgroundImage(path), {
            release: image => image?.release(),
          })
        : null,
    [path]
  )
  const snapshot = useSyncExternalStore(
    resource?.subscribe ?? subscribeIdleResource,
    resource?.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )
  const [displayError, setDisplayError] = useState({ path, failed: false })
  if (displayError.path !== path) setDisplayError({ path, failed: false })
  const reportLoadError = useCallback(() => {
    if (path) setDisplayError(current => (current.path === path ? { path, failed: true } : current))
  }, [path])
  const failed = (displayError.path === path && displayError.failed) || snapshot.status === 'error'
  return { url: failed ? null : (snapshot.data?.url ?? null), failed, reportLoadError }
}
