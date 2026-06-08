import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Copy, CopyCheck, FileText, Loader2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Attachment } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import {
  getAttachmentImageUrl,
  getAttachmentTypeLabel,
  isImageAttachment,
} from '@/lib/attachments'
import { ToolBlocksDisplay } from './blocks/ToolBlocksDisplay'

interface MessageListProps {
  messages: WorkbenchMessage[]
}

export function MessageList({ messages }: MessageListProps) {
  if (messages.length === 0) {
    return null
  }

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-6 overflow-x-hidden px-6 py-8">
      {messages.map(message => (
        <article
          key={message.id}
          className={[
            'min-w-0 overflow-x-hidden',
            message.role === 'user' ? 'flex justify-end' : '',
          ].join(' ')}
          data-testid={`message-${message.role}`}
        >
          {message.role === 'user' ? (
            <UserMessage message={message} />
          ) : (
            <AssistantMessage message={message} />
          )}
        </article>
      ))}
    </div>
  )
}

function formatMessageTime(createdAt: string) {
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()

  return new Intl.DateTimeFormat(undefined, {
    ...(isToday ? {} : { weekday: 'short' as const }),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}

function UserMessage({ message }: { message: WorkbenchMessage }) {
  const imageAttachments = (message.attachments ?? []).filter(isImageAttachment)
  const documentAttachments = (message.attachments ?? []).filter(
    attachment => !isImageAttachment(attachment)
  )

  return (
    <div className="group flex max-w-[80%] flex-col items-end gap-1.5">
      {(imageAttachments.length > 0 || documentAttachments.length > 0) && (
        <div className="flex max-w-full flex-col items-end gap-2">
          {imageAttachments.map(attachment => (
            <MessageImageAttachmentPreview
              key={attachment.id}
              attachment={attachment}
            />
          ))}
          {documentAttachments.map(attachment => (
            <MessageDocumentAttachment
              key={attachment.id}
              attachment={attachment}
            />
          ))}
        </div>
      )}
      {message.content && (
        <div className="overflow-hidden break-words whitespace-pre-wrap rounded-2xl bg-muted px-4 py-3 text-[13px] leading-5 text-text-primary">
          {renderUserContent(message.content)}
        </div>
      )}
      <MessageHoverActions message={message} align="right" />
    </div>
  )
}

function MessageDocumentAttachment({ attachment }: { attachment: Attachment }) {
  const typeLabel = getAttachmentTypeLabel(attachment)

  return (
    <div
      data-testid="message-document-attachment"
      className="flex h-14 w-[220px] max-w-full items-center gap-3 rounded-2xl border border-border bg-base px-3 text-left text-xs text-text-secondary shadow-sm"
      aria-label={attachment.filename}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-50 text-[9px] font-semibold leading-none text-red-600">
        {typeLabel}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-text-primary">
          {attachment.filename}
        </span>
        <span className="truncate text-text-muted">{typeLabel}</span>
      </span>
    </div>
  )
}

function MessageImageAttachmentPreview({ attachment }: { attachment: Attachment }) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [hasError, setHasError] = useState(false)

  useEffect(() => {
    let isMounted = true
    let objectUrl: string | null = null

    async function loadPreview() {
      setPreviewUrl(null)
      setHasError(false)

      try {
        const token = localStorage.getItem('auth_token')
        const response = await fetch(getAttachmentImageUrl(attachment.id), {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        })

        if (!response.ok) {
          throw new Error(`Failed to load message attachment: ${response.status}`)
        }

        const blob = await response.blob()
        if (!blob.type.startsWith('image/')) {
          throw new Error(`Message attachment is not an image: ${blob.type || 'unknown'}`)
        }

        objectUrl = URL.createObjectURL(blob)
        if (isMounted) {
          setPreviewUrl(objectUrl)
        } else {
          URL.revokeObjectURL(objectUrl)
        }
      } catch {
        if (isMounted) {
          setHasError(true)
        }
      }
    }

    void loadPreview()

    return () => {
      isMounted = false
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [attachment.id])

  if (previewUrl) {
    return (
      <img
        data-testid="message-image-preview"
        src={previewUrl}
        alt={attachment.filename}
        className="block max-h-60 max-w-[240px] rounded-2xl border border-border bg-base object-contain"
      />
    )
  }

  return (
    <div
      data-testid={hasError ? 'message-image-preview-error' : 'message-image-preview-loading'}
      className="flex h-24 w-32 items-center justify-center rounded-2xl border border-border bg-surface text-text-muted"
      aria-label={attachment.filename}
    >
      {hasError ? <FileText className="h-5 w-5" /> : <Loader2 className="h-5 w-5 animate-spin" />}
    </div>
  )
}

function MessageHoverActions({
  message,
  align,
}: {
  message: WorkbenchMessage
  align: 'left' | 'right'
}) {
  const [copied, setCopied] = useState(false)
  const time = formatMessageTime(message.createdAt)

  const handleCopy = () => {
    void copyText(message.content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div
      className={[
        'flex min-h-6 items-center gap-1 text-xs text-text-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100',
        align === 'right' ? 'justify-end' : 'justify-start',
      ].join(' ')}
    >
      {time && (
        <span data-testid="message-hover-time" className="px-1">
          {time}
        </span>
      )}
      <button
        type="button"
        data-testid="copy-message-button"
        onClick={handleCopy}
        className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted opacity-0 transition-colors hover:bg-muted hover:text-text-secondary group-hover:opacity-100 group-focus:opacity-100 group-focus-within:opacity-100"
        aria-label={copied ? '已复制' : '复制消息'}
      >
        {copied ? (
          <CopyCheck className="h-3.5 w-3.5" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  )
}

const LOCAL_SKILL_LINK_PATTERN = /\[\$([^\]]+)]\((skill:\/\/[^)]+SKILL\.md)\)/g

function renderUserContent(content: string) {
  const parts: ReactNode[] = []
  let offset = 0

  for (const match of content.matchAll(LOCAL_SKILL_LINK_PATTERN)) {
    const start = match.index ?? 0
    const text = content.slice(offset, start)
    if (text) {
      parts.push(<span key={`text-${offset}`}>{text}</span>)
    }

    const skillName = match[1]
    const href = match[2]
    parts.push(
      <a
        key={`skill-${start}`}
        href={href}
        className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 font-medium text-text-primary underline decoration-text-muted"
        onClick={event => event.preventDefault()}
      >
        {`$${skillName}`}
      </a>,
    )
    offset = start + match[0].length
  }

  const remainingText = content.slice(offset)
  if (remainingText) {
    parts.push(<span key={`text-${offset}`}>{remainingText}</span>)
  }

  return parts
}

function AssistantMessage({ message }: { message: WorkbenchMessage }) {
  const hasBlocks = message.blocks && message.blocks.length > 0
  const hasContent = Boolean(message.content)
  const isStreaming = message.status === 'streaming'
  const shouldShowProcessing = hasBlocks || isStreaming

  return (
    <div className="group min-w-0 overflow-x-hidden text-[13px] leading-6 text-text-primary">
      {shouldShowProcessing && (
        <ToolBlocksDisplay
          blocks={message.blocks ?? []}
          isStreaming={isStreaming}
        />
      )}
      {hasContent && (
        <div className="assistant-markdown min-w-0 overflow-x-hidden break-words">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: ({ children }) => <h1 className="mb-4 mt-6 text-lg font-semibold">{children}</h1>,
              h2: ({ children }) => <h2 className="mb-3 mt-5 text-base font-semibold">{children}</h2>,
              h3: ({ children }) => <h3 className="mb-2 mt-4 text-sm font-semibold">{children}</h3>,
              p: ({ children }) => <p className="mb-3 min-w-0 break-words leading-6">{children}</p>,
              ul: ({ children }) => <ul className="mb-3 list-disc space-y-1.5 pl-5">{children}</ul>,
              ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1.5 pl-5">{children}</ol>,
              li: ({ children }) => <li className="min-w-0 break-words leading-6">{children}</li>,
              strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
              code: ({ className, children }) => {
                const isBlock = className?.includes('language-')
                if (isBlock) {
                  const lang = className?.replace('language-', '') ?? ''
                  return <CodeBlock lang={lang}>{children}</CodeBlock>
                }
                return (
                  <code className="break-words rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-text-primary">
                    {children}
                  </code>
                )
              },
              pre: ({ children }) => <pre className="mb-3 mt-2 max-w-full overflow-hidden">{children}</pre>,
              blockquote: ({ children }) => (
                <blockquote className="mb-3 border-l-3 border-border pl-4 text-text-secondary">
                  {children}
                </blockquote>
              ),
              table: ({ children }) => (
                <div className="mb-3 max-w-full overflow-x-auto">
                  <table className="w-full min-w-max border-collapse text-[13px]">{children}</table>
                </div>
              ),
              th: ({ children }) => (
                <th className="border-b border-border px-3 py-2 text-left font-semibold">{children}</th>
              ),
              td: ({ children }) => (
                <td className="border-b border-border px-3 py-2">{children}</td>
              ),
              a: ({ href, children }) => (
                <a href={href} className="break-words text-blue-600 underline" target="_blank" rel="noopener noreferrer">{children}</a>
              ),
            }}
          >
            {message.content}
          </ReactMarkdown>
        </div>
      )}
      {message.status === 'failed' && message.error && (
        <p className="mt-2 text-xs text-red-500">{message.error}</p>
      )}
      {message.status !== 'streaming' && (hasContent || message.status === 'failed') && (
        <MessageHoverActions message={message} align="left" />
      )}
    </div>
  )
}

function CodeBlock({ lang, children }: { lang: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false)
  const text = String(children).replace(/\n$/, '')

  const handleCopy = () => {
    void navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <code className="block max-w-full overflow-hidden rounded-lg border border-border">
      <span className="flex items-center justify-between border-b border-border bg-surface px-3 py-1.5">
        <span className="text-xs text-text-muted">{lang || 'text'}</span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleCopy}
            className="p-0.5 text-text-muted hover:text-text-secondary"
          >
            {copied ? (
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            )}
          </button>
        </span>
      </span>
      <span className="block max-w-full overflow-x-auto bg-base px-4 py-3 font-mono text-xs leading-5 text-text-primary">
        {children}
      </span>
    </code>
  )
}
