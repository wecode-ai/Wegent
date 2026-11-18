import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { getDiagramResource, getIdleDiagramSnapshot, type DiagramRequest } from './diagramArtifact'

const subscribeIdle = () => () => {}

export function useDiagramArtifact(request: DiagramRequest, enabled: boolean) {
  const { code, kind, theme, plantumlServerUrl } = request
  const resource = useMemo(
    () =>
      enabled && typeof document !== 'undefined'
        ? getDiagramResource(document, { code, kind, theme, plantumlServerUrl })
        : null,
    [enabled, code, kind, theme, plantumlServerUrl]
  )
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!resource) return subscribeIdle()
      const unsubscribe = resource.subscribe(listener)
      resource.prepare()
      return unsubscribe
    },
    [resource]
  )
  const snapshot = useSyncExternalStore(
    subscribe,
    resource?.getSnapshot ?? getIdleDiagramSnapshot,
    getIdleDiagramSnapshot
  )
  const retry = useCallback(() => resource?.prepare(), [resource])
  return { ...snapshot, retry }
}
