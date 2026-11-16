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
    const margins = new Map<HTMLElement, { value: string; priority: string }>()
    const update = () => {
      const bounds = viewport.getBoundingClientRect()
      const questions = [...viewport.querySelectorAll<HTMLElement>(questionSelector)].map(
        (element) => ({ element, bounds: element.getBoundingClientRect() }),
      )
      const questionVisible = questions.some(
        (question) => question.bounds.bottom > bounds.top && question.bounds.top < bounds.bottom,
      )
      composer.dataset.humanRequestVisible = String(questionVisible)
      const style = window.getComputedStyle(composer)
      const bottom = Number.parseFloat(style.bottom) || 0
      const inset =
        style.position === 'sticky'
          ? Math.ceil(composer.getBoundingClientRect().height + bottom)
          : 0
      viewport.style.scrollPaddingBottom = inset ? `${inset}px` : previous
      for (const question of questions) {
        if (!margins.has(question.element)) {
          margins.set(question.element, {
            value: question.element.style.getPropertyValue('scroll-margin-bottom'),
            priority: question.element.style.getPropertyPriority('scroll-margin-bottom'),
          })
          observer.observe(question.element)
        }
        // A question releases the overlay on arrival. Cancel its old reservation
        // before browser positioning, without inverting a short target's rectangle.
        if (inset)
          question.element.style.scrollMarginBottom = `${-Math.min(inset, question.bounds.height)}px`
        else restoreMargin(question.element, margins.get(question.element)!)
      }
      for (const [element, original] of margins) {
        if (viewport.contains(element)) continue
        restoreMargin(element, original)
        observer.unobserve(element)
        margins.delete(element)
      }
    }
    const observer = new ResizeObserver(update)
    observer.observe(composer)
    observer.observe(viewport)
    // Preceding content can move a question without resizing the question itself.
    let content = composer
    while (content.parentElement && content.parentElement !== viewport)
      content = content.parentElement
    observer.observe(content)
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
      for (const [element, original] of margins) restoreMargin(element, original)
    }
  }, [enabled])
  return composerRef
}

const questionSelector = '.task-detail-human-requests, .task-detail-human-request'

function restoreMargin(element: HTMLElement, original: { value: string; priority: string }) {
  if (original.value)
    element.style.setProperty('scroll-margin-bottom', original.value, original.priority)
  else element.style.removeProperty('scroll-margin-bottom')
}

function isHumanRequest(node: Node) {
  return (
    node instanceof Element &&
    (node.matches(questionSelector) || Boolean(node.querySelector(questionSelector)))
  )
}
