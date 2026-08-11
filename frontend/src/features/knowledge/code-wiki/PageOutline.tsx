// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

interface Heading {
  element: HTMLElement
  text: string
  /** 2 or 3; deeper levels are folded into 3 so the rail stays narrow. */
  level: number
}

interface PageOutlineProps {
  /** Raw markdown of the page being read. Used only as a signal to re-scan. */
  content: string
  /** The element headings are rendered into, watched for scroll position. */
  scrollContainer: HTMLElement | null
}

const HEADING_SELECTOR = 'h2, h3, h4, h5, h6'

/**
 * The headings actually on the page, in the order they appear.
 *
 * Read from the rendered document rather than parsed out of the markdown a second
 * time. The rail has to reach these elements to scroll to them and to watch them, and
 * anything derived separately has to be matched back up — which is what the previous
 * version did, by computing a slug per heading and looking it up by id. Nothing was
 * putting those ids on: the renderer overrides only `code` and `pre` and runs no slug
 * plugin, so every lookup returned null and the rail was inert in both directions.
 *
 * Reading the DOM removes the matching problem instead of fixing it. There is one
 * list, it is the one being scrolled, and it cannot disagree with itself about
 * duplicate titles, punctuation or raw HTML headings.
 */
function readHeadings(container: HTMLElement): Heading[] {
  return Array.from(container.querySelectorAll<HTMLElement>(HEADING_SELECTOR))
    .map(element => ({
      element,
      text: (element.textContent ?? '').trim(),
      level: Math.min(Number(element.tagName.slice(1)) || 3, 3),
    }))
    .filter(heading => heading.text.length > 0)
}

/**
 * The current page's headings, as a rail beside the content.
 *
 * Separate from the wiki navigation on the left, which moves between pages: this
 * moves within one. A generated page runs long enough that reaching a section by
 * scrolling is the slow way to do it.
 */
export function PageOutline({ content, scrollContainer }: PageOutlineProps) {
  const { t } = useTranslation('knowledge')
  const [headings, setHeadings] = useState<Heading[]>([])
  const [activeIndex, setActiveIndex] = useState(-1)
  const frame = useRef<number | null>(null)

  const rescan = useCallback(() => {
    if (!scrollContainer) return
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    // Coalesced to one frame: the markdown renderer is dynamically imported and
    // mermaid blocks resolve asynchronously, so the body arrives as a burst of
    // mutations rather than one.
    frame.current = requestAnimationFrame(() => setHeadings(readHeadings(scrollContainer)))
  }, [scrollContainer])

  useEffect(() => {
    if (!scrollContainer) return
    rescan()

    // The content is not present when this first runs, and nothing tells us when it
    // lands: `content` changes before the markdown is rendered, and the renderer
    // itself is loaded on demand. Watching the container covers all of it.
    const mutations = new MutationObserver(rescan)
    mutations.observe(scrollContainer, { childList: true, subtree: true })

    return () => {
      mutations.disconnect()
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    }
  }, [scrollContainer, content, rescan])

  useEffect(() => {
    if (!scrollContainer || headings.length === 0) return

    // rootMargin pulls the trigger line to the top quarter of the viewport, so the
    // highlighted entry is the section being read rather than the one just scrolled
    // past.
    const positionOf = new Map(headings.map((heading, index) => [heading.element, index]))
    const observer = new IntersectionObserver(
      entries => {
        const visible = entries
          .filter(entry => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (!visible[0]) return
        const index = positionOf.get(visible[0].target as HTMLElement)
        if (index !== undefined) setActiveIndex(index)
      },
      { root: scrollContainer, rootMargin: '0px 0px -75% 0px', threshold: 0 }
    )

    for (const heading of headings) observer.observe(heading.element)

    return () => observer.disconnect()
  }, [headings, scrollContainer])

  if (headings.length === 0) return null

  return (
    <nav
      className="hidden xl:flex w-56 shrink-0 flex-col gap-1 overflow-y-auto border-l border-border px-4 py-6"
      aria-label={t('codeWiki.outline.label')}
      data-testid="code-wiki-outline"
    >
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-text-tertiary">
        {t('codeWiki.outline.title')}
      </p>
      {headings.map((heading, index) => (
        <button
          key={`${index}-${heading.text}`}
          type="button"
          onClick={() => heading.element.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          data-testid={`code-wiki-outline-${index}`}
          className={`truncate rounded px-2 py-1 text-left text-sm transition-colors ${
            heading.level === 3 ? 'pl-5' : ''
          } ${
            activeIndex === index
              ? 'bg-surface-hover font-medium text-text-primary'
              : 'text-text-secondary hover:text-text-primary'
          }`}
          title={heading.text}
        >
          {heading.text}
        </button>
      ))}
    </nav>
  )
}

export { readHeadings }
