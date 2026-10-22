import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import {
  getConversationDiagnosticContext,
  isConversationDiagnosticsEnabled,
  recordConversationDiagnostic,
  type ConversationDiagnosticEventName,
} from '../conversation/conversationDiagnostics'

const MAX_CONTENT_IDENTITIES = 64
const MAX_IDENTITY_CHARACTERS = 262_144
const OBSERVATION_WINDOW_MS = 10_000
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

  const { code, language, theme, renderViewer, fullscreen } = options
  useLayoutEffect(() => {
    const element = elementRef.current
    if (!renderViewer || !element || !isConversationDiagnosticsEnabled()) return
    if (!activated.current) {
      activated.current = true
      record('search-diagram-activate')
    }
    const renderId = nextRenderId++
    const startedAt = performance.now()
    let rendered = false
    let failed = false
    let timedOut = false
    const previousState = element.querySelector<HTMLElement>('.drawing-state')
    record('search-diagram-viewer-start', { diagramRenderId: renderId, startTime: startedAt })
    const details = () => ({
      diagramRenderId: renderId,
      startTime: startedAt,
      elapsedMs: performance.now() - startedAt,
      rendered,
      failed,
      timedOut,
    })
    const observer = new MutationObserver(() => {
      if (!isConversationDiagnosticsEnabled()) {
        timedOut = true
        stop()
        return
      }
      inspectResult()
    })
    const stop = () => {
      observer.disconnect()
      clearTimeout(timer)
    }
    const inspectResult = () => {
      // The renderer returns before its asynchronous layout finishes. Its own
      // hidden loading state changes only after the final SVG and Panzoom exist.
      const state = element.querySelector<HTMLElement>('.drawing-state')
      // Updated viewer props reload in a passive effect, after this layout effect.
      if (!state || state === previousState) return
      const svg = element.querySelector('.drawing-diagram-pan > svg.drawing-diagram-svg')
      rendered = Boolean(state.hidden && svg)
      failed = Boolean(state?.classList.contains('error'))
      if (!rendered && !failed) return
      record('search-diagram-viewer-result', {
        ...details(),
        cacheHit: svg?.getAttribute('data-diagram-cache-hit') === 'true',
        layoutIsolated: svg?.getAttribute('data-mermaid-layout-isolated') === 'true',
      })
      stop()
    }
    const timer = setTimeout(() => {
      timedOut = true
      record('search-diagram-viewer-timeout', details())
      stop()
    }, OBSERVATION_WINDOW_MS)
    observer.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'class'],
    })
    inspectResult()
    return () => {
      stop()
      record('search-diagram-viewer-stop', details())
    }
  }, [code, language, theme, renderViewer, fullscreen, elementRef, record])
}
