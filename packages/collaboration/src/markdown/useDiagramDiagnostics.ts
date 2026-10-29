import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import {
  getConversationDiagnosticContext,
  isConversationDiagnosticsEnabled,
  recordConversationDiagnostic,
  type ConversationDiagnosticEventName,
} from '../conversation/conversationDiagnostics'

const MAX_CONTENT_IDENTITIES = 64
const MAX_IDENTITY_CHARACTERS = 262_144
const contentIds = new Map<string, number>()
let identityCharacters = 0
let nextContentId = 1
let nextInstanceId = 1
let nextRenderId = 1

// Keys stay in a bounded, renderer-local map. Only opaque integers enter the log.
// Equal content shares an identity, including separate copies of the same diagram.
function contentIdentity(code: string, language: string): number | null {
  const key = `${language}\0${code}`
  const existing = contentIds.get(key)
  if (existing !== undefined) {
    contentIds.delete(key)
    contentIds.set(key, existing)
    return existing
  }
  if (key.length > MAX_IDENTITY_CHARACTERS) return null
  while (
    contentIds.size >= MAX_CONTENT_IDENTITIES ||
    identityCharacters + key.length > MAX_IDENTITY_CHARACTERS
  ) {
    const oldest = contentIds.keys().next().value!
    identityCharacters -= oldest.length
    contentIds.delete(oldest)
  }
  const id = nextContentId++
  contentIds.set(key, id)
  identityCharacters += key.length
  return id
}

interface DiagramDiagnosticOptions {
  code: string
  language: string
  theme: string
  renderViewer: boolean
  fullscreen: boolean
  status: 'idle' | 'loading' | 'ready' | 'error'
}

export function useDiagramDiagnostics(
  elementRef: RefObject<HTMLElement | null>,
  options: DiagramDiagnosticOptions
): void {
  const current = useRef(options)
  const instanceId = useRef(0)
  const activated = useRef(false)
  const context = useRef({ scrollerId: 0, rowIndex: -1 })
  useLayoutEffect(() => {
    current.current = options
  })
  const record = useCallback(
    (name: ConversationDiagnosticEventName, details = {}) => {
      if (!isConversationDiagnosticsEnabled()) return
      if (!instanceId.current) instanceId.current = nextInstanceId++
      if (elementRef.current) context.current = getConversationDiagnosticContext(elementRef.current)
      const source = current.current
      recordConversationDiagnostic(name, {
        ...context.current,
        diagramContentId: contentIdentity(source.code, source.language),
        diagramInstanceId: instanceId.current,
        contentLength: source.code.length,
        mermaid: source.language === 'mermaid',
        darkTheme: source.theme === 'dark',
        fullscreen: source.fullscreen,
        ...details,
      })
    },
    [elementRef]
  )

  useLayoutEffect(() => {
    record('search-diagram-mount')
    return () => record('search-diagram-unmount')
  }, [record])

  const cycle = useRef<{ id: number; startedAt: number; reported: boolean } | null>(null)
  const { code, language, theme, renderViewer, status } = options
  useLayoutEffect(() => {
    if (!renderViewer || !isConversationDiagnosticsEnabled()) return
    if (!activated.current) {
      activated.current = true
      record('search-diagram-activate')
    }
    const next = { id: nextRenderId++, startedAt: performance.now(), reported: false }
    cycle.current = next
    record('search-diagram-viewer-start', { diagramRenderId: next.id, startTime: next.startedAt })
    return () => {
      record('search-diagram-viewer-stop', {
        diagramRenderId: next.id,
        elapsedMs: performance.now() - next.startedAt,
        rendered: current.current.status === 'ready',
        failed: current.current.status === 'error',
      })
      cycle.current = null
    }
  }, [code, language, theme, renderViewer, record])

  useLayoutEffect(() => {
    const active = cycle.current
    if (!active || active.reported || (status !== 'ready' && status !== 'error')) return
    active.reported = true
    record('search-diagram-viewer-result', {
      diagramRenderId: active.id,
      elapsedMs: performance.now() - active.startedAt,
      rendered: status === 'ready',
      failed: status === 'error',
    })
  }, [status, code, language, theme, record])
}
