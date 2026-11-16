import { useLayoutEffect, useRef } from 'react'
import { findTaskCommentScrollContainer } from './useIssueActivityScroll'

/** Reserve the sticky composer's inset for browser focus and scrollIntoView. */
export function useIssueComposerViewport(enabled: boolean) {
  const composerRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const composer = composerRef.current
    if (!enabled || !composer) return
    const viewport = findTaskCommentScrollContainer(composer)
    if (!viewport) return
    const previous = viewport.style.scrollPaddingBottom
    const update = () => {
      const bounds = viewport.getBoundingClientRect()
      const questionVisible = [...viewport.querySelectorAll('.task-detail-human-requests')].some(
        (question) => {
          const questionBounds = question.getBoundingClientRect()
          return questionBounds.bottom > bounds.top && questionBounds.top < bounds.bottom
        },
      )
      composer.dataset.humanRequestVisible = String(questionVisible)
      const style = window.getComputedStyle(composer)
      const bottom = Number.parseFloat(style.bottom) || 0
      viewport.style.scrollPaddingBottom =
        style.position === 'sticky'
          ? `${Math.ceil(composer.getBoundingClientRect().height + bottom)}px`
          : previous
    }
    const observer = new ResizeObserver(update)
    observer.observe(composer)
    observer.observe(viewport)
    const forms = new MutationObserver((records) => {
      if (
        records.some((record) =>
          [...record.addedNodes, ...record.removedNodes].some(isHumanRequest),
        )
      )
        update()
    })
    forms.observe(viewport, { childList: true, subtree: true })
    viewport.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    update()
    return () => {
      observer.disconnect()
      forms.disconnect()
      viewport.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      delete composer.dataset.humanRequestVisible
      viewport.style.scrollPaddingBottom = previous
    }
  }, [enabled])
  return composerRef
}

function isHumanRequest(node: Node) {
  return (
    node instanceof Element &&
    (node.matches('.task-detail-human-requests') ||
      Boolean(node.querySelector('.task-detail-human-requests')))
  )
}
