import { createContext, useCallback, useContext, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { useDOMEvent, useWindowEvent } from '../dom-events'
import {
  isConversationDiagnosticsEnabled,
  recordConversationDiagnostic,
} from '../conversation/conversationDiagnostics'
import { SCROLLBAR_DRAG_POSITION_EVENT } from '../conversation/conversationScrollWrite'

const MAX_MARKDOWN_HEIGHT_ENTRIES = 256

export interface MarkdownWindowingScope {
  rootFontSize: number
  scrollElementRef?: RefObject<HTMLElement | null>
  getHeight(content: string, width: number): number | undefined
  setHeight(content: string, width: number, height: number): void
  onChunkLayout(element: HTMLElement): void
  captureNativeScrollRange(): void
  registerViewportCheck(check: (viewport: DOMRect) => (() => void) | undefined): () => void
  getViewportRenders(): Array<() => void>
}

export function createMarkdownWindowingScope(
  scrollElementRef: RefObject<HTMLElement | null> | undefined,
  onChunkLayout: (element: HTMLElement) => void,
  rootFontSize = 16,
  onNativeScrollRange?: () => void
): MarkdownWindowingScope {
  const heights = new Map<string, number>()

  return {
    rootFontSize,
    ...createViewportChecks(scrollElementRef),
    scrollElementRef,
    onChunkLayout,
    captureNativeScrollRange: () => onNativeScrollRange?.(),
    getHeight(content, width) {
      if (!isPositiveFinite(width)) return undefined
      const key = JSON.stringify([content, width])
      const height = heights.get(key)
      if (height === undefined) return undefined
      heights.delete(key)
      heights.set(key, height)
      return height
    },
    setHeight(content, width, height) {
      if (!isPositiveFinite(width) || !isPositiveFinite(height)) return
      const key = JSON.stringify([content, width])
      heights.delete(key)
      heights.set(key, height)
      while (heights.size > MAX_MARKDOWN_HEIGHT_ENTRIES) {
        const oldestKey = heights.keys().next().value
        if (oldestKey === undefined) break
        heights.delete(oldestKey)
      }
    },
  }
}

function createViewportChecks(
  scrollElementRef: RefObject<HTMLElement | null> | undefined
): Pick<MarkdownWindowingScope, 'registerViewportCheck' | 'getViewportRenders'> {
  const checks = new Set<(viewport: DOMRect) => (() => void) | undefined>()
  return {
    registerViewportCheck(check) {
      checks.add(check)
      return () => checks.delete(check)
    },
    getViewportRenders() {
      const scroller = scrollElementRef?.current
      if (!scroller || checks.size === 0) return []
      const viewport = scroller.getBoundingClientRect()
      if (!isPositiveFinite(viewport.width) || !isPositiveFinite(viewport.height)) return []
      const renders: Array<() => void> = []
      checks.forEach(check => {
        const render = check(viewport)
        if (render) renders.push(render)
      })
      return renders
    },
  }
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

export const MarkdownWindowingContext = createContext<MarkdownWindowingScope | null>(null)
export const MarkdownWindowingDisabledContext = createContext(false)

export function useMarkdownWindowingScope(): MarkdownWindowingScope | null {
  return useContext(MarkdownWindowingContext)
}

export function useMarkdownWindowingViewport(scope: MarkdownWindowingScope) {
  const renderScrolledMarkdown = useCallback(
    (event: Event) => {
      if (event.target !== scope.scrollElementRef?.current) return
      const startedAt = isConversationDiagnosticsEnabled() ? performance.now() : null
      const renders = scope.getViewportRenders()
      if (renders.length > 0) flushSync(() => renders.forEach(render => render()))
      if (startedAt === null) return
      const elapsedMs = performance.now() - startedAt
      if (elapsedMs >= 16)
        recordConversationDiagnostic('search-scroll-render', {
          elapsedMs,
          renderedCount: renders.length,
        })
    },
    [scope]
  )
  useWindowEvent('scroll', renderScrolledMarkdown, { capture: true, passive: true })
  // The SDK updates drag position before Chromium delivers the native scroll event.
  useDOMEvent('window', SCROLLBAR_DRAG_POSITION_EVENT, renderScrolledMarkdown, { capture: true })
}
