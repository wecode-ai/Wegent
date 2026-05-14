// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { useTheme } from '@/features/theme/ThemeProvider'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  isJsonFileExtension,
  isMarkdownFileExtension,
  looksLikeJson,
  formatJsonContent,
  containsMarkdownSyntax,
} from '@/utils/languageDetection'
import { resolveWikiLink } from '../utils/wikiLinkResolver'
import type { KnowledgeDocument } from '@/types/knowledge'

// Dynamically import EnhancedMarkdown for markdown preview
const EnhancedMarkdown = dynamic(() => import('@/components/common/EnhancedMarkdown'), {
  ssr: false,
  loading: () => (
    <div className="min-h-[100px] animate-pulse rounded-lg bg-surface flex items-center justify-center">
      <Spinner />
    </div>
  ),
})

type ViewMode = 'preview' | 'raw'

interface DocumentContentViewerProps {
  content: string
  document: KnowledgeDocument
  knowledgeBaseId: number
  knowledgeBaseName: string
  knowledgeBaseNamespace: string
  isOrganization: boolean
  viewMode: ViewMode
  hasMoreContent: boolean
  loadingMore: boolean
  contentLength?: number
  onLoadMore: () => void
  onOpenChange: (open: boolean) => void
}

export function DocumentContentViewer({
  content,
  document,
  knowledgeBaseId,
  knowledgeBaseName,
  knowledgeBaseNamespace,
  isOrganization,
  viewMode,
  hasMoreContent,
  loadingMore,
  contentLength,
  onLoadMore,
  onOpenChange,
}: DocumentContentViewerProps) {
  const { t } = useTranslation('knowledge')
  const { theme } = useTheme()
  const router = useRouter()

  // Check if content is JSON
  const isJsonContent = useMemo(() => {
    if (!content) return false
    return isJsonFileExtension(document?.file_extension) || looksLikeJson(content)
  }, [content, document?.file_extension])

  // Format JSON content for display
  const formattedJsonContent = useMemo(() => {
    if (!isJsonContent || !content) return null
    return formatJsonContent(content)
  }, [isJsonContent, content])

  // Check if content should be rendered as markdown
  const isMarkdownContent = useMemo(() => {
    if (!content) return false
    return isMarkdownFileExtension(document?.file_extension) || containsMarkdownSyntax(content)
  }, [content, document?.file_extension])

  // Handle wiki link clicks
  const handleWikiLinkClick = useCallback(
    async (href: string) => {
      const url = await resolveWikiLink(
        href,
        knowledgeBaseId,
        document.name,
        knowledgeBaseName,
        knowledgeBaseNamespace,
        isOrganization
      )
      if (url) {
        router.push(url)
        onOpenChange(false)
      } else {
        toast.error(
          t('document.document.detail.linkNotFound', {
            defaultValue: `Knowledge base not found: ${href}`,
          })
        )
      }
    },
    [
      knowledgeBaseId,
      document.name,
      knowledgeBaseName,
      knowledgeBaseNamespace,
      isOrganization,
      router,
      onOpenChange,
      t,
    ]
  )

  // Render markdown content
  const renderMarkdown = () => (
    <EnhancedMarkdown
      source={content}
      theme={theme}
      components={{
        a: ({
          href,
          children,
          ...props
        }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
          children?: React.ReactNode
        }) => {
          if (!href) {
            return <a {...props}>{children}</a>
          }
          const isExternalUrl = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)
          const isAnchor = href.startsWith('#')
          const isWikiLink = !isExternalUrl && !isAnchor

          if (!isWikiLink) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
                {...props}
              >
                {children}
              </a>
            )
          }

          return (
            <button
              type="button"
              onClick={e => {
                e.preventDefault()
                handleWikiLinkClick(href)
              }}
              className="text-primary hover:underline cursor-pointer inline bg-transparent border-none p-0 font-inherit"
              title={decodeURIComponent(href)}
            >
              {children}
            </button>
          )
        },
      }}
    />
  )

  // Render raw/plain content
  const renderRaw = () => {
    const displayContent =
      isJsonContent && viewMode === 'preview' && formattedJsonContent
        ? formattedJsonContent
        : content

    return (
      <pre className="text-xs text-text-secondary whitespace-pre-wrap break-words font-mono leading-relaxed">
        {displayContent}
      </pre>
    )
  }

  if (!content) {
    return (
      <div className="p-4 bg-surface rounded-lg border border-border text-center text-sm text-text-muted">
        {t('document.document.detail.noContent')}
      </div>
    )
  }

  return (
    <div className="p-4 bg-white rounded-lg border border-border">
      {/* Content display */}
      {isMarkdownContent && viewMode === 'preview' ? renderMarkdown() : renderRaw()}

      {/* Footer with length info and load more button */}
      <div className="mt-3 pt-3 border-t border-border text-xs text-text-muted flex items-center justify-between">
        <span>
          {contentLength !== undefined && (
            <>
              {t('document.document.detail.contentLength')}: {content.length.toLocaleString()}
              {hasMoreContent && contentLength > content.length
                ? ` / ${contentLength.toLocaleString()}`
                : ''}{' '}
              {t('document.document.detail.characters')}
            </>
          )}
        </span>

        {hasMoreContent && (
          <Button
            variant="outline"
            size="sm"
            onClick={onLoadMore}
            disabled={loadingMore}
            data-testid="load-more-button"
            className="h-11 min-w-[44px]"
          >
            {loadingMore ? (
              <>
                <Spinner className="w-3 h-3 mr-1" />
                {t('document.document.detail.loadingMore', {
                  defaultValue: 'Loading...',
                })}
              </>
            ) : (
              <>{t('document.document.detail.loadMore', { defaultValue: 'Load More' })}</>
            )}
          </Button>
        )}
      </div>
    </div>
  )
}
