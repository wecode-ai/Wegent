import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Copy,
  CopyCheck,
  Link2,
  Package,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Attachment, DeviceInfo, TurnFileChangesSummary } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import type { ProcessingBlock, WorkbenchMessage } from '@/types/workbench'
import { getAttachmentImageUrl, getAttachmentTypeLabel, isImageAttachment } from '@/lib/attachments'
import { parseChatError } from '@/lib/chat-error'
import { isIMSource } from '@/lib/im-source'
import { ImSourceBadge } from '@/components/common/ImSourceBadge'
import { AttachmentImagePreview } from './AttachmentImagePreview'
import { ToolBlocksDisplay } from './blocks/ToolBlocksDisplay'
import { FileChangesCard } from './FileChangesCard'

interface MessageListProps {
  messages: WorkbenchMessage[]
  isWaitingForAssistant?: boolean
  devices?: DeviceInfo[]
  onRetryFailedMessage?: (message: WorkbenchMessage) => void
  onSwitchModelForFailedMessage?: (message: WorkbenchMessage) => void
  onLoadFileChangesDiff?: (subtaskId: number) => Promise<string>
  onRevertFileChanges?: (subtaskId: number) => Promise<TurnFileChangesSummary>
  onOpenFileChangesReview?: (request: {
    subtaskId: number
    loadDiff: () => Promise<string>
    reviewTitle?: string
    defaultFileTreeVisible?: boolean
    focusFilePath?: string
  }) => void
  onOpenWorkspaceFile?: (path: string) => void
}

const USER_MESSAGE_COLLAPSE_LINES = 10
const USER_MESSAGE_COLLAPSE_CHARACTERS = 600
const ATTACHMENT_DOWNLOAD_PATH_PATTERN = /\/(?:api\/)?attachments\/(\d+)\/download(?:[?#].*)?$/
const CODEX_FILE_MENTIONS_HEADER_PATTERN = /^\s*# Files mentioned by the user:\s*/i
const CODEX_REQUEST_MARKER_PATTERN = /^## My request for Codex:\s*$/im
const CODEX_FILE_MENTION_LINE_PATTERN = /^##\s+(.+?):\s+(.+)$/gm
const LOCAL_IMAGE_EXTENSION_PATTERN = /\.(?:apng|avif|gif|jpe?g|png|webp|bmp|svg)$/i
const ASSISTANT_MARKDOWN_LINK_CLASS = [
  'inline-flex max-w-full items-center gap-1 rounded-md px-0.5 align-baseline',
  'text-[13px] font-medium leading-5 text-blue-600 no-underline',
  'transition-colors hover:text-blue-700',
  'dark:text-blue-300 dark:hover:text-blue-200',
].join(' ')

export function MessageList({
  messages,
  isWaitingForAssistant = false,
  devices = [],
  onRetryFailedMessage,
  onSwitchModelForFailedMessage,
  onLoadFileChangesDiff,
  onRevertFileChanges,
  onOpenFileChangesReview,
  onOpenWorkspaceFile,
}: MessageListProps) {
  const visibleMessages = messages.filter(shouldRenderMessage)
  const shouldShowWaitingIndicator =
    isWaitingForAssistant &&
    !messages.some(message => message.role === 'assistant' && message.status === 'streaming')

  if (visibleMessages.length === 0 && !shouldShowWaitingIndicator) {
    return null
  }

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4 overflow-x-hidden px-6 py-2">
      {visibleMessages.map(message => (
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
            <AssistantMessage
              message={message}
              devices={devices}
              onRetryFailedMessage={onRetryFailedMessage}
              onSwitchModelForFailedMessage={onSwitchModelForFailedMessage}
              onLoadFileChangesDiff={onLoadFileChangesDiff}
              onRevertFileChanges={onRevertFileChanges}
              onOpenFileChangesReview={onOpenFileChangesReview}
              onOpenWorkspaceFile={onOpenWorkspaceFile}
            />
          )}
        </article>
      ))}
      {shouldShowWaitingIndicator && (
        <article className="min-w-0 overflow-x-hidden" data-testid="message-assistant-waiting">
          <WaitingAssistantIndicator />
        </article>
      )}
    </div>
  )
}

