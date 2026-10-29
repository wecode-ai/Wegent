import {
  matchConversationText,
  type ConversationTextRange,
} from '@wegent/chat-core/conversation-search'
import { useEffect, useId, useLayoutEffect, useRef, type RefObject } from 'react'
import {
  scrollToContentPosition,
  getContentPositionForViewportY,
  isConversationScrollInput,
} from './conversationViewportScroll'
import {
  isConversationDiagnosticsEnabled,
  recordConversationDiagnostic,
} from './conversationDiagnostics'

export interface ConversationSearchTarget {
  query: string
  messageId: string
  occurrence: number
  regionId?: string
  range?: ConversationTextRange
  matchCounts: ReadonlyMap<string, number>
}

const SEARCH_CONTENT_SELECTOR =
  '[data-testid="user-message-content"], [data-testid="assistant-message-content"], [data-testid="process-text-block"]'

/** Read exactly the prose nodes used to build highlight offsets. */
export function readConversationSearchContent(content: HTMLElement) {
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
    acceptNode: node =>
      node.parentElement?.closest(
        'button:not([data-testid="assistant-markdown-link"]), [data-search-excluded], [data-testid="assistant-markdown-link-line"], [aria-hidden="true"], [data-testid="markdown-code-block-language"], [data-testid="user-message-goal-badge"], [data-testid="message-code-comment-context-badge"], .wework-diagram-preview .drawing-viewer, script, style, textarea, [contenteditable="true"]'
      )
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  })
  const nodes: Array<{ node: Text; start: number; end: number }> = []
  let text = ''
  let previousBlock: Element | null = null
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.textContent ?? ''
    const block =
      node.parentElement?.closest(
        'p, h1, h2, h3, h4, h5, h6, li, td, th, pre, [data-testid="user-message-question-reply"] span'
      ) ?? null
    if (!value || (!value.trim() && !node.parentElement?.closest('pre') && !block)) continue
    if (text && block !== previousBlock) text += '\n'
    previousBlock = block
    nodes.push({
      node: node as Text,
      start: text.length,
      end: text.length + value.length,
    })
    text += value
  }
  return { text, nodes }
}

/** Searches rendered prose across inline Markdown and syntax-highlighted code nodes. */
function conversationSearchRangeEntries(
  container: HTMLElement,
  query: string,
  maxMatches: number
): Array<{ range: Range; regionId: string; position: ConversationTextRange }> {
  if (!query.trim() || maxMatches <= 0) return []
  const ranges: Array<{
    range: Range
    regionId: string
    position: ConversationTextRange
  }> = []
  for (const content of container.querySelectorAll<HTMLElement>(SEARCH_CONTENT_SELECTOR)) {
    const { text, nodes } = readConversationSearchContent(content)
    let firstIndex = 0
    let lastIndex = 0
    for (const position of matchConversationText(text, query)) {
      const offset = position.start
      // Matches advance monotonically; each text node is visited at most once per cursor.
      while (firstIndex < nodes.length && nodes[firstIndex].end <= offset) firstIndex += 1
      lastIndex = Math.max(lastIndex, firstIndex)
      while (lastIndex < nodes.length && nodes[lastIndex].end < position.end) lastIndex += 1
      const first = nodes[firstIndex]
      const last = nodes[lastIndex]
      if (!first || !last) continue
      const range = document.createRange()
      range.setStart(first.node, offset - first.start)
      range.setEnd(last.node, position.end - last.start)
      ranges.push({
        range,
        position,
        regionId: content.dataset.searchRegionId ?? container.dataset.messageId ?? '',
      })
      if (ranges.length >= maxMatches) return ranges
    }
  }
  return ranges
}

export function conversationSearchRanges(
  container: HTMLElement,
  query: string,
  maxMatches: number
): Range[] {
  return conversationSearchRangeEntries(container, query, maxMatches).map(entry => entry.range)
}

