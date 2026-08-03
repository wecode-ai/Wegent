// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { Spinner } from '@/components/ui/spinner'
import { useTheme } from '@/features/theme/ThemeProvider'
import { useTranslation } from '@/hooks/useTranslation'
import { getDocumentContent } from '@/apis/knowledge'
import type { CodeWikiPageNode } from '@/types/code-wiki'

const EnhancedMarkdown = dynamic(() => import('@/components/common/EnhancedMarkdown'), {
  ssr: false,
})

interface WikiPageContentProps {
  page: CodeWikiPageNode | null
  onContentChange: (markdown: string) => void
}

/**
 * One page's body.
 *
 * Rendered through `EnhancedMarkdown`, the same component the knowledge base
 * document viewer uses — which already handles Mermaid with a fallback to the raw
 * source when a diagram will not render, and resolves wiki links. The old wiki
 * reader had its own parallel implementation of all of it, including a Mermaid
 * component with no error handling at all.
 */
export function WikiPageContent({ page, onContentChange }: WikiPageContentProps) {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const [markdown, setMarkdown] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!page?.document_id) {
      setMarkdown('')
      onContentChange('')
      return
    }

    let cancelled = false
    setLoading(true)
    getDocumentContent(page.document_id, 0, 1)
      .then(response => {
        if (cancelled) return
        const body = response.content ?? ''
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

  if (!page) return null

  if (!page.has_content) {
    return (
      <p className="py-16 text-center text-sm text-text-tertiary">
        {t('knowledge:codeWiki.reader.sectionOnly')}
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
      <EnhancedMarkdown source={markdown} theme={theme === 'dark' ? 'dark' : 'light'} />
    </article>
  )
}
