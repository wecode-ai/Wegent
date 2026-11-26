import { useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { isOversizedAtomicMarkdownChunk } from './assistantMarkdownWindowing'
import {
  MarkdownWindowingDisabledContext,
  useMarkdownWindowingScope,
  type MarkdownWindowingScope,
} from './MarkdownWindowingScope'
import { getScrollViewportElement } from '../conversation/scrollViewportElement'
import { splitMarkdownCodeBlocks } from './markdownCodeBlocks'
import { diagramPreviewHeight } from './diagramLayout'
import {
  isNearMarkdownViewport as isNearViewport,
  MARKDOWN_ROOT_MARGIN as ROOT_MARGIN,
  windowViewport,
} from './markdownViewport'
import {
  getConversationDiagnosticContext,
  isConversationDiagnosticsEnabled,
  recordConversationDiagnostic,
} from '../conversation/conversationDiagnostics'

interface ChunkLayout {
  content: string
  width: number
  height: number
  scope: MarkdownWindowingScope | null
}

interface PlaceholderLayout extends ChunkLayout {
  measuredRowWidth?: number
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
  const windowingDisabled = useContext(MarkdownWindowingDisabledContext)
  const chunkRef = useRef<HTMLDivElement>(null)
  // Keep indivisible long chunks mounted across streaming completion and reopening.
  // Search expands chunks in place so existing Markdown and code DOM stay mounted.
  const effectiveEager = eager || windowingDisabled || isOversizedAtomicMarkdownChunk(content)
  const [nearViewport, setNearViewport] = useState(
    () => typeof IntersectionObserver === 'undefined' || effectiveEager
  )
  const [retainedLayout, setRetainedLayout] = useState<PlaceholderLayout | null>(null)
  const renderedLayoutRef = useRef<ChunkLayout | null>(null)
  const previousEagerRef = useRef(effectiveEager)
  const diagnosticLayoutRef = useRef<{
    height: number
    measuredAtMs: number
  } | null>(null)
  const diagnosticDetailsRef = useRef<Record<string, number | boolean>>({})
  const shouldRender = effectiveEager || nearViewport
  const previouslyRenderedRef = useRef(shouldRender)
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
  const diagnosticsEnabled = isConversationDiagnosticsEnabled()
  const reservedHeight =
    shouldRender && !diagnosticsEnabled
      ? undefined
      : retainedLayout?.content === content
      ? retainedLayout.height
      : estimateMarkdownChunkHeight(content, scope?.rootFontSize)

  const saveRenderedLayout = useCallback(
    (rect: DOMRect) => {
      const current = currentRef.current
      if (!current.rendered || rect.width <= 0 || rect.height <= 0) return
      const layout = {
        content: current.content,
        width: rect.width,
        height: rect.height,
        scope,
      }
      renderedLayoutRef.current = layout
      // Eager chunks cannot use placeholders; retaining every streamed version would evict useful heights.
      if (!current.eager) scope?.setHeight(layout.content, layout.width, layout.height)
    },
    [scope]
  )
  const retainPlaceholderLayout = useCallback(
    (
      rect: DOMRect,
      content = currentRef.current.content,
      chunk: HTMLElement | null = chunkRef.current
    ) => {
      const previous = renderedLayoutRef.current
      const cached = scope?.getHeight(content, rect.width)
      const previousHeight =
        previous?.content === content && previous.width === rect.width ? previous.height : undefined
      const measured =
        cached !== undefined || (previousHeight !== undefined && previous?.scope === scope)
      // The placeholder can retain old geometry during a split resize. Stamp
      // the owning row's width only when this height comes from real Markdown
      // in the current typography scope; row cache checks need no geometry read.
      const row = measured ? chunk?.closest<HTMLElement>('[data-message-row]') : null
      const rowWidth = row && Math.round(row.getBoundingClientRect().width)
      const layout: PlaceholderLayout = {
        content,
        width: rect.width,
        height:
          cached ?? previousHeight ?? estimateMarkdownChunkHeight(content, scope?.rootFontSize),
        scope,
        measuredRowWidth: rowWidth && rowWidth > 0 ? rowWidth : undefined,
      }
      setRetainedLayout(previous =>
        previous?.content === layout.content &&
        previous.width === layout.width &&
        previous.height === layout.height &&
        previous.scope === layout.scope &&
        previous.measuredRowWidth === layout.measuredRowWidth
          ? previous
          : layout
      )
      return layout
    },
    [scope]
  )
  const attachChunk = useCallback((chunk: HTMLDivElement | null) => {
    chunkRef.current = chunk
    if (!chunk) return
    return () => {
      chunkRef.current = null
      if (!isConversationDiagnosticsEnabled()) return
      recordConversationDiagnostic('markdown-unmounted', {
        ...diagnosticDetailsRef.current,
        elapsedMs: diagnosticLayoutRef.current
          ? performance.now() - diagnosticLayoutRef.current.measuredAtMs
          : 0,
      })
    }
  }, [])
  const attachPlaceholder = useCallback(
    (placeholder: HTMLDivElement | null) => {
      const chunk = placeholder?.parentElement
      if (!placeholder || !chunk) return
      // Capture native range loss before restoring the width-matched placeholder height.
      // Parent rows measure in this commit; growing the placeholder first would hide that clamp.
      scope?.captureNativeScrollRange()
      const layout = retainPlaceholderLayout(chunk.getBoundingClientRect(), content, chunk)
      chunk.style.minHeight = `${layout.height}px`
      placeholder.style.maxHeight = `${layout.height}px`
      if (layout.measuredRowWidth === undefined)
        delete placeholder.dataset.markdownPlaceholderRowWidth
      else placeholder.dataset.markdownPlaceholderRowWidth = String(layout.measuredRowWidth)
    },
    [content, retainPlaceholderLayout, scope]
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
    const wasEager = previousEagerRef.current
    previousEagerRef.current = effectiveEager
    const materialized = shouldRender && !previouslyRenderedRef.current
    previouslyRenderedRef.current = shouldRender
    if (effectiveEager && !diagnosticsEnabled) {
      // The row owner measures visible content. An eager chunk has no placeholder to size.
      scope?.onChunkLayout(chunk, materialized)
      return
    }
    const rect = chunk.getBoundingClientRect()
    if (shouldRender) {
      saveRenderedLayout(rect)
      scope?.onChunkLayout(chunk, materialized)
    } else {
      const layout = renderedLayoutRef.current
      // Completion can replace a far eager chunk directly with a placeholder.
      if (
        wasEager &&
        !effectiveEager &&
        layout?.content === content &&
        layout.width === rect.width &&
        layout.scope === scope
      )
        scope?.setHeight(layout.content, layout.width, layout.height)
      retainPlaceholderLayout(rect)
      const root = getChunkRoot(scope, chunkRef.current)
      const viewport = root?.getBoundingClientRect() ?? windowViewport()
      if (viewportHasSize(viewport) && isNearViewport(rect, viewport)) setNearViewport(true)
    }

    if (!diagnosticsEnabled) return
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
      reservedHeight: reservedHeight ?? 0,
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
    diagnosticsEnabled,
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
        if (!near && currentRef.current.rendered) {
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
        // Keep offscreen geometry until the chunk enters the viewport. A
        // column resize may have a cached height for another width, but
        // applying it here would move the reader after the row resize commit.
        const viewport = root?.getBoundingClientRect() ?? windowViewport()
        const render = viewportRender(viewport)
        if (render) render()
      }
    })
    observer.observe(chunk)
    if (root) observer.observe(root)
    return () => observer.disconnect()
  }, [saveRenderedLayout, scope, viewportRender])

  return (
    <div
      ref={attachChunk}
      data-markdown-window-chunk
      data-markdown-chunk-index={chunkIndex}
      className="flow-root"
      style={shouldRender ? undefined : { minHeight: reservedHeight }}
    >
      {shouldRender ? (
        children
      ) : (
        <div
          ref={attachPlaceholder}
          data-markdown-window-placeholder
          data-markdown-placeholder-row-width={
            retainedLayout?.content === content && retainedLayout.scope === scope
              ? retainedLayout.measuredRowWidth
              : undefined
          }
          className="overflow-hidden whitespace-pre-wrap leading-6"
          style={{ maxHeight: reservedHeight }}
        >
          {content}
        </div>
      )}
    </div>
  )
}

function estimateMarkdownChunkHeight(content: string, rootFontSize = 16): number {
  let diagramHeight = 0
  let textLines = 0
  for (const block of splitMarkdownCodeBlocks(content)) {
    if (block.kind === 'code' && block.diagram) diagramHeight += diagramPreviewHeight(rootFontSize)
    else textLines += block.kind === 'text' ? block.content.split('\n').length : block.lineCount
  }
  return Math.max(120, diagramHeight + Math.min(1_200, textLines * 24))
}

function viewportHasSize(viewport: DOMRect): boolean {
  return viewport.width > 0 && viewport.height > 0
}

function getChunkRoot(
  scope: MarkdownWindowingScope | null,
  chunk: HTMLElement | null
): HTMLElement | null {
  return scope?.scrollElementRef?.current ?? getScrollViewportElement(chunk)
}
