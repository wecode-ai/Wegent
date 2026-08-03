// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

interface Heading {
  id: string
  text: string
  /** 2 or 3; deeper levels are folded into 3 so the rail stays narrow. */
  level: number
}

interface PageOutlineProps {
  /** Raw markdown of the page being read. */
  content: string
  /** The element headings are rendered into, watched for scroll position. */
  scrollContainer: HTMLElement | null
}

/** Fenced blocks are skipped: `# ` inside one is a comment, not a heading. */
const collectHeadings = (markdown: string): Heading[] => {
  const headings: Heading[] = []
  const seen = new Map<string, number>()
  let inFence = false

  for (const line of markdown.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    const match = /^(#{2,6})\s+(.+?)\s*$/.exec(line)
    if (!match) continue

    const text = match[2].replace(/[*_`]/g, '').trim()
    if (!text) continue

    // Two sections can share a title, and an id that repeats would scroll to the
    // first one from every entry.
    const base = text.toLowerCase().replace(/[^\w一-龥]+/g, '-')
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)

    headings.push({
      id: count === 0 ? base : `${base}-${count}`,
      text,
      level: Math.min(match[1].length, 3),
    })
  }

  return headings
}

/**
 * The current page's headings, as a rail beside the content.
 *
 * Separate from the wiki navigation on the left, which moves between pages: this
 * moves within one. A generated page runs long enough that reaching a section by
 * scrolling is the slow way to do it.
 */
export function PageOutline({ content, scrollContainer }: PageOutlineProps) {
  const { t } = useTranslation()
  const headings = useMemo(() => collectHeadings(content), [content])
  const [activeId, setActiveId] = useState<string>('')
  const observer = useRef<IntersectionObserver | null>(null)

  useEffect(() => {
    if (!scrollContainer || headings.length === 0) return

    // rootMargin pulls the trigger line to the top quarter of the viewport, so the
    // highlighted entry is the section being read rather than the one just scrolled
    // past.
    observer.current = new IntersectionObserver(
      entries => {
        const visible = entries
          .filter(entry => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) setActiveId(visible[0].target.id)
      },
      { root: scrollContainer, rootMargin: '0px 0px -75% 0px', threshold: 0 }
    )

    for (const heading of headings) {
      const element = scrollContainer.querySelector(`#${CSS.escape(heading.id)}`)
      if (element) observer.current.observe(element)
    }

    return () => observer.current?.disconnect()
  }, [headings, scrollContainer])

  if (headings.length === 0) return null

  const jumpTo = (id: string) => {
    const element = scrollContainer?.querySelector(`#${CSS.escape(id)}`)
    element?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <nav
      className="hidden xl:flex w-56 shrink-0 flex-col gap-1 overflow-y-auto border-l border-border px-4 py-6"
      aria-label={t('knowledge:codeWiki.outline.label')}
      data-testid="code-wiki-outline"
    >
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-text-tertiary">
        {t('knowledge:codeWiki.outline.title')}
      </p>
      {headings.map(heading => (
        <button
          key={heading.id}
          type="button"
          onClick={() => jumpTo(heading.id)}
          data-testid={`code-wiki-outline-${heading.id}`}
          className={`truncate rounded px-2 py-1 text-left text-sm transition-colors ${
            heading.level === 3 ? 'pl-5' : ''
          } ${
            activeId === heading.id
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