function shouldRenderMessage(message: WorkbenchMessage): boolean {
  if (message.role !== 'assistant') return true
  if (message.status === 'streaming' || message.status === 'failed') return true
  if (message.fileChanges) return true

  const visibleContent = shouldHideFailedAssistantContent(message) ? '' : message.content
  if (visibleContent.trim()) return true

  return getDisplayProcessingBlocks(message.blocks, visibleContent).length > 0
}

function WaitingAssistantIndicator() {
  const { t } = useTranslation('chat')

  return (
    <div className="inline-flex items-center text-[13px]" data-testid="thinking-indicator">
      <span className="waiting-thinking-text">{t('thinking.running')}</span>
    </div>
  )
}

function getTurnStartMs(createdAt: string): number | undefined {
  const ms = new Date(createdAt).getTime()
  return Number.isFinite(ms) ? ms : undefined
}

function formatCompactDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000))
  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`

  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

function getStoppedElapsedDuration(message: WorkbenchMessage): string {
  const startedAt = getTurnStartMs(message.createdAt)
  if (startedAt === undefined) return '0s'

  const blockEndTimes =
    message.blocks
      ?.map(block => block.createdAt)
      .filter((createdAt): createdAt is number => Number.isFinite(createdAt)) ?? []
  const endedAt = blockEndTimes.length > 0 ? Math.max(...blockEndTimes) : startedAt

  return formatCompactDuration(endedAt - startedAt)
}

function isCancelledAssistantMessage(message: WorkbenchMessage): boolean {
  return message.runtimeStatus === 'cancelled'
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
  const [isExpanded, setIsExpanded] = useState(false)
  const codexLocalFileMentions = parseCodexLocalFileMentions(message.content)
  const displayContent = codexLocalFileMentions?.requestText ?? message.content
  const imageAttachments = (message.attachments ?? []).filter(isImageAttachment)
  const documentAttachments = (message.attachments ?? []).filter(
    attachment => !isImageAttachment(attachment)
  )
  const localImageMentions =
    imageAttachments.length > 0 ? [] : (codexLocalFileMentions?.images ?? [])
  const shouldCollapse =
    displayContent.length > USER_MESSAGE_COLLAPSE_CHARACTERS ||
    displayContent.split('\n').length > USER_MESSAGE_COLLAPSE_LINES
  const showSourceBadge = isIMSource(message.source)

  return (
    <div className="group flex max-w-[80%] flex-col items-end gap-1.5">
      {(imageAttachments.length > 0 ||
        localImageMentions.length > 0 ||
        documentAttachments.length > 0) && (
        <div className="flex max-w-full flex-col items-end gap-2">
          {(imageAttachments.length > 0 || localImageMentions.length > 0) && (
            <div
              data-testid="message-image-attachments"
              className="flex max-w-full flex-row flex-wrap justify-end gap-2"
            >
              {imageAttachments.map(attachment => (
                <MessageImageAttachmentPreview key={attachment.id} attachment={attachment} />
              ))}
              {localImageMentions.map(image => (
                <MessageLocalImagePreview key={image.path} image={image} />
              ))}
            </div>
          )}
          {documentAttachments.map(attachment => (
            <MessageDocumentAttachment key={attachment.id} attachment={attachment} />
          ))}
        </div>
      )}
      {displayContent && (
        <div className="max-w-full overflow-hidden rounded-2xl bg-muted text-[13px] leading-5 text-text-primary">
          <div
            data-testid="user-message-content"
            className={[
              'relative overflow-hidden break-words whitespace-pre-wrap bg-muted px-4 py-3',
              shouldCollapse && !isExpanded ? 'max-h-44' : '',
            ].join(' ')}
          >
            {renderUserContent(displayContent)}
            {shouldCollapse && !isExpanded && (
              <span className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-muted to-transparent" />
            )}
          </div>
          {shouldCollapse && (
            <button
              type="button"
              data-testid="toggle-user-message-button"
              aria-expanded={isExpanded}
              onClick={() => setIsExpanded(value => !value)}
              className="flex h-9 w-full items-center justify-center gap-1 border-t border-border/60 text-xs font-medium text-text-secondary transition-colors hover:bg-surface"
            >
              {isExpanded ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
              {isExpanded ? '收起' : '展开'}
            </button>
          )}
        </div>
      )}
      {showSourceBadge && (
        <div
          data-testid="message-source-row"
          className="flex min-h-5 items-center justify-end gap-1"
        >
          <ImSourceBadge source={message.source} testId="message-source-badge" />
        </div>
      )}
      <MessageHoverActions message={message} align="right" />
    </div>
  )
}

function MessageLocalImagePreview({ image }: { image: { filename: string; path: string } }) {
  const [hasLoadError, setHasLoadError] = useState(false)
  const imageSrc = resolveDirectMarkdownImageSrc(image.path)
  if (!imageSrc || hasLoadError) return null

  return (
    <img
      data-testid="message-local-image-preview"
      src={imageSrc}
      alt={image.filename}
      className="block max-h-36 max-w-[180px] shrink-0 rounded-xl border border-border bg-base object-contain"
      loading="lazy"
      onError={() => setHasLoadError(true)}
    />
  )
}

function parseCodexLocalFileMentions(
  content: string
): { requestText: string; images: Array<{ filename: string; path: string }> } | null {
  if (!CODEX_FILE_MENTIONS_HEADER_PATTERN.test(content)) return null

  const requestMarker = content.match(CODEX_REQUEST_MARKER_PATTERN)
  const requestText =
    requestMarker?.index === undefined
      ? ''
      : content.slice(requestMarker.index + requestMarker[0].length).trim()
  if (!requestText) return null

  const filesText =
    requestMarker?.index === undefined ? content : content.slice(0, requestMarker.index)
  const images: Array<{ filename: string; path: string }> = []
  for (const match of filesText.matchAll(CODEX_FILE_MENTION_LINE_PATTERN)) {
    const filename = match[1]?.trim()
    const path = match[2]?.trim()
    if (!filename || !path || !isLocalImageMention(filename, path)) continue
    images.push({ filename, path })
  }

  return { requestText, images }
}

function isLocalImageMention(filename: string, path: string): boolean {
  return LOCAL_IMAGE_EXTENSION_PATTERN.test(filename) || LOCAL_IMAGE_EXTENSION_PATTERN.test(path)
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
        <span className="truncate font-medium text-text-primary">{attachment.filename}</span>
        <span className="truncate text-text-muted">{typeLabel}</span>
      </span>
    </div>
  )
}

function MessageImageAttachmentPreview({ attachment }: { attachment: Attachment }) {
  return (
    <AttachmentImagePreview
      attachment={attachment}
      buttonTestId="message-image-preview-button"
      imageTestId="message-image-preview"
      loadingTestId="message-image-preview-loading"
      errorTestId="message-image-preview-error"
      imageClassName="block max-h-36 max-w-[180px] shrink-0 rounded-xl border border-border bg-base object-contain"
      placeholderClassName="flex h-20 w-28 shrink-0 items-center justify-center rounded-xl border border-border bg-surface text-text-muted"
    />
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
        'flex min-h-5 items-center gap-1 text-xs text-text-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100',
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
        {copied ? <CopyCheck className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  )
}

const LOCAL_SKILL_LINK_PATTERN = /\[\$([^\]]+)]\(((?:skill:\/\/|\/)[^)]+\/SKILL\.md)\)/g

function localSkillTokenTestId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-')
}

function displayLocalSkillName(name: string): string {
  if (name.includes(':')) return `$${name}`

  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

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
        data-testid={`sent-local-skill-token-${localSkillTokenTestId(skillName)}`}
        className="inline-flex h-7 max-w-full items-center gap-1 rounded-xl bg-muted px-2 align-baseline text-[13px] font-medium leading-none text-blue-600 no-underline"
        onClick={event => event.preventDefault()}
      >
        <Package
          data-testid={`sent-local-skill-icon-${localSkillTokenTestId(skillName)}`}
          className="h-3.5 w-3.5 shrink-0 text-blue-600"
        />
        <span className="min-w-0 truncate">{displayLocalSkillName(skillName)}</span>
      </a>
    )
    offset = start + match[0].length
  }

  const remainingText = content.slice(offset)
  if (remainingText) {
    parts.push(<span key={`text-${offset}`}>{remainingText}</span>)
  }

  return parts
}

const RAW_FAILED_MESSAGE_PATTERNS = [
  /^\$\{thinking\.[^}]+}/i,
  /^api error:/i,
  /^task failed/i,
  /^error:/i,
  /"error"\s*:/i,
  /"error_(type|code)"\s*:/i,
  /\b(status|type)\s*:\s*failed\b/i,
]

function shouldHideFailedAssistantContent(message: WorkbenchMessage) {
  if (message.status !== 'failed' || !message.error) return false

  const content = message.content.trim()
  const error = message.error.trim()
  if (!content) return false
  if (content === error) return true

  return RAW_FAILED_MESSAGE_PATTERNS.some(pattern => pattern.test(content))
}

function normalizeTextForComparison(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function getDisplayProcessingBlocks(
  blocks: ProcessingBlock[] | undefined,
  visibleContent: string
): ProcessingBlock[] {
  if (!blocks?.length) return []

  const normalizedVisibleContent = normalizeTextForComparison(visibleContent)

  return blocks.filter(block => {
    if (block.type !== 'text') return true

    const normalizedBlockContent = normalizeTextForComparison(block.content)
    if (!normalizedBlockContent) return false

    return normalizedBlockContent !== normalizedVisibleContent
  })
}

function getAttachmentDownloadId(src: string): number | null {
  try {
    const url = new URL(src)
    const match = url.pathname.match(ATTACHMENT_DOWNLOAD_PATH_PATTERN)
    return match ? Number(match[1]) : null
  } catch {
    const match = src.match(ATTACHMENT_DOWNLOAD_PATH_PATTERN)
    return match ? Number(match[1]) : null
  }
}

function isAuthenticatedAttachmentImageSrc(src: string): boolean {
  return getAttachmentDownloadId(src) !== null
}

function getAuthenticatedImageFetchUrl(src: string): string {
  if (src.startsWith('/api/')) return src
  if (/^https?:\/\//i.test(src)) return src

  const attachmentId = getAttachmentDownloadId(src)
  return attachmentId === null ? src : getAttachmentImageUrl(attachmentId)
}

function isLocalImagePath(src: string): boolean {
  if (src.startsWith('file://')) return true
  if (/^[a-zA-Z]:[\\/]/.test(src)) return true

  return src.startsWith('/') && !isAuthenticatedAttachmentImageSrc(src)
}

type MarkdownLinkTarget = { kind: 'external' } | { kind: 'none' } | { kind: 'file'; path: string }

// Assistant responses frequently reference repository files with relative or
// absolute filesystem paths. Rendering those as plain anchors makes the browser
// navigate the SPA to a broken `http://localhost/...` URL, so file links are
// routed to the caller (the previous-turn diff review when available, otherwise
// the workspace file panel) instead.
function classifyMarkdownLink(href?: string): MarkdownLinkTarget {
  const value = href?.trim()
  if (!value) return { kind: 'none' }
  if (/^(https?|mailto|tel):/i.test(value)) return { kind: 'external' }
  if (value.startsWith('#')) return { kind: 'none' }
  if (value.startsWith('file://')) {
    return { kind: 'file', path: localPathFromMarkdownImageSrc(value) }
  }
  return { kind: 'file', path: value }
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
  const icon = (
    <Link2
      aria-hidden="true"
      className="h-3.5 w-3.5 shrink-0"
      data-testid="assistant-markdown-link-icon"
    />
  )

  if (target.kind === 'file') {
    const filePath = target.path
    return (
      <button
        type="button"
        className={ASSISTANT_MARKDOWN_LINK_CLASS}
        data-testid="assistant-markdown-link"
        onClick={() => onOpenFile?.(filePath)}
      >
        {icon}
        {children}
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

function localPathFromMarkdownImageSrc(src: string): string {
  if (!src.startsWith('file://')) return src

  try {
    const pathname = decodeURIComponent(new URL(src).pathname)
    return pathname.match(/^\/[a-zA-Z]:\//) ? pathname.slice(1) : pathname
  } catch {
    return src
  }
}

function resolveDirectMarkdownImageSrc(src: string): string | null {
  if (!isLocalImagePath(src)) return src

  const localPath = localPathFromMarkdownImageSrc(src)
  if (typeof convertFileSrc !== 'function') return null

  try {
    return convertFileSrc(localPath)
  } catch {
    return null
  }
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
      src={resolvedSrc}
      alt={alt || ''}
      className="my-2 block max-h-[360px] max-w-full rounded-xl border border-border bg-base object-contain"
      loading="lazy"
    />
  )
}

function AssistantMessage({
  message,
  devices,
  onRetryFailedMessage,
  onSwitchModelForFailedMessage,
  onLoadFileChangesDiff,
  onRevertFileChanges,
  onOpenFileChangesReview,
  onOpenWorkspaceFile,
}: {
  message: WorkbenchMessage
  devices: DeviceInfo[]
  onRetryFailedMessage?: (message: WorkbenchMessage) => void
  onSwitchModelForFailedMessage?: (message: WorkbenchMessage) => void
  onLoadFileChangesDiff?: (subtaskId: number) => Promise<string>
  onRevertFileChanges?: (subtaskId: number) => Promise<TurnFileChangesSummary>
  onOpenFileChangesReview?: (request: {
    subtaskId: number
    loadDiff: () => Promise<string>
    reviewTitle?: string
    defaultFileTreeVisible?: boolean
    focusFilePath?: string
  }) => void
  onOpenWorkspaceFile?: (path: string) => void
}) {
  const { t } = useTranslation('chat')
  const isCancelled = isCancelledAssistantMessage(message)
  const shouldHideContent = isCancelled || shouldHideFailedAssistantContent(message)
  const visibleContent = shouldHideContent ? '' : message.content
  const hiddenErrorContent = shouldHideContent && !isCancelled ? message.content.trim() : undefined
  const displayBlocks = getDisplayProcessingBlocks(message.blocks, visibleContent)
  const hasBlocks = displayBlocks.length > 0
  const hasVisibleContent = Boolean(visibleContent.trim())
  const isStreaming = message.status === 'streaming'
  const shouldShowCompactThinking = isStreaming && !hasBlocks && !hasVisibleContent

  // A file referenced in the response usually belongs to this turn's changes, so
  // route the link into the previous-turn diff review focused on that file. When
  // the turn has no recorded changes, fall back to the workspace file panel.
  const fileChangesSubtaskId = message.fileChanges ? message.subtaskId : undefined
  const openFileFromLink = (path: string) => {
    if (fileChangesSubtaskId && onLoadFileChangesDiff && onOpenFileChangesReview) {
      onOpenFileChangesReview({
        subtaskId: fileChangesSubtaskId,
        loadDiff: () => onLoadFileChangesDiff(fileChangesSubtaskId),
        reviewTitle: t('file_changes.previous_turn_label'),
        defaultFileTreeVisible: false,
        focusFilePath: path,
      })
      return
    }
    onOpenWorkspaceFile?.(path)
  }

  return (
    <div className="group min-w-0 overflow-x-hidden text-[13px] leading-6 text-text-primary">
      {hasBlocks && (
        <ToolBlocksDisplay
          blocks={displayBlocks}
          isStreaming={isStreaming}
          startedAt={getTurnStartMs(message.createdAt)}
          forceExpanded={isCancelled}
          showSummary={!isCancelled}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
        />
      )}
      {hasVisibleContent && (
        <div className="assistant-markdown min-w-0 overflow-x-hidden break-words">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: ({ children }) => <h1 className="mb-4 mt-6 text-lg font-semibold">{children}</h1>,
              h2: ({ children }) => (
                <h2 className="mb-3 mt-5 text-base font-semibold">{children}</h2>
              ),
              h3: ({ children }) => <h3 className="mb-2 mt-4 text-sm font-semibold">{children}</h3>,
              p: ({ children }) => <p className="mb-3 min-w-0 break-words leading-6">{children}</p>,
              ul: ({ children }) => <ul className="mb-3 list-disc space-y-1.5 pl-5">{children}</ul>,
              ol: ({ children }) => (
                <ol className="mb-3 list-decimal space-y-1.5 pl-8">{children}</ol>
              ),
              li: ({ children }) => (
                <li className="min-w-0 break-words pl-1 leading-6">{children}</li>
              ),
              strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
              code: ({ className, children }) => {
                const match = /language-(\w*)/.exec(className || '')
                const isBlock = Boolean(match) || String(children).includes('\n')
                if (isBlock) {
                  const lang = match ? match[1] || '' : ''
                  return <CodeBlock lang={lang}>{children}</CodeBlock>
                }
                return (
                  <code className="break-words rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-text-primary">
                    {children}
                  </code>
                )
              },
              pre: ({ children }) => (
                <pre className="mb-3 mt-2 max-w-full overflow-hidden">{children}</pre>
              ),
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
                <th className="border-b border-border px-3 py-2 text-left font-semibold">
                  {children}
                </th>
              ),
              td: ({ children }) => (
                <td className="border-b border-border px-3 py-2">{children}</td>
              ),
              a: ({ href, children }) => (
                <AssistantMarkdownLink href={href} onOpenFile={openFileFromLink}>
                  {children}
                </AssistantMarkdownLink>
              ),
              img: ({ src, alt }) => <AssistantMarkdownImage src={src} alt={alt} />,
            }}
          >
            {visibleContent}
          </ReactMarkdown>
        </div>
      )}
      {shouldShowCompactThinking && <WaitingAssistantIndicator />}
      {message.status === 'failed' && (
        <AssistantErrorCard
          error={message.error}
          errorType={message.errorType}
          rawError={hiddenErrorContent}
          message={message}
          onRetry={onRetryFailedMessage}
          onSwitchModel={onSwitchModelForFailedMessage}
        />
      )}
      {message.fileChanges && message.subtaskId && onLoadFileChangesDiff && onRevertFileChanges ? (
        <FileChangesCard
          subtaskId={message.subtaskId}
          summary={message.fileChanges}
          deviceOnline={devices.some(
            device =>
              device.device_id === message.fileChanges?.device_id && device.status === 'online'
          )}
          onLoadDiff={onLoadFileChangesDiff}
          onRevert={onRevertFileChanges}
          onOpenReview={onOpenFileChangesReview}
        />
      ) : null}
      {isCancelled ? (
        <div
          data-testid="assistant-stopped-notice"
          className="mt-4 flex justify-end border-b border-border pb-2 text-sm font-medium text-text-muted"
        >
          {t('assistant_status.stopped_after', {
            duration: getStoppedElapsedDuration(message),
          })}
        </div>
      ) : null}
      {message.status !== 'streaming' &&
        !isCancelled &&
        (hasVisibleContent || message.status === 'failed') && (
          <MessageHoverActions message={message} align="left" />
        )}
    </div>
  )
}

