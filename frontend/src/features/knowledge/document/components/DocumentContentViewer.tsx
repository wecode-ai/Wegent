// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { createContext, useContext, useMemo, useCallback, useState } from 'react'
import type { ExtraProps } from 'react-markdown'
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
import {
  isImageDocument,
  InlineImageViewer,
} from '@/features/knowledge/multimodal/components/InlineImageViewer'
import { resolveWikiLink } from '../utils/wikiLinkResolver'
import type { KnowledgeDocument } from '@/types/knowledge'
import { resolveDocumentLinkPolicy } from '../utils/documentLinkPolicy'
import {
  createDocumentLinkResource,
  isDocumentFileLink,
  type DocumentLinkResource as LinkResource,
} from '../utils/documentLinkResource'
import { DocumentLinkResource } from './DocumentLinkResource'
import { DocumentLinkPreview } from './DocumentLinkPreview'
import { rehypeDocumentResources } from '../utils/rehypeDocumentResources'

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
const StandaloneResourceContext = createContext(false)
const documentResourcePlugins = [rehypeDocumentResources]

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
  const [selectedLinkResource, setSelectedLinkResource] = useState<LinkResource | null>(null)
  const linkPolicy = useMemo(() => resolveDocumentLinkPolicy(document), [document])

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

  // Detect image documents: render the original image above the (Gemini-extracted)
  // text content so the user can see both the picture and its multimodal analysis.
  const isImageDocType = isImageDocument(document)

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

  // Stable component types preserve in-flight previews on parent updates.
  const markdownComponents = useMemo(() => {
    const components = {
      p: function DocumentParagraph({
        node,
        children,
        ...props
      }: React.HTMLAttributes<HTMLParagraphElement> & ExtraProps) {
        const nodes = node?.children.filter(
          child => child.type !== 'text' || child.value.trim().length > 0
        )
        const child = nodes?.length === 1 ? nodes[0] : undefined
        const href =
          child?.type === 'element' && ['a', 'img'].includes(child.tagName)
            ? child.properties[child.tagName === 'img' ? 'src' : 'href']
            : undefined
        const standaloneFile =
          linkPolicy.policy !== 'legacy' && typeof href === 'string' && isDocumentFileLink(href)

        if (!standaloneFile) return <p {...props}>{children}</p>

        return (
          <StandaloneResourceContext.Provider value>
            <div {...props}>{children}</div>
          </StandaloneResourceContext.Provider>
        )
      },
      a: function DocumentAnchor({
        href,
        children,
        node: _node,
        ...props
      }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
        children?: React.ReactNode
      } & ExtraProps) {
        const standalone = useContext(StandaloneResourceContext)
        if (!href) {
          return <a {...props}>{children}</a>
        }
        const isExternalUrl = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)
        const isAnchor = href.startsWith('#')
        const isWikiLink = !isExternalUrl && !isAnchor

        const isRestrictedFile =
          linkPolicy.policy !== 'legacy' && !isAnchor && isDocumentFileLink(href)
        if (isRestrictedFile) {
          const resource = createDocumentLinkResource(document.id, href)
          if (!resource || linkPolicy.policy === 'unavailable') {
            return (
              <span
                className="mx-0.5 inline-flex min-h-11 items-center rounded-md border border-border bg-surface px-2.5 py-1.5 text-text-muted"
                data-testid="document-link-preview-unavailable"
              >
                {children}
              </span>
            )
          }
          return (
            <DocumentLinkResource
              resource={resource}
              onOpen={setSelectedLinkResource}
              inline={!standalone}
            >
              {children}
            </DocumentLinkResource>
          )
        }

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
            data-testid="knowledge-document-wiki-link"
          >
            {children}
          </button>
        )
      },
      img: function DocumentImage({
        src,
        alt,
        node: _node,
        ...props
      }: React.ImgHTMLAttributes<HTMLImageElement> & ExtraProps) {
        const standalone = useContext(StandaloneResourceContext)
        if (linkPolicy.policy === 'legacy' || typeof src !== 'string') {
          // eslint-disable-next-line @next/next/no-img-element
          return <img {...props} src={src} alt={alt || ''} />
        }
        const resource = createDocumentLinkResource(document.id, src, alt)
        if (!resource || linkPolicy.policy === 'unavailable') {
          return (
            <span
              className="inline-flex min-h-11 items-center rounded-md border border-border bg-surface px-2.5 py-1.5 text-text-muted"
              data-testid="document-link-preview-unavailable"
            >
              {alt || t('document.document.detail.linkPreview.unavailable')}
            </span>
          )
        }
        return (
          <DocumentLinkResource
            resource={resource}
            onOpen={setSelectedLinkResource}
            inline={!standalone}
          />
        )
      },
      ...(linkPolicy.policy !== 'legacy'
        ? {
            iframe: () => <BlockedEmbeddedResource />,
            object: () => <BlockedEmbeddedResource />,
            embed: () => <BlockedEmbeddedResource />,
            video: () => <BlockedEmbeddedResource />,
            source: () => null,
          }
        : {}),
    }
    // Preserve the shared Markdown renderers for every non-DingTalk source.
    return linkPolicy.policy === 'legacy' ? { a: components.a } : components
  }, [document.id, linkPolicy.policy, handleWikiLinkClick, t])

  const renderMarkdown = () => (
    <EnhancedMarkdown
      source={content}
      theme={theme}
      components={markdownComponents}
      rehypePlugins={linkPolicy.policy === 'preview-only' ? documentResourcePlugins : undefined}
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
    // Image documents show the picture even when extracted text is empty.
    if (isImageDocType) {
      return (
        <InlineImageViewer
          document={document}
          className="p-4 bg-surface rounded-lg border border-border"
        />
      )
    }
    return (
      <div className="p-4 bg-surface rounded-lg border border-border text-center text-sm text-text-muted">
        {t('document.document.detail.noContent')}
      </div>
    )
  }

  return (
    <div className="p-4 bg-surface rounded-lg border border-border">
      {/* Image document: show the original image above the extracted text content */}
      <InlineImageViewer
        document={document}
        className="mb-4 rounded-lg border border-border bg-surface p-2 flex justify-center"
      />
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
      {linkPolicy.policy === 'preview-only' && (
        <DocumentLinkPreview
          resource={selectedLinkResource}
          onOpenChange={open => {
            if (!open) setSelectedLinkResource(null)
          }}
        />
      )}
    </div>
  )
}

function BlockedEmbeddedResource() {
  const { t } = useTranslation('knowledge')
  return (
    <span className="inline-flex min-h-11 items-center rounded-md border border-border bg-surface px-2.5 py-1.5 text-text-muted">
      {t('document.document.detail.linkPreview.embeddedBlocked')}
    </span>
  )
}
