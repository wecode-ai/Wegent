import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { isOversizedAtomicMarkdownChunk } from './assistantMarkdownWindowing'
import { useMarkdownWindowingScope, type MarkdownWindowingScope } from './MarkdownWindowingScope'
import { getScrollViewportElement } from '../conversation/scrollViewportElement'
import {
  getConversationDiagnosticContext,
  isConversationDiagnosticsEnabled,
  recordConversationDiagnostic,
} from '../conversation/conversationDiagnostics'

const PRE_RENDER_DISTANCE = 1_600
const ROOT_MARGIN = `${PRE_RENDER_DISTANCE}px 0px`

interface ChunkLayout {
  content: string
  width: number
  height: number
}

export function WindowedMarkdownChunk({
  chunkIndex,
  content,
  eager,
  children,
}: {
  chunkIndex: number
  content: string
  eager: boolean
  children: ReactNode
}) {
  const scope = useMarkdownWindowingScope()
  const chunkRef = useRef<HTMLDivElement>(null)
  // Keep indivisible long chunks mounted across streaming completion and reopening.
  const effectiveEager = eager || isOversizedAtomicMarkdownChunk(content)
  const [nearViewport, setNearViewport] = useState(
    () => typeof IntersectionObserver === 'undefined' || effectiveEager
  )
  const [retainedLayout, setRetainedLayout] = useState<ChunkLayout | null>(null)
  const renderedLayoutRef = useRef<ChunkLayout | null>(null)
  const previousEagerRef = useRef(effectiveEager)
  const diagnosticLayoutRef = useRef<{
    height: number
    measuredAtMs: number
  } | null>(null)
  const diagnosticDetailsRef = useRef<Record<string, number | boolean>>({})
  const shouldRender = effectiveEager || nearViewport
  const currentRef = useRef({
    content,
    rendered: shouldRender,
    eager: effectiveEager,
  })
  useLayoutEffect(() => {
    currentRef.current = {
      content,
      rendered: shouldRender,
      eager: effectiveEager,
    }
  }, [content, shouldRender, effectiveEager])
  const reservedHeight =
    retainedLayout?.content === content
      ? retainedLayout.height
      : estimateMarkdownChunkHeight(content)

  const saveRenderedLayout = useCallback(
    (rect: DOMRect) => {
      const current = currentRef.current
      if (!current.rendered || rect.width <= 0 || rect.height <= 0) return
      const layout = {
        content: current.content,
        width: rect.width,
        height: rect.height,
      }
      renderedLayoutRef.current = layout
      // Eager chunks cannot use placeholders; retaining every streamed version would evict useful heights.
      if (!current.eager) scope?.setHeight(layout.content, layout.width, layout.height)
    },
    [scope]
  )
  const retainPlaceholderLayout = useCallback(
    (rect: DOMRect) => {
      const current = currentRef.current
      const previous = renderedLayoutRef.current
      const height =
        scope?.getHeight(current.content, rect.width) ??
        (previous?.content === current.content && previous.width === rect.width
          ? previous.height
          : estimateMarkdownChunkHeight(current.content))
      setRetainedLayout(previous =>
        previous?.content === current.content &&
        previous.width === rect.width &&
        previous.height === height
          ? previous
          : { content: current.content, width: rect.width, height }
      )
    },
    [scope]
  )
  const viewportRender = useCallback((viewport: DOMRect): (() => void) | undefined => {
    const chunk = chunkRef.current
    if (!chunk || currentRef.current.rendered || !viewportHasSize(viewport)) return
    if (!isNearViewport(chunk.getBoundingClientRect(), viewport)) return
    return () => setNearViewport(true)
  }, [])

  // A virtual row can first mount inside the viewport. Complete that chunk and its
  // owning row measurement in the layout phase, before the browser paints placeholders.
  useLayoutEffect(() => {
    const chunk = chunkRef.current
    if (!chunk) return
    const rect = chunk.getBoundingClientRect()
    const wasEager = previousEagerRef.current
    previousEagerRef.current = effectiveEager
    if (shouldRender) {
      saveRenderedLayout(rect)
      scope?.onChunkLayout(chunk)
    } else {
      const layout = renderedLayoutRef.current
      // Completion can replace a far eager chunk directly with a placeholder.
      if (wasEager && !effectiveEager && layout?.content === content && layout.width === rect.width)
        scope?.setHeight(layout.content, layout.width, layout.height)
      retainPlaceholderLayout(rect)
      const root = getChunkRoot(scope, chunkRef.current)
      const viewport = root?.getBoundingClientRect() ?? windowViewport()
      if (viewportHasSize(viewport) && isNearViewport(rect, viewport)) setNearViewport(true)
    }

    if (!isConversationDiagnosticsEnabled()) return
    const previous = diagnosticLayoutRef.current
    const now = performance.now()
    diagnosticDetailsRef.current = {
      ...getConversationDiagnosticContext(chunk),
      chunkIndex,
      contentLength: content.length,
      lineCount: content.split('\n').length,
      eager: effectiveEager,
      nearViewport,
      rendered: shouldRender,
      reservedHeight,
      retainedHeight: retainedLayout?.content === content ? retainedLayout.height : 0,
      height: rect.height,
      previousHeight: previous?.height ?? rect.height,
      heightDelta: rect.height - (previous?.height ?? rect.height),
      width: rect.width,
      elapsedMs: previous ? now - previous.measuredAtMs : 0,
    }
    diagnosticLayoutRef.current = { height: rect.height, measuredAtMs: now }
    recordConversationDiagnostic('markdown-layout', diagnosticDetailsRef.current)
  }, [
    chunkIndex,
    content,
    effectiveEager,
    saveRenderedLayout,
    retainPlaceholderLayout,
    nearViewport,
    reservedHeight,
    retainedLayout,
    scope,
    shouldRender,
  ])

  useLayoutEffect(() => {
    if (effectiveEager) return
    if (scope) return scope.registerViewportCheck(viewport => viewportRender(viewport))
    const root = getChunkRoot(scope, chunkRef.current)
    const target = root ?? window
    const checkViewport = () => {
      const viewport = root?.getBoundingClientRect() ?? windowViewport()
      const render = viewportRender(viewport)
      if (render) flushSync(render)
    }
    target.addEventListener('scroll', checkViewport)
    return () => target.removeEventListener('scroll', checkViewport)
  }, [effectiveEager, scope, viewportRender])

  useLayoutEffect(() => {
    if (effectiveEager || typeof IntersectionObserver === 'undefined') return
    const chunk = chunkRef.current
    if (!chunk) return
    const root = getChunkRoot(scope, chunkRef.current)
    const observer = new IntersectionObserver(
      entries => {
        const entry = entries[0]
        if (!entry) return
        const rect = chunk.getBoundingClientRect()
        const viewport = root?.getBoundingClientRect() ?? windowViewport()
        // Entries describe an earlier layout. Recheck before a late callback demotes a visible chunk.
        const near = viewportHasSize(viewport) && isNearViewport(rect, viewport)
        if (isConversationDiagnosticsEnabled()) {
          recordConversationDiagnostic('markdown-intersection', {
            ...diagnosticDetailsRef.current,
            ...getConversationDiagnosticContext(chunk),
            chunkIndex,
            contentLength: currentRef.current.content.length,
            eager: currentRef.current.eager,
            rendered: currentRef.current.rendered,
            nearViewport: near,
            lineCount: currentRef.current.content.split('\n').length,
            intersection: entry.intersectionRatio,
            height: rect.height,
            width: rect.width,
            rootHeight: entry.rootBounds?.height ?? 0,
            intersectionHeight: entry.intersectionRect?.height ?? 0,
            targetTop: entry.boundingClientRect?.top ?? rect.top,
            scrollerTop: viewport.top,
            scrollerHeight: viewport.height,
          })
          diagnosticLayoutRef.current = {
            height: rect.height,
            measuredAtMs: performance.now(),
          }
        }
        if (!near) {
          saveRenderedLayout(rect)
          retainPlaceholderLayout(rect)
        }
        setNearViewport(near)
      },
      { root, rootMargin: ROOT_MARGIN }
    )
    observer.observe(chunk)
    return () => observer.disconnect()
  }, [chunkIndex, effectiveEager, scope, saveRenderedLayout, retainPlaceholderLayout])

  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const chunk = chunkRef.current
    if (!chunk) return
    const root = getChunkRoot(scope, chunkRef.current)
    const observer = new ResizeObserver(() => {
      const rect = chunk.getBoundingClientRect()
      if (currentRef.current.rendered) {
        saveRenderedLayout(rect)
      } else {
        retainPlaceholderLayout(rect)
        const viewport = root?.getBoundingClientRect() ?? windowViewport()
        const render = viewportRender(viewport)
        if (render) render()
      }
    })
    observer.observe(chunk)
    if (root) observer.observe(root)
    return () => observer.disconnect()
  }, [saveRenderedLayout, retainPlaceholderLayout, scope, viewportRender])

  useEffect(
    () => () => {
      if (!isConversationDiagnosticsEnabled()) return
      recordConversationDiagnostic('markdown-unmounted', {
        ...diagnosticDetailsRef.current,
        elapsedMs: diagnosticLayoutRef.current
          ? performance.now() - diagnosticLayoutRef.current.measuredAtMs
          : 0,
      })
    },
    []
  )

  return (
    <div
      ref={chunkRef}
      data-markdown-window-chunk
      className="flow-root"
      style={shouldRender ? undefined : { minHeight: reservedHeight }}
    >
      {shouldRender ? (
        children
      ) : (
        <div
          data-markdown-window-placeholder
          className="overflow-hidden whitespace-pre-wrap leading-6"
          style={{ maxHeight: reservedHeight }}
        >
          {content}
        </div>
      )}
    </div>
  )
}

function estimateMarkdownChunkHeight(content: string): number {
  return Math.max(120, Math.min(1_200, content.split('\n').length * 24))
}

function viewportHasSize(viewport: DOMRect): boolean {
  return viewport.width > 0 && viewport.height > 0
}

function isNearViewport(rect: DOMRect, viewport: DOMRect): boolean {
  return (
    rect.width > 0 &&
    rect.bottom >= viewport.top - PRE_RENDER_DISTANCE &&
    rect.top <= viewport.bottom + PRE_RENDER_DISTANCE
  )
}

function windowViewport(): DOMRect {
  return {
    top: 0,
    bottom: window.innerHeight,
    width: window.innerWidth,
    height: window.innerHeight,
  } as DOMRect
}

function getChunkRoot(
  scope: MarkdownWindowingScope | null,
  chunk: HTMLElement | null
): HTMLElement | null {
  return scope?.scrollElementRef?.current ?? getScrollViewportElement(chunk)
}
