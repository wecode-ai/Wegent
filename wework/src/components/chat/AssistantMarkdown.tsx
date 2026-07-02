import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { FileText, Link2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  classifyMarkdownLink,
  getAuthenticatedImageFetchUrl,
  isAuthenticatedAttachmentImageSrc,
  resolveDirectMarkdownImageSrc,
  type MarkdownLinkTarget,
} from './assistantMarkdownLinks'
import { MarkdownCodeBlock } from './MarkdownCodeBlock'

const ASSISTANT_MARKDOWN_LINK_CLASS = [
  'inline-flex max-w-full items-center gap-1 rounded-md px-0.5 align-baseline',
  'text-[13px] font-medium leading-5 text-blue-600 no-underline',
  'transition-colors hover:text-blue-700',
  'dark:text-blue-300 dark:hover:text-blue-200',
  '[&_code]:!rounded-none [&_code]:!bg-transparent [&_code]:!px-0 [&_code]:!py-0 [&_code]:!font-[inherit] [&_code]:!text-inherit',
].join(' ')
const CODEX_PLAN_TAG_PATTERN = /<\/?\s*proposed_plan\s*>/gi

interface AssistantMarkdownProps {
  content: string
  onOpenFile?: (path: string) => void
}

export function AssistantMarkdown({ content, onOpenFile }: AssistantMarkdownProps) {
  const displayContent = normalizeAssistantMarkdownContent(content)

  return (
    <div className="assistant-markdown min-w-0 overflow-x-hidden break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 data-scroll-anchor className="mb-4 mt-6 text-lg font-semibold">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 data-scroll-anchor className="mb-3 mt-5 text-base font-semibold">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 data-scroll-anchor className="mb-2 mt-4 text-sm font-semibold">
              {children}
            </h3>
          ),
          p: ({ children }) => (
            <p data-scroll-anchor className="mb-3 min-w-0 break-words leading-6">
              {children}
            </p>
          ),
          ul: ({ children }) => <ul className="mb-3 list-disc space-y-1.5 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1.5 pl-8">{children}</ol>,
          li: ({ children }) => (
            <li data-scroll-anchor className="min-w-0 break-words pl-1 leading-6">
              {children}
            </li>
          ),
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          code: ({ className, children }) => {
            const match = /language-(\w*)/.exec(className || '')
            const isBlock = Boolean(match) || String(children).includes('\n')
            if (isBlock) {
              const lang = match ? match[1] || '' : ''
              return <MarkdownCodeBlock lang={lang}>{children}</MarkdownCodeBlock>
            }
            return (
              <code className="break-words rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-text-primary">
                {children}
              </code>
            )
          },
          pre: ({ children }) => <>{children}</>,
          blockquote: ({ children }) => (
            <blockquote
              data-scroll-anchor
              className="mb-3 border-l-3 border-border pl-4 text-text-secondary"
            >
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div data-scroll-anchor className="mb-3 max-w-full overflow-x-auto">
              <table className="w-full min-w-max border-collapse text-[13px]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-border px-3 py-2 text-left font-semibold">{children}</th>
          ),
          td: ({ children }) => <td className="border-b border-border px-3 py-2">{children}</td>,
          a: ({ href, children }) => (
            <AssistantMarkdownLink href={href} onOpenFile={onOpenFile}>
              {children}
            </AssistantMarkdownLink>
          ),
          img: ({ src, alt }) => <AssistantMarkdownImage src={src} alt={alt} />,
        }}
      >
        {displayContent}
      </ReactMarkdown>
    </div>
  )
}

function normalizeAssistantMarkdownContent(content: string): string {
  return content.replace(CODEX_PLAN_TAG_PATTERN, '')
}

function formatMarkdownLineLabel(target: Extract<MarkdownLinkTarget, { kind: 'file' }>): string {
  if (typeof target.lineStart !== 'number') return ''
  if (typeof target.lineEnd === 'number' && target.lineEnd !== target.lineStart) {
    return `lines ${target.lineStart}-${target.lineEnd}`
  }
  return `line ${target.lineStart}`
}

function formatMarkdownFileTooltip(target: Extract<MarkdownLinkTarget, { kind: 'file' }>): string {
  const lineLabel = formatMarkdownLineLabel(target)
  return lineLabel ? `${target.path} (${lineLabel})` : target.path
}

