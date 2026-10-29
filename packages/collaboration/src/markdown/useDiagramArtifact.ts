import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
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
  const snapshot = useSyncExternalStore(
    resource?.subscribe ?? subscribeIdle,
    resource?.getSnapshot ?? getIdleDiagramSnapshot,
    getIdleDiagramSnapshot
  )
  useEffect(() => resource?.prepare(), [resource])
  const retry = useCallback(() => resource?.prepare(), [resource])
  return { ...snapshot, retry }
}
