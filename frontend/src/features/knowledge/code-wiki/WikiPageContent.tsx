// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import { Spinner } from '@/components/ui/spinner'
import { useTheme } from '@/features/theme/ThemeProvider'
import { useTranslation } from '@/hooks/useTranslation'
import { readDocumentText } from '@/apis/knowledge'
import type { CodeWikiPageNode } from '@/types/code-wiki'
import { resolvePageLink } from './pageLinks'

const EnhancedMarkdown = dynamic(() => import('@/components/common/EnhancedMarkdown'), {
  ssr: false,
})

const EXTERNAL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

interface WikiPageContentProps {
  page: CodeWikiPageNode | null
  onContentChange: (markdown: string) => void
  /** Every page path in this wiki, for deciding whether a link has a target. */
  knownPaths: ReadonlySet<string>
  /** Open another page of this wiki. */
  onNavigate: (path: string) => void
}

/**
 * One page's body.
 *
 * Rendered through `EnhancedMarkdown`, the same component the knowledge base document
 * viewer uses — which handles Mermaid with a fallback to the raw source when a diagram
 * will not render. The old wiki reader had its own parallel implementation of that,
 * including a Mermaid component with no error handling at all.
 *
 * Links between pages are wired here. `EnhancedMarkdown` does not resolve them — the
 * document viewer passes it an `a` component of its own — and a comment here once
 * claimed it did, which is why a link to another wiki page navigated the browser by
 * the current route instead of opening the page.
 */
export function WikiPageContent({
  page,
  onContentChange,
  knownPaths,
  onNavigate,
}: WikiPageContentProps) {
  const { t } = useTranslation('knowledge')
  const { theme } = useTheme()
  const [markdown, setMarkdown] = useState('')
  const [loading, setLoading] = useState(false)
  const currentPath = page?.path ?? ''

  useEffect(() => {
    if (!page?.document_id) {
      setMarkdown('')
      onContentChange('')
      return
    }

    let cancelled = false
    setLoading(true)
    readDocumentText(page.document_id)
      .then(body => {
        if (cancelled) return
        setMarkdown(body)
        onContentChange(body)
      })
      .catch(() => {
        if (!cancelled) {
          setMarkdown('')
          onContentChange('')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [page?.document_id, onContentChange])

  const components = useMemo(
    () => ({
      a: ({
        href,
        children,
        ...props
      }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { children?: React.ReactNode }) => {
        const target = href ? resolvePageLink(href, knownPaths, currentPath) : null
        if (target) {
          return (
            <button
              type="button"
              onClick={() => onNavigate(target)}
              data-testid="wiki-page-link"
              className="font-inherit inline cursor-pointer border-none bg-transparent p-0 text-primary hover:underline"
            >
              {children}
            </button>
          )
        }

        // An internal link with no page behind it: a path the agent invented, or one
        // whose page it never wrote. Shown as visibly dead rather than left clickable,
        // because following it would navigate out of the wiki by the current route.
        if (href && !EXTERNAL_SCHEME.test(href) && !href.startsWith('#')) {
          return (
            <span
              data-testid="wiki-page-link-broken"
              title={t('codeWiki.reader.linkNotFound')}
              className="text-text-tertiary underline decoration-dotted"
            >
              {children}
            </span>
          )
        }

        return (
          <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
            {children}
          </a>
        )
      },
    }),
    [knownPaths, currentPath, onNavigate, t]
  )

  if (!page) return null

  if (!page.has_content) {
    return (
      <p className="py-16 text-center text-sm text-text-tertiary">
        {t('codeWiki.reader.sectionOnly')}
      </p>
    )
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    )
  }

  return (
    <article
      className="prose prose-sm max-w-none dark:prose-invert"
      data-testid="wiki-page-content"
    >
      <EnhancedMarkdown
        source={markdown}
        theme={theme === 'dark' ? 'dark' : 'light'}
        components={components}
      />
    </article>
  )
}