function getMarkdownFileIcon(path: string): ReactNode {
  if (/\.(?:json|jsonc)(?:[?#].*)?$/i.test(path)) {
    return (
      <span
        aria-hidden="true"
        className="shrink-0 font-mono text-[13px] font-semibold leading-5"
        data-testid="assistant-markdown-link-icon"
      >
        {'{}'}
      </span>
    )
  }

  if (/\.(?:sh|bash|zsh)(?:[?#].*)?$/i.test(path)) {
    return (
      <span
        aria-hidden="true"
        className="shrink-0 font-mono text-[13px] font-semibold leading-5"
        data-testid="assistant-markdown-link-icon"
      >
        $
      </span>
    )
  }

  return (
    <FileText
      aria-hidden="true"
      className="h-3.5 w-3.5 shrink-0"
      data-testid="assistant-markdown-link-icon"
    />
  )
}

function AssistantMarkdownLink({
  href,
  onOpenFile,
  children,
}: {
  href?: string
  onOpenFile?: (path: string) => void
  children?: ReactNode
}) {
  const target = classifyMarkdownLink(href)
  const icon =
    target.kind === 'file' ? (
      getMarkdownFileIcon(target.path)
    ) : (
      <Link2
        aria-hidden="true"
        className="h-3.5 w-3.5 shrink-0"
        data-testid="assistant-markdown-link-icon"
      />
    )

  if (target.kind === 'file') {
    const filePath = target.path
    const lineLabel = formatMarkdownLineLabel(target)
    const tooltip = formatMarkdownFileTooltip(target)
    return (
      <button
        type="button"
        className={`${ASSISTANT_MARKDOWN_LINK_CLASS} group/file-link relative`}
        data-testid="assistant-markdown-link"
        onClick={() => onOpenFile?.(filePath)}
        aria-label={tooltip}
      >
        {icon}
        {children}
        {lineLabel ? (
          <span className="shrink-0" data-testid="assistant-markdown-link-line">
            ({lineLabel})
          </span>
        ) : null}
        <span
          data-testid="assistant-markdown-link-tooltip"
          className="pointer-events-none absolute bottom-full left-0 z-30 mb-1 hidden w-max max-w-[min(36rem,calc(100vw-3rem))] whitespace-normal break-all rounded-xl border border-white/10 bg-[#2f2f2f] px-3 py-2 text-left text-[13px] font-normal leading-5 text-white shadow-lg group-hover/file-link:block group-focus-visible/file-link:block"
        >
          {tooltip}
        </span>
      </button>
    )
  }

  return (
    <a
      href={href}
      className={ASSISTANT_MARKDOWN_LINK_CLASS}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="assistant-markdown-link"
    >
      {icon}
      {children}
    </a>
  )
}

function AssistantMarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const rawSrc = typeof src === 'string' ? src.trim() : ''
  const [authenticatedPreview, setAuthenticatedPreview] = useState<{
    rawSrc: string
    url: string
  } | null>(null)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const isAuthenticatedSrc = rawSrc ? isAuthenticatedAttachmentImageSrc(rawSrc) : false
  const resolvedSrc = isAuthenticatedSrc
    ? authenticatedPreview?.rawSrc === rawSrc
      ? authenticatedPreview.url
      : null
    : rawSrc
      ? resolveDirectMarkdownImageSrc(rawSrc)
      : null
  const hasError = failedSrc === rawSrc

  useEffect(() => {
    let objectUrl: string | null = null
    let isMounted = true

    if (!rawSrc || !isAuthenticatedSrc) {
      return () => {
        isMounted = false
      }
    }

    async function loadAuthenticatedImage() {
      try {
        const token = localStorage.getItem('auth_token')
        const response = await fetch(getAuthenticatedImageFetchUrl(rawSrc), {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        })

        if (!response.ok) {
          throw new Error(`Failed to load markdown image: ${response.status}`)
        }

        const blob = await response.blob()
        if (!blob.type.startsWith('image/')) {
          throw new Error(`Markdown image response is not an image: ${blob.type || 'unknown'}`)
        }

        objectUrl = URL.createObjectURL(blob)
        if (isMounted) {
          setAuthenticatedPreview({ rawSrc, url: objectUrl })
        } else {
          URL.revokeObjectURL(objectUrl)
        }
      } catch {
        if (isMounted) {
          setFailedSrc(rawSrc)
        }
      }
    }

    void loadAuthenticatedImage()

    return () => {
      isMounted = false
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [isAuthenticatedSrc, rawSrc])

  if (hasError) {
    return (
      <span
        data-testid="assistant-markdown-image-error"
        className="my-2 inline-flex max-w-full rounded-xl border border-border bg-surface px-3 py-2 text-xs text-text-muted"
      >
        {alt || rawSrc}
      </span>
    )
  }

  if (!resolvedSrc) {
    return (
      <span
        data-testid="assistant-markdown-image-loading"
        className="my-2 inline-flex h-20 w-32 max-w-full items-center justify-center rounded-xl border border-border bg-surface text-xs text-text-muted"
      >
        {alt || 'Image'}
      </span>
    )
  }

  return (
    <img
      data-testid="assistant-markdown-image"
      data-scroll-anchor
      src={resolvedSrc}
      alt={alt || ''}
      className="my-2 block max-h-[360px] max-w-full rounded-xl border border-border bg-base object-contain"
      loading="lazy"
    />
  )
}
