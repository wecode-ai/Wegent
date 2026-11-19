import { useDocumentEvent } from '@wegent/collaboration/dom-events'
import type { CodeViewHandle } from '@pierre/diffs/react'
import { useCallback, useMemo, type RefObject } from 'react'
import { createWorkspaceCodeEditorPort } from './workspaceCodeEditorPort'

export function useWorkspaceCodeEditor(
  path: string,
  hostRef: RefObject<HTMLElement | null>,
  lineStart?: number,
  lineEnd?: number
) {
  const port = useMemo(() => createWorkspaceCodeEditorPort(path), [path])
  useDocumentEvent('selectionchange', () => {
    if (hostRef.current?.contains(document.activeElement)) port.publishSelection()
  })
  const bindView = useCallback(
    (view: CodeViewHandle<undefined, undefined>) =>
      port.bindView(view, hostRef.current, lineStart, lineEnd),
    [hostRef, lineEnd, lineStart, port]
  )
  return { ...port, bindView }
}