function AssistantErrorCard({
  error,
  errorType,
  rawError,
  message,
  onRetry,
  onSwitchModel,
}: {
  error?: string
  errorType?: string
  rawError?: string
  message: WorkbenchMessage
  onRetry?: (message: WorkbenchMessage) => void
  onSwitchModel?: (message: WorkbenchMessage) => void
}) {
  const { t } = useTranslation('chat')
  const [isDetailExpanded, setIsDetailExpanded] = useState(false)
  const displayError = rawError || error
  const hasErrorDetails = Boolean(displayError)
  const parsedError = parseChatError(displayError ?? '', errorType)
  const modelName =
    displayError?.match(/model_id:\s*([^"'}\s]+)/)?.[1] ??
    displayError?.match(/model(?:\s+|_id["':\s]+)([a-z0-9._:-]+)/i)?.[1]
  const title = t(parsedError.titleKey, {
    defaultValue: t('assistant_error.types.generic_error.title', '消息生成失败'),
  })
  const description =
    parsedError.type === 'model_protocol_error' && modelName
      ? t('assistant_error.types.model_protocol_error.description_with_model', {
          model: modelName,
          defaultValue: `${modelName} 不支持当前运行协议。请切换兼容模型后重试。`,
        })
      : !hasErrorDetails && parsedError.type === 'generic_error'
        ? t('assistant_error.types.generic_error.description_without_details')
        : t(parsedError.descriptionKey, {
            defaultValue: t(
              'assistant_error.types.generic_error.description',
              '请求未能完成。你可以稍后重试，或查看错误详情。'
            ),
          })

  return (
    <div
      data-testid="assistant-error-card"
      className="mt-2 flex w-[min(546px,100%)] max-w-full items-start gap-2.5 rounded-[14px] border border-border bg-surface px-3.5 py-3 text-text-primary"
    >
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-base text-red-500 shadow-[inset_0_0_0_1px_rgb(var(--color-border))]">
        <AlertTriangle className="h-3 w-3" strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold leading-5 text-text-primary">{title}</p>
        <p className="mt-0.5 text-xs leading-[18px] text-text-secondary">{description}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="assistant-error-switch-model-retry"
            onClick={() => onSwitchModel?.(message)}
            className="h-8 rounded-lg border border-text-primary bg-text-primary px-3 text-xs font-semibold text-background hover:bg-text-primary/90"
          >
            {t('assistant_error.actions.switch_model_retry', '切换模型并重试')}
          </button>
          <button
            type="button"
            data-testid="assistant-error-retry"
            onClick={() => onRetry?.(message)}
            className="h-8 rounded-lg border border-border bg-base px-3 text-xs font-semibold text-text-secondary hover:bg-muted hover:text-text-primary"
          >
            {t('assistant_error.actions.retry', '重试')}
          </button>
          {hasErrorDetails && (
            <button
              type="button"
              data-testid="assistant-error-details-toggle"
              aria-expanded={isDetailExpanded}
              onClick={() => setIsDetailExpanded(value => !value)}
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-base px-3 text-xs font-semibold text-text-secondary hover:bg-muted hover:text-text-primary"
            >
              <ChevronDown
                className={[
                  'h-3.5 w-3.5 transition-transform',
                  isDetailExpanded ? 'rotate-180' : '',
                ].join(' ')}
              />
              {t('assistant_error.details', '错误详情')}
            </button>
          )}
        </div>
        {hasErrorDetails && (
          <pre
            data-testid="assistant-error-details"
            className={[
              'mt-2 max-w-full rounded-md bg-base px-2.5 py-1.5 font-mono text-[11px] leading-4 text-text-muted',
              isDetailExpanded
                ? 'max-h-32 overflow-auto whitespace-pre-wrap break-words'
                : 'overflow-hidden truncate whitespace-nowrap',
            ].join(' ')}
          >
            {displayError}
          </pre>
        )}
      </div>
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
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                />
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