export function useConversationSearchTarget({
  target,
  navigationPaused = false,
  contentRef,
  scrollRef,
  interactionRef,
  onNavigationTargetChange,
  onNavigationFailure,
}: {
  target?: ConversationSearchTarget | null
  navigationPaused?: boolean
  contentRef: RefObject<HTMLDivElement | null>
  scrollRef: RefObject<HTMLDivElement | null>
  interactionRef?: RefObject<HTMLElement | null>
  onNavigationTargetChange: (messageId: string | null) => void
  onNavigationFailure?: (target: ConversationSearchTarget) => void
}) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '')
  const navigationPausedRef = useRef(navigationPaused)
  const cancelNavigationRef = useRef<(() => void) | null>(null)
  useLayoutEffect(() => {
    navigationPausedRef.current = navigationPaused
    if (navigationPaused) cancelNavigationRef.current?.()
  }, [navigationPaused])
  const previousTargetMessageId = useRef<string | null>(null)
  useLayoutEffect(() => {
    const messageId = target?.messageId ?? null
    if (target || previousTargetMessageId.current !== null) {
      recordConversationDiagnostic('search-target-commit', {
        queryLength: target?.query.length ?? 0,
        targetChanged: previousTargetMessageId.current !== messageId,
      })
    }
    previousTargetMessageId.current = messageId
  }, [target])
  useEffect(() => {
    const content = contentRef.current
    const scroller = scrollRef.current
    if (!target || !content || !scroller) return
    recordConversationDiagnostic('search-target-effect', {
      queryLength: target.query.length,
    })
    if (!navigationPausedRef.current) onNavigationTargetChange(target.messageId)
    const name = `conversation-search-${id}`
    const activeName = `${name}-active`
    const style = document.createElement('style')
    style.textContent = `
      ::highlight(${name}) {
        background: rgb(var(--color-search-match));
        color: rgb(var(--color-search-match-text));
      }
      ::highlight(${activeName}) {
        background: rgb(var(--color-search-match-active));
        color: rgb(var(--color-search-match-text));
      }
      @media (forced-colors: active) {
        ::highlight(${name}) { background: Mark; color: MarkText; }
        ::highlight(${activeName}) { background: Highlight; color: HighlightText; }
      }
    `
    document.head.append(style)
    let frame = 0
    let navigationFrame = 0
    let mutationTimer = 0
    let matchTimer = 0
    let navigationFinished = false
    let navigationScrolling = false
    let navigationCancelled = navigationPausedRef.current
    let disposed = false
    let preparationStarted = false
    let preparationFrames = 0
    let highlightsDirty = true
    let highlightMatchCount = 0
    let activeRange: Range | undefined
    let diagramAnchor: HTMLElement | null = null
    const navigationStartedAt = performance.now()
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'auto'
      : 'smooth'
    const recordPhase = (phase: number, smooth = false) =>
      recordConversationDiagnostic('search-navigation-phase', {
        phase,
        smooth,
        elapsedMs: performance.now() - navigationStartedAt,
        queryLength: target.query.length,
      })
    const finishNavigation = () => {
      if (navigationFinished) return
      navigationFinished = true
      navigationScrolling = false
      scroller.removeEventListener('scrollend', finishNavigation)
      cancelAnimationFrame(navigationFrame)
      navigationFrame = 0
      clearTimeout(matchTimer)
      onNavigationTargetChange(null)
    }
    const timeoutNavigation = () => {
      matchTimer = 0
      if (navigationFinished || !isCurrent()) return
      // A long main-thread task may have made the match available before this timer can run.
      cancelAnimationFrame(frame)
      clearTimeout(mutationTimer)
      mutationTimer = 0
      highlightsDirty = true
      update()
      const article = getArticle()
      if (article && getTargetRect(article)) {
        clearTimeout(matchTimer)
        matchTimer = 0
        scheduleNavigation()
        return
      }
      recordPhase(4)
      onNavigationFailure?.(target)
      finishNavigation()
    }
    const waitForMatch = () => {
      if (navigationFinished) return
      preparationStarted = false
      preparationFrames = 0
      if (!matchTimer) matchTimer = window.setTimeout(timeoutNavigation, 1500)
    }
    const isCurrent = () =>
      !disposed &&
      !navigationPausedRef.current &&
      contentRef.current === content &&
      scrollRef.current === scroller
    const getArticle = () =>
      Array.from(content.querySelectorAll<HTMLElement>('[data-message-id]')).find(
        element => element.dataset.messageId === target.messageId
      )
    const hasActiveRange = (article: HTMLElement) =>
      Boolean(
        activeRange &&
        !activeRange.collapsed &&
        article.contains(activeRange.startContainer) &&
        article.contains(activeRange.endContainer)
      )
    const getTargetRect = (article: HTMLElement) => {
      if (diagramAnchor && !article.contains(diagramAnchor)) diagramAnchor = null
      const rect = diagramAnchor
        ? diagramAnchor.getBoundingClientRect()
        : hasActiveRange(article)
          ? activeRange!.getBoundingClientRect()
          : null
      return rect && Number.isFinite(rect.top) && Number.isFinite(rect.height) && rect.height > 0
        ? rect
        : null
    }
    const hasNavigationTarget = () => {
      const article = getArticle()
      return Boolean(
        article && ((diagramAnchor && article.contains(diagramAnchor)) || hasActiveRange(article))
      )
    }
    const recordLayout = (startedAt: number) => {
      if (!isConversationDiagnosticsEnabled()) return
      recordConversationDiagnostic('search-layout', {
        elapsedMs: performance.now() - startedAt,
        queryLength: target.query.length,
        matchCount: highlightMatchCount,
      })
    }
    const prepareNavigation = () => {
      navigationFrame = 0
      if (!isCurrent() || navigationCancelled || navigationFinished) return
      const article = getArticle()
      if (!article) {
        waitForMatch()
        return
      }
      const startedAt = performance.now()
      const rect = getTargetRect(article)
      if (!rect) {
        waitForMatch()
        return
      }
      clearTimeout(matchTimer)
      matchTimer = 0
      if (!preparationStarted) {
        preparationStarted = true
        preparationFrames = 2
        const viewportTop = scroller.getBoundingClientRect().top
        const farFromViewport =
          scroller.clientHeight > 0 &&
          Math.abs(rect.top + rect.height / 2 - viewportTop - scroller.clientHeight / 2) >
            scroller.clientHeight
        if (behavior === 'smooth' && farFromViewport) {
          // Mount the target's virtual neighbours before starting the final animation.
          const articleRect = article.getBoundingClientRect()
          const articleTop = Math.max(
            0,
            getContentPositionForViewportY(scroller, articleRect.top + articleRect.height / 2) -
              scroller.clientHeight / 2
          )
          recordPhase(2)
          scrollToContentPosition(scroller, articleTop, 'auto')
          recordLayout(startedAt)
        }
      } else if (--preparationFrames <= 0) {
        const top = Math.max(
          0,
          getContentPositionForViewportY(scroller, rect.top + rect.height / 2) -
            scroller.clientHeight / 2
        )
        // Highlight refreshes never correct or restart this native animation.
        recordPhase(3, behavior === 'smooth')
        navigationScrolling = true
        scroller.addEventListener('scrollend', finishNavigation)
        scrollToContentPosition(scroller, top, behavior)
        recordLayout(startedAt)
        if (behavior === 'auto') finishNavigation()
        else {
          const destination = Math.min(
            top,
            Math.max(0, scroller.scrollHeight - scroller.clientHeight)
          )
          navigationFrame = requestAnimationFrame(() => {
            navigationFrame = 0
            // A no-op or clamped scroll does not dispatch scrollend.
            if (Math.abs(scroller.scrollTop - destination) < 1) finishNavigation()
          })
        }
        return
      }
      scheduleNavigation()
    }
    const scheduleNavigation = () => {
      if (
        isCurrent() &&
        !navigationCancelled &&
        !navigationFinished &&
        !navigationScrolling &&
        !navigationFrame
      )
        navigationFrame = requestAnimationFrame(prepareNavigation)
    }
    const update = () => {
      frame = 0
      // Keep the previous highlights and expanded DOM while a newer query is pending.
      if (!isCurrent()) return
      // A mutation can invalidate the active range before resize notifications arrive.
      if (mutationTimer) return
      const diagnosticsEnabled = isConversationDiagnosticsEnabled()
      const highlightsStartedAt = diagnosticsEnabled && highlightsDirty ? performance.now() : 0
      const articles = Array.from(content.querySelectorAll<HTMLElement>('[data-message-id]'))
      const article = articles.find(element => element.dataset.messageId === target.messageId)
      if (!article) {
        waitForMatch()
        return
      }
      if (highlightsDirty) {
        // Only matched messages contribute ranges, bounded by the search result budget.
        const entries = articles.flatMap(element =>
          conversationSearchRangeEntries(
            element,
            target.query,
            target.matchCounts.get(element.dataset.messageId ?? '') ?? 0
          )
        )
        const ranges = entries.map(entry => entry.range)
        let occurrence = 0
        activeRange = entries.find(entry => {
          if (!article.contains(entry.range.startContainer)) return false
          if (target.regionId && target.range)
            return (
              entry.regionId === target.regionId &&
              entry.position.start === target.range.start &&
              entry.position.end === target.range.end
            )
          return occurrence++ === target.occurrence
        })?.range
        const diagramSource = activeRange?.startContainer.parentElement?.closest(
          '[data-diagram-search-source]'
        )
        // SVG rendering must not invalidate the diagram's fixed section as the navigation anchor.
        if (diagramSource?.parentElement) diagramAnchor = diagramSource.parentElement
        if (typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined') {
          CSS.highlights.set(name, new Highlight(...ranges))
          CSS.highlights.set(activeName, new Highlight(...(activeRange ? [activeRange] : [])))
        }
        highlightMatchCount = ranges.length
        highlightsDirty = false
        if (diagnosticsEnabled) {
          recordConversationDiagnostic('search-highlights', {
            elapsedMs: performance.now() - highlightsStartedAt,
            queryLength: target.query.length,
            messageCount: articles.length,
            matchCount: highlightMatchCount,
          })
        }
      }
      if (!hasNavigationTarget()) waitForMatch()
      scheduleNavigation()
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    const observer = new MutationObserver(() => {
      highlightsDirty = true
      if (!mutationTimer) {
        mutationTimer = window.setTimeout(() => {
          mutationTimer = 0
          schedule()
        }, 80)
      }
    })
    observer.observe(content, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-hidden', 'contenteditable', 'data-testid'],
    })
    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            scheduleNavigation()
          })
    resizeObserver?.observe(content)
    const stopNativeScroll = () => {
      if (!navigationScrolling) return
      scroller.removeEventListener('scrollend', finishNavigation)
      scrollToContentPosition(scroller, scroller.scrollTop, 'auto')
      navigationScrolling = false
    }
    const cancelNavigation = (pauseHighlights = true) => {
      if (pauseHighlights) {
        observer.disconnect()
        resizeObserver?.disconnect()
        cancelAnimationFrame(frame)
        clearTimeout(mutationTimer)
      }
      if (navigationCancelled) return
      navigationCancelled = true
      cancelAnimationFrame(navigationFrame)
      stopNativeScroll()
      finishNavigation()
      recordConversationDiagnostic('search-navigation-cancel', {
        queryLength: target.query.length,
      })
    }
    const cancelForInput = (event: Event) => {
      if (navigationFinished || !isConversationScrollInput(event)) return
      cancelNavigation(false)
    }
    const inputTargets = [scroller, interactionRef?.current].filter(
      (element): element is HTMLElement => element !== null && element !== undefined
    )
    for (const element of inputTargets)
      for (const type of ['wheel', 'pointerdown', 'touchstart', 'keydown'])
        element.addEventListener(type, cancelForInput, { capture: true, passive: true })
    cancelNavigationRef.current = cancelNavigation
    if (navigationCancelled) {
      observer.disconnect()
      resizeObserver?.disconnect()
      clearTimeout(matchTimer)
    } else {
      recordPhase(1)
      schedule()
    }
    return () => {
      disposed = true
      if (cancelNavigationRef.current === cancelNavigation) cancelNavigationRef.current = null
      observer.disconnect()
      resizeObserver?.disconnect()
      cancelAnimationFrame(frame)
      cancelAnimationFrame(navigationFrame)
      clearTimeout(mutationTimer)
      clearTimeout(matchTimer)
      for (const element of inputTargets)
        for (const type of ['wheel', 'pointerdown', 'touchstart', 'keydown'])
          element.removeEventListener(type, cancelForInput, true)
      stopNativeScroll()
      finishNavigation()
      if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
        CSS.highlights.delete(name)
        CSS.highlights.delete(activeName)
      }
      style.remove()
    }
  }, [
    target,
    contentRef,
    scrollRef,
    interactionRef,
    id,
    onNavigationTargetChange,
    onNavigationFailure,
  ])
}
