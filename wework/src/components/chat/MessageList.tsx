import { Fragment, memo, useEffect, useMemo, useRef, useState } from 'react'
import type {
  MouseEvent as ReactMouseEvent,
  ReactNode,
  TransitionEvent as ReactTransitionEvent,
} from 'react'
import {
  AlertTriangle,
  Braces,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  File as FileIcon,
  ListChecks,
  Maximize2,
  Package,
} from 'lucide-react'
import type {
  Attachment,
  DeviceInfo,
  RequestUserInputResponse,
  TurnFileChangesSummary,
} from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import type { ProcessingBlock, WorkbenchMessage } from '@/types/workbench'
import { getAttachmentTypeLabel, isImageAttachment } from '@/lib/attachments'
import { parseChatError } from '@/lib/chat-error'
import { isIMSource } from '@/lib/im-source'
import { ImSourceBadge } from '@/components/common/ImSourceBadge'
import { cn } from '@/lib/utils'
import { AssistantMarkdown } from './AssistantMarkdown'
import { AttachmentImagePreview } from './AttachmentImagePreview'
import { ToolBlocksDisplay } from './blocks/ToolBlocksDisplay'
import type { RequestUserInputPayload } from './RequestUserInputCard'
import { isWebSearchToolName } from './blocks/toolBlockActivity'
import { WebSearchSourcesChip } from './blocks/WebSearchSources'
import { getWebSearchSourceItems } from './blocks/webSearchActivity'
import { CodexContextEvents, CodexMemoryCitations, CodexReferenceList } from './CodexTurnArtifacts'
import { getAssistantReferences } from './codexReferences'
import { FileChangesCard } from './FileChangesCard'

interface MessageListProps {
  messages: WorkbenchMessage[]
  className?: string
  conversationKey?: string | number | null
  isWaitingForAssistant?: boolean
  disableContentVisibility?: boolean
  devices?: DeviceInfo[]
  onRetryFailedMessage?: (message: WorkbenchMessage) => void
  onSwitchModelForFailedMessage?: (message: WorkbenchMessage) => void
  onLoadFileChangesDiff?: (turnId: number) => Promise<string>
  onRevertFileChanges?: (turnId: number) => Promise<TurnFileChangesSummary>
  onOpenFileChangesReview?: (request: {
    turnId: number
    loadDiff: () => Promise<string>
    reviewTitle?: string
    defaultFileTreeVisible?: boolean
    focusFilePath?: string
  }) => void
  onOpenWorkspaceFile?: (path: string) => void
  onRequestUserInputSubmit?: (response: RequestUserInputResponse) => void
  onRequestUserInputIgnore?: (payload: RequestUserInputPayload) => void
  onOpenAssistantPlan?: (content: string) => void
  hideRequestUserInputBlocks?: boolean
  hiddenRequestUserInputIds?: ReadonlySet<string>
  renderGapAfterMessage?: (
    message: WorkbenchMessage,
    nextMessage: WorkbenchMessage | undefined
  ) => ReactNode
}

const USER_MESSAGE_COLLAPSE_LINES = 10
const USER_MESSAGE_COLLAPSE_CHARACTERS = 600
const CODEX_FILE_MENTIONS_HEADER_PATTERN = /^\s*# Files mentioned by the user:\s*/i
const CODEX_REQUEST_MARKER_PATTERN = /^## My request for Codex:\s*$/im
const CODEX_FILE_MENTION_LINE_PATTERN = /^##\s+(.+?):\s+(.+)$/gm
const CODEX_PLAN_TAG_PATTERN = /<\/?\s*proposed_plan\s*>/gi
const CODEX_PLAN_SECTION_PATTERN = /^##\s+(Summary|Key Changes|Test Plan|Assumptions)\s*$/im
const LOCAL_IMAGE_EXTENSION_PATTERN = /\.(?:apng|avif|gif|jpe?g|png|webp|bmp|svg)$/i
const CODEX_TRANSIENT_CLIPBOARD_IMAGE_PATTERN =
  /\/(?:var\/folders|private\/var\/folders)\/.*\/codex-clipboard-[^/]+\.(?:apng|avif|gif|jpe?g|png|webp|bmp|svg)$/i
const LOCAL_IMAGE_MIME_TYPES: Record<string, string> = {
  '.apng': 'image/apng',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

export const MessageList = memo(function MessageList({
  messages,
  className,
  conversationKey,
  isWaitingForAssistant = false,
  disableContentVisibility = false,
  devices = [],
  onRetryFailedMessage,
  onSwitchModelForFailedMessage,
  onLoadFileChangesDiff,
  onRevertFileChanges,
  onOpenFileChangesReview,
  onOpenWorkspaceFile,
  onRequestUserInputSubmit,
  onRequestUserInputIgnore,
  onOpenAssistantPlan,
  hideRequestUserInputBlocks,
  hiddenRequestUserInputIds,
  renderGapAfterMessage,
}: MessageListProps) {
  const visibleMessages = messages.filter(shouldRenderMessage)
  const shouldShowWaitingIndicator =
    isWaitingForAssistant &&
    !messages.some(message => message.role === 'assistant' && message.status === 'streaming')
  const listLayoutClass = className
    ? 'mx-auto flex min-w-0 flex-col gap-4 overflow-x-hidden pb-2 pt-8'
    : 'mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4 overflow-x-hidden px-6 pb-2 pt-8'

  if (visibleMessages.length === 0 && !shouldShowWaitingIndicator) {
    return null
  }

  return (
    <div className={cn(listLayoutClass, className)}>
      {visibleMessages.map((message, index) => {
        const nextMessage = visibleMessages[index + 1]
        return (
          <Fragment key={message.id}>
            <article
              className={[
                'min-w-0 overflow-x-hidden',
                disableContentVisibility
                  ? ''
                  : '[content-visibility:auto] [contain-intrinsic-size:0_220px]',
                message.role === 'user' ? 'flex justify-end' : '',
              ].join(' ')}
              data-message-id={message.id}
              data-testid={`message-${message.role}`}
            >
              {message.role === 'user' ? (
                <UserMessage message={message} onOpenWorkspaceFile={onOpenWorkspaceFile} />
              ) : (
                <AssistantMessage
                  message={message}
                  conversationKey={conversationKey}
                  devices={devices}
                  onRetryFailedMessage={onRetryFailedMessage}
                  onSwitchModelForFailedMessage={onSwitchModelForFailedMessage}
                  onLoadFileChangesDiff={onLoadFileChangesDiff}
                  onRevertFileChanges={onRevertFileChanges}
                  onOpenFileChangesReview={onOpenFileChangesReview}
                  onOpenWorkspaceFile={onOpenWorkspaceFile}
                  onRequestUserInputSubmit={onRequestUserInputSubmit}
                  onRequestUserInputIgnore={onRequestUserInputIgnore}
                  onOpenAssistantPlan={onOpenAssistantPlan}
                  hideRequestUserInputBlocks={hideRequestUserInputBlocks}
                  hiddenRequestUserInputIds={hiddenRequestUserInputIds}
                />
              )}
            </article>
            {renderGapAfterMessage?.(message, nextMessage)}
          </Fragment>
        )
      })}
      {shouldShowWaitingIndicator && (
        <article className="min-w-0 overflow-x-hidden" data-testid="message-assistant-waiting">
          <WaitingAssistantIndicator />
        </article>
      )}
    </div>
  )
}, areMessageListPropsEqual)

function areMessageListPropsEqual(previous: MessageListProps, next: MessageListProps): boolean {
  const changed = [
    previous.messages !== next.messages ? 'messages' : null,
    previous.className !== next.className ? 'className' : null,
    previous.conversationKey !== next.conversationKey ? 'conversationKey' : null,
    previous.isWaitingForAssistant !== next.isWaitingForAssistant ? 'isWaitingForAssistant' : null,
    previous.disableContentVisibility !== next.disableContentVisibility
      ? 'disableContentVisibility'
      : null,
    previous.devices !== next.devices ? 'devices' : null,
    previous.onRetryFailedMessage !== next.onRetryFailedMessage ? 'onRetryFailedMessage' : null,
    previous.onSwitchModelForFailedMessage !== next.onSwitchModelForFailedMessage
      ? 'onSwitchModelForFailedMessage'
      : null,
    previous.onLoadFileChangesDiff !== next.onLoadFileChangesDiff ? 'onLoadFileChangesDiff' : null,
    previous.onRevertFileChanges !== next.onRevertFileChanges ? 'onRevertFileChanges' : null,
    previous.onOpenFileChangesReview !== next.onOpenFileChangesReview
      ? 'onOpenFileChangesReview'
      : null,
    previous.onOpenWorkspaceFile !== next.onOpenWorkspaceFile ? 'onOpenWorkspaceFile' : null,
    previous.onRequestUserInputSubmit !== next.onRequestUserInputSubmit
      ? 'onRequestUserInputSubmit'
      : null,
    previous.onRequestUserInputIgnore !== next.onRequestUserInputIgnore
      ? 'onRequestUserInputIgnore'
      : null,
    previous.hideRequestUserInputBlocks !== next.hideRequestUserInputBlocks
      ? 'hideRequestUserInputBlocks'
      : null,
    previous.hiddenRequestUserInputIds !== next.hiddenRequestUserInputIds
      ? 'hiddenRequestUserInputIds'
      : null,
    previous.renderGapAfterMessage !== next.renderGapAfterMessage ? 'renderGapAfterMessage' : null,
  ].filter((key): key is string => key !== null)

  return changed.length === 0
}

function shouldRenderMessage(message: WorkbenchMessage): boolean {
  if (message.role !== 'assistant') return true
  if (message.status === 'streaming' || message.status === 'failed') return true
  if (isCancelledAssistantMessage(message)) return true
  if (message.fileChanges) return true
  if (
    message.references?.length ||
    message.memoryCitations?.length ||
    message.contextEvents?.length
  ) {
    return true
  }

  const visibleContent = shouldHideFailedAssistantContent(message) ? '' : message.content
  if (visibleContent.trim()) return true

  return getDisplayProcessingBlocks(message.blocks).length > 0
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
  return getMessageTimestampMs(createdAt)
}

function getMessageTimestampMs(value: string | number | null | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) return value
    if (value > 1_000_000_000) return value * 1000
    return undefined
  }

  if (typeof value !== 'string' || !value.trim()) return undefined
  const numericValue = Number(value)
  if (Number.isFinite(numericValue)) {
    return getMessageTimestampMs(numericValue)
  }

  const ms = new Date(value).getTime()
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

  const completedAt = getMessageTimestampMs(message.completedAt)
  if (completedAt !== undefined && completedAt >= startedAt) {
    return formatCompactDuration(completedAt - startedAt)
  }

  const blockEndTimes =
    message.blocks
      ?.map(block => block.createdAt)
      .filter((createdAt): createdAt is number => Number.isFinite(createdAt)) ?? []
  const endedAt = blockEndTimes.length > 0 ? Math.max(...blockEndTimes) : startedAt

  return formatCompactDuration(endedAt - startedAt)
}

function getProcessingSummaryStartMs(
  message: WorkbenchMessage,
  blocks: ProcessingBlock[],
  isStreaming: boolean
): number | undefined {
  if (!isStreaming) return getTurnStartMs(message.createdAt)

  const blockStartTimes = blocks
    .map(block => block.createdAt)
    .filter((createdAt): createdAt is number => Number.isFinite(createdAt))

  if (blockStartTimes.length > 0) return Math.min(...blockStartTimes)

  return undefined
}

function isCancelledAssistantMessage(message: WorkbenchMessage): boolean {
  return message.runtimeStatus === 'cancelled'
}

function isCancelledPlaceholderContent(content: string): boolean {
  return ['interrupted', 'cancelled', 'canceled', 'aborted'].includes(content.trim().toLowerCase())
}

const RECENT_MESSAGE_TIME_RANGE_MS = 7 * 24 * 60 * 60 * 1000
const CHINESE_WEEKDAY_LABELS = [
  '星期日',
  '星期一',
  '星期二',
  '星期三',
  '星期四',
  '星期五',
  '星期六',
]

function formatMessageTime(createdAt: string) {
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()

  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (isToday) return time

  const ageMs = now.getTime() - date.getTime()
  if (ageMs >= 0 && ageMs < RECENT_MESSAGE_TIME_RANGE_MS) {
    return `${CHINESE_WEEKDAY_LABELS[date.getDay()]}${time}`
  }

  const dateLabel = `${date.getMonth() + 1}月${date.getDate()}日`
  if (date.getFullYear() === now.getFullYear()) {
    return `${dateLabel} ${time}`
  }

  return `${date.getFullYear()}年${dateLabel} ${time}`
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

function UserMessage({
  message,
  onOpenWorkspaceFile,
}: {
  message: WorkbenchMessage
  onOpenWorkspaceFile?: (path: string) => void
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [areHoverActionsVisible, setAreHoverActionsVisible] = useState(false)
  const codexLocalFileMentions = useMemo(
    () => parseCodexLocalFileMentions(message.content),
    [message.content]
  )
  const displayContent = codexLocalFileMentions?.requestText ?? message.content
  const imageAttachments = useMemo(
    () => (message.attachments ?? []).filter(isImageAttachment),
    [message.attachments]
  )
  const documentAttachments = useMemo(
    () => (message.attachments ?? []).filter(attachment => !isImageAttachment(attachment)),
    [message.attachments]
  )
  const localImageMentions = useMemo(
    () => (imageAttachments.length > 0 ? [] : (codexLocalFileMentions?.images ?? [])),
    [codexLocalFileMentions?.images, imageAttachments.length]
  )
  const localFileMentions = codexLocalFileMentions?.files ?? []
  const localImageAttachments = useMemo(
    () =>
      localImageMentions.map((image, index) =>
        createLocalImageMentionAttachment(image, index, message.createdAt)
      ),
    [localImageMentions, message.createdAt]
  )
  const imagePreviewAttachments = useMemo(
    () => (imageAttachments.length > 0 ? imageAttachments : localImageAttachments),
    [imageAttachments, localImageAttachments]
  )
  const hasImagePreviews = imagePreviewAttachments.length > 0
  const hasMultipleImagePreviews = imagePreviewAttachments.length > 1
  const shouldCollapse =
    displayContent.length > USER_MESSAGE_COLLAPSE_CHARACTERS ||
    displayContent.split('\n').length > USER_MESSAGE_COLLAPSE_LINES
  const showSourceBadge = isIMSource(message.source)

  return (
    <div
      className={[
        'flex flex-col items-end gap-1.5',
        hasImagePreviews ? 'w-full max-w-full' : 'max-w-[80%]',
      ].join(' ')}
      data-testid="message-hover-region"
      onPointerEnter={() => setAreHoverActionsVisible(true)}
      onPointerLeave={() => setAreHoverActionsVisible(false)}
    >
      <div
        className={[
          'flex max-w-full flex-col items-end gap-1.5',
          hasImagePreviews ? 'w-full' : 'w-fit',
        ].join(' ')}
      >
        {(imagePreviewAttachments.length > 0 ||
          localFileMentions.length > 0 ||
          documentAttachments.length > 0) && (
          <div
            className={[
              'flex max-w-full flex-col items-end gap-2',
              hasImagePreviews ? 'w-full' : '',
            ].join(' ')}
          >
            {hasImagePreviews && (
              <div
                data-testid="message-image-attachments"
                className={[
                  'flex w-full max-w-full flex-row flex-nowrap gap-2',
                  hasMultipleImagePreviews
                    ? 'scrollbar-none overflow-x-auto overscroll-x-contain'
                    : 'justify-end overflow-visible',
                ].join(' ')}
              >
                <div
                  data-testid="message-image-attachment-strip"
                  className="ml-auto flex w-max max-w-none flex-row flex-nowrap justify-end gap-2"
                >
                  {imagePreviewAttachments.map((attachment, index) => (
                    <MessageImageAttachmentPreview
                      key={`${attachment.id}:${attachment.local_preview_url ?? attachment.filename}`}
                      attachment={attachment}
                      galleryAttachments={imagePreviewAttachments}
                      galleryIndex={index}
                      imageTestId={
                        imageAttachments.length > 0
                          ? 'message-image-preview'
                          : 'message-local-image-preview'
                      }
                      buttonTestId={
                        imageAttachments.length > 0
                          ? 'message-image-preview-button'
                          : 'message-local-image-preview-button'
                      }
                      loadingTestId={
                        imageAttachments.length > 0
                          ? 'message-image-preview-loading'
                          : 'message-local-image-preview-loading'
                      }
                      errorTestId={
                        imageAttachments.length > 0
                          ? 'message-image-preview-error'
                          : 'message-local-image-preview-error'
                      }
                      hideOnError={imageAttachments.length === 0}
                    />
                  ))}
                </div>
              </div>
            )}
            {localFileMentions.map(file => (
              <MessageCodexFileMention
                key={`${file.filename}:${file.path}`}
                file={file}
                onOpenFile={onOpenWorkspaceFile}
              />
            ))}
            {documentAttachments.map(attachment => (
              <MessageDocumentAttachment key={attachment.id} attachment={attachment} />
            ))}
          </div>
        )}
        {displayContent && (
          <div
            className={[
              'overflow-hidden rounded-2xl bg-muted text-[13px] leading-5 text-text-primary',
              hasImagePreviews ? 'max-w-[80%]' : 'max-w-full',
            ].join(' ')}
          >
            <div
              data-testid="user-message-content"
              className={[
                'relative overflow-hidden break-words whitespace-pre-wrap bg-muted px-4 py-1.5',
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
      </div>
      <MessageHoverActions message={message} align="right" visible={areHoverActionsVisible} />
    </div>
  )
}

function AssistantPlanCard({
  content,
  onOpenPlan,
}: {
  content: string
  onOpenPlan?: (content: string) => void
}) {
  const { t } = useTranslation('chat')

  const handleDownload = () => {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'plan.md'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  return (
    <section
      data-testid="assistant-plan-card"
      className="my-3 min-w-0 overflow-hidden rounded-lg border border-border bg-background shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
    >
      <div className="flex min-h-10 items-center justify-between gap-3 px-4 py-2 text-text-muted">
        <div className="inline-flex min-w-0 items-center gap-2 text-sm font-medium">
          <ListChecks className="h-4 w-4 shrink-0" strokeWidth={1.8} aria-hidden="true" />
          <span>{t('plan_card.title')}</span>
        </div>
        <PlanCardActions
          content={content}
          onDownload={handleDownload}
          onExpand={() => onOpenPlan?.(content)}
        />
      </div>
      <div className="relative max-h-[360px] overflow-hidden px-4 pb-4 pt-3">
        <div className="assistant-plan-card-content text-[15px] leading-7 text-text-primary">
          <AssistantMarkdown content={content} />
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background to-transparent" />
      </div>
    </section>
  )
}

function PlanCardActions({
  content,
  onDownload,
  onExpand,
}: {
  content: string
  onDownload: () => void
  onExpand: () => void
}) {
  const { t } = useTranslation('chat')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1400)
    return () => window.clearTimeout(timer)
  }, [copied])

  const handleCopy = () => {
    void copyText(content).then(() => setCopied(true))
  }

  const actions = [
    {
      key: 'download',
      label: t('plan_card.download'),
      icon: <Download className="h-4 w-4" aria-hidden="true" />,
      onClick: onDownload,
      testId: 'assistant-plan-download-button',
    },
    {
      key: 'copy',
      label: t('plan_card.copy'),
      icon: <Copy className="h-4 w-4" aria-hidden="true" />,
      onClick: handleCopy,
      testId: 'assistant-plan-copy-button',
    },
    {
      key: 'expand',
      label: t('plan_card.expand'),
      icon: <Maximize2 className="h-4 w-4" aria-hidden="true" />,
      onClick: onExpand,
      testId: 'assistant-plan-expand-button',
    },
  ]

  return (
    <div className="flex shrink-0 items-center gap-2">
      {copied ? (
        <span
          data-testid="assistant-plan-copy-success"
          className="text-xs font-medium text-text-secondary"
        >
          {t('plan_card.copy_success')}
        </span>
      ) : null}
      {actions.map(action => (
        <button
          key={action.key}
          type="button"
          data-testid={action.testId}
          aria-label={action.label}
          title={action.label}
          onClick={action.onClick}
          className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text-primary"
        >
          {action.icon}
        </button>
      ))}
    </div>
  )
}

function normalizeAssistantPlanContent(content: string): string {
  return content.replace(CODEX_PLAN_TAG_PATTERN, '').trim()
}

function isAssistantPlanContent(content: string): boolean {
  const normalizedContent = normalizeAssistantPlanContent(content)
  return (
    normalizedContent !== content ||
    (/^#\s+.+/m.test(normalizedContent) && CODEX_PLAN_SECTION_PATTERN.test(normalizedContent))
  )
}

function parseCodexLocalFileMentions(content: string): {
  requestText: string
  images: Array<{ filename: string; path: string }>
  files: Array<{ filename: string; path: string }>
} | null {
  if (!CODEX_FILE_MENTIONS_HEADER_PATTERN.test(content)) return null

  const requestMarker = content.match(CODEX_REQUEST_MARKER_PATTERN)
  const requestText =
    requestMarker?.index === undefined
      ? ''
      : content.slice(requestMarker.index + requestMarker[0].length).trim()

  const filesText =
    requestMarker?.index === undefined ? content : content.slice(0, requestMarker.index)
  const images: Array<{ filename: string; path: string }> = []
  const files: Array<{ filename: string; path: string }> = []
  for (const match of filesText.matchAll(CODEX_FILE_MENTION_LINE_PATTERN)) {
    const filename = match[1]?.trim()
    const path = match[2]?.trim()
    if (!filename || !path) continue
    if (isTransientCodexClipboardImage(path)) continue
    const target = { filename, path }
    if (isLocalImageMention(filename, path)) {
      if (!images.some(image => image.path === path || image.filename === filename)) {
        images.push(target)
      }
      continue
    }
    if (!files.some(file => file.path === path || file.filename === filename)) {
      files.push(target)
    }
  }

  if (!requestText && images.length === 0 && files.length === 0) return null

  return { requestText, images, files }
}

function isLocalImageMention(filename: string, path: string): boolean {
  return LOCAL_IMAGE_EXTENSION_PATTERN.test(filename) || LOCAL_IMAGE_EXTENSION_PATTERN.test(path)
}

function isTransientCodexClipboardImage(path: string): boolean {
  return CODEX_TRANSIENT_CLIPBOARD_IMAGE_PATTERN.test(path)
}

function getLocalImageExtension(filename: string, path: string): string {
  const source = LOCAL_IMAGE_EXTENSION_PATTERN.test(filename) ? filename : path
  const match = source.match(/(\.[a-z0-9]+)(?:[?#].*)?$/i)
  return match?.[1]?.toLowerCase() ?? ''
}

function createLocalImageMentionAttachment(
  image: { filename: string; path: string },
  index: number,
  createdAt: string
): Attachment {
  const fileExtension = getLocalImageExtension(image.filename, image.path)

  return {
    id: -100000 - index,
    filename: image.filename,
    file_size: 0,
    mime_type: LOCAL_IMAGE_MIME_TYPES[fileExtension] ?? 'image/png',
    status: 'ready',
    file_extension: fileExtension,
    created_at: createdAt,
    local_preview_url: image.path,
  }
}

function MessageCodexFileMention({
  file,
  onOpenFile,
}: {
  file: { filename: string; path: string }
  onOpenFile?: (path: string) => void
}) {
  const useBracesIcon = shouldUseBracesFileIcon(file.filename)
  const Icon = useBracesIcon ? Braces : FileIcon
  const iconTestId = useBracesIcon
    ? 'message-codex-file-braces-icon'
    : 'message-codex-file-document-icon'

  return (
    <button
      type="button"
      data-testid="message-codex-file-mention"
      className="inline-flex h-10 max-w-[260px] items-center gap-2 rounded-2xl border border-border bg-base px-3 text-left text-[13px] font-semibold leading-none text-text-primary shadow-sm hover:bg-muted"
      title={file.path}
      aria-label={file.filename}
      onClick={() => onOpenFile?.(file.path)}
    >
      <Icon
        data-testid={iconTestId}
        className="h-3.5 w-3.5 shrink-0 text-text-muted"
        strokeWidth={1.8}
      />
      <span className="min-w-0 truncate">{file.filename}</span>
    </button>
  )
}

function shouldUseBracesFileIcon(filename: string): boolean {
  return /\.(?:json|jsonc)$/i.test(filename)
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

function MessageImageAttachmentPreview({
  attachment,
  galleryAttachments,
  galleryIndex,
  buttonTestId = 'message-image-preview-button',
  imageTestId = 'message-image-preview',
  loadingTestId = 'message-image-preview-loading',
  errorTestId = 'message-image-preview-error',
  hideOnError = false,
}: {
  attachment: Attachment
  galleryAttachments: Attachment[]
  galleryIndex: number
  buttonTestId?: string
  imageTestId?: string
  loadingTestId?: string
  errorTestId?: string
  hideOnError?: boolean
}) {
  return (
    <AttachmentImagePreview
      attachment={attachment}
      buttonTestId={buttonTestId}
      imageTestId={imageTestId}
      loadingTestId={loadingTestId}
      errorTestId={errorTestId}
      imageClassName="block h-20 w-20 shrink-0 rounded-xl border border-border bg-base object-cover"
      placeholderClassName="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl border border-border bg-surface text-text-muted"
      buttonClassName="block h-20 w-20 shrink-0 cursor-zoom-in p-0 text-left"
      galleryAttachments={galleryAttachments}
      galleryIndex={galleryIndex}
      hideOnError={hideOnError}
    />
  )
}

function MessageHoverActions({
  message,
  align,
  visible,
}: {
  message: WorkbenchMessage
  align: 'left' | 'right'
  visible: boolean
}) {
  const [copied, setCopied] = useState(false)
  const resetCopiedAfterHideRef = useRef(false)
  const time = formatMessageTime(message.createdAt)

  useEffect(() => {
    if (!visible && copied) {
      resetCopiedAfterHideRef.current = true
    }
  }, [copied, visible])

  const handleCopy = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (event.detail > 0) {
      event.currentTarget.blur()
    }
    void copyText(message.content).then(() => {
      setCopied(true)
      resetCopiedAfterHideRef.current = false
    })
  }

  const handleLeaveActions = () => {
    if (copied) {
      resetCopiedAfterHideRef.current = true
    }
  }

  const handleActionsTransitionEnd = (event: ReactTransitionEvent<HTMLDivElement>) => {
    if (
      event.target !== event.currentTarget ||
      event.propertyName !== 'opacity' ||
      !resetCopiedAfterHideRef.current
    ) {
      return
    }

    resetCopiedAfterHideRef.current = false
    setCopied(false)
  }

  const copyAction = (
    <span
      data-testid="copy-message-action"
      className="group/copy relative flex h-6 w-6 items-center justify-center"
    >
      <button
        type="button"
        data-testid="copy-message-button"
        onClick={handleCopy}
        title="复制"
        className={[
          'flex h-6 w-6 items-center justify-center rounded-md transition-colors',
          copied
            ? 'bg-text-primary text-background/70 shadow-sm hover:bg-text-primary/90 hover:text-background/80'
            : 'text-text-muted hover:bg-muted hover:text-text-secondary',
        ].join(' ')}
        aria-label={copied ? '已复制' : '复制消息'}
      >
        {copied ? (
          <Check data-testid="copy-message-success-icon" className="h-4 w-4" strokeWidth={2.2} />
        ) : (
          <Copy data-testid="copy-message-icon" className="h-3.5 w-3.5" />
        )}
      </button>
      <span
        data-testid="copy-message-label"
        className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-base px-1.5 py-0.5 text-xs text-text-secondary opacity-0 shadow-sm transition-opacity group-hover/copy:opacity-100"
      >
        复制
      </span>
    </span>
  )

  const timeLabel = time ? (
    <span
      data-testid="message-hover-time"
      className="select-text whitespace-nowrap px-1 text-xs text-text-muted"
    >
      {time}
    </span>
  ) : null

  return (
    <div
      data-testid="message-hover-actions"
      onMouseLeave={handleLeaveActions}
      onTransitionEnd={handleActionsTransitionEnd}
      className={[
        'flex min-h-5 select-text items-center gap-1 text-xs text-text-muted transition-opacity duration-150',
        visible ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0',
        align === 'right' ? 'justify-end' : 'justify-start',
      ].join(' ')}
    >
      {align === 'right' ? (
        <>
          {timeLabel}
          {copyAction}
        </>
      ) : (
        <>
          {copyAction}
          {timeLabel}
        </>
      )}
    </div>
  )
}

const LOCAL_SKILL_LINK_PATTERN = /\[\$([^\]]+)]\((skill:\/\/[^)]+SKILL\.md)\)/g

function localSkillTokenTestId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-')
}

function displayLocalSkillName(name: string): string {
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

function getDisplayProcessingBlocks(blocks: ProcessingBlock[] | undefined): ProcessingBlock[] {
  if (!blocks?.length) return []

  return blocks.filter(block => {
    if (block.type !== 'text') return true

    return Boolean(block.content.trim())
  })
}

function getWebSearchToolBlocks(blocks: ProcessingBlock[]) {
  return blocks.filter(
    (block): block is Extract<ProcessingBlock, { type: 'tool' }> =>
      block.type === 'tool' && isWebSearchToolName(block.toolName)
  )
}

function AssistantMessage({
  message,
  conversationKey,
  devices,
  onRetryFailedMessage,
  onSwitchModelForFailedMessage,
  onLoadFileChangesDiff,
  onRevertFileChanges,
  onOpenFileChangesReview,
  onOpenWorkspaceFile,
  onRequestUserInputSubmit,
  onRequestUserInputIgnore,
  onOpenAssistantPlan,
  hideRequestUserInputBlocks,
  hiddenRequestUserInputIds,
}: {
  message: WorkbenchMessage
  conversationKey?: string | number | null
  devices: DeviceInfo[]
  onRetryFailedMessage?: (message: WorkbenchMessage) => void
  onSwitchModelForFailedMessage?: (message: WorkbenchMessage) => void
  onLoadFileChangesDiff?: (turnId: number) => Promise<string>
  onRevertFileChanges?: (turnId: number) => Promise<TurnFileChangesSummary>
  onOpenFileChangesReview?: (request: {
    turnId: number
    loadDiff: () => Promise<string>
    reviewTitle?: string
    defaultFileTreeVisible?: boolean
    focusFilePath?: string
  }) => void
  onOpenWorkspaceFile?: (path: string) => void
  onRequestUserInputSubmit?: (response: RequestUserInputResponse) => void
  onRequestUserInputIgnore?: (payload: RequestUserInputPayload) => void
  onOpenAssistantPlan?: (content: string) => void
  hideRequestUserInputBlocks?: boolean
  hiddenRequestUserInputIds?: ReadonlySet<string>
}) {
  const { t } = useTranslation('chat')
  const isCancelled = isCancelledAssistantMessage(message)
  const shouldShowStoppedNotice = isCancelled && message.stoppedNotice !== false
  const shouldHideContent =
    shouldHideFailedAssistantContent(message) ||
    (isCancelled && isCancelledPlaceholderContent(message.content))
  const visibleContent = shouldHideContent ? '' : message.content
  const hiddenErrorContent =
    message.status === 'failed' && shouldHideContent ? message.content.trim() : undefined
  const displayBlocks = getDisplayProcessingBlocks(message.blocks)
  const hasBlocks = displayBlocks.length > 0
  const hasVisibleContent = Boolean(visibleContent.trim())
  const isStreaming = message.status === 'streaming'
  const canShowFinalArtifacts = !isStreaming
  const hasStreamedResponse = hasBlocks || hasVisibleContent
  const shouldShowProcessingSummary = hasBlocks || (isStreaming && hasStreamedResponse)
  const shouldShowInitialThinking = isStreaming && !hasStreamedResponse
  const webSearchSources = isStreaming
    ? []
    : getWebSearchSourceItems(getWebSearchToolBlocks(displayBlocks))
  const contextEvents = message.contextEvents ?? []
  const memoryCitations = message.memoryCitations ?? []
  const [areHoverActionsVisible, setAreHoverActionsVisible] = useState(false)

  // A file referenced in the response usually belongs to this turn's changes, so
  // route the link into the previous-turn diff review focused on that file. When
  // the turn has no recorded changes, fall back to the workspace file panel.
  const fileChangesTurnId = message.fileChanges ? message.turnId : undefined
  const openFileFromLink = (path: string) => {
    if (fileChangesTurnId && onLoadFileChangesDiff && onOpenFileChangesReview) {
      onOpenFileChangesReview({
        turnId: fileChangesTurnId,
        loadDiff: () => onLoadFileChangesDiff(fileChangesTurnId),
        reviewTitle: t('file_changes.previous_turn_label'),
        defaultFileTreeVisible: false,
        focusFilePath: path,
      })
      return
    }
    onOpenWorkspaceFile?.(path)
  }
  const references = getAssistantReferences(message.references, visibleContent, message.fileChanges)

  return (
    <div className="min-w-0 overflow-x-hidden text-[13px] leading-6 text-text-primary">
      <div
        className="w-full max-w-full"
        data-testid="message-hover-region"
        onPointerEnter={() => setAreHoverActionsVisible(true)}
        onPointerLeave={() => setAreHoverActionsVisible(false)}
      >
        <div className="w-full max-w-full">
          {shouldShowStoppedNotice ? (
            <div
              data-testid="assistant-stopped-notice"
              className="mb-3 border-b border-border pb-2 text-sm font-medium text-text-muted"
            >
              {t('assistant_status.stopped_after', {
                duration: getStoppedElapsedDuration(message),
              })}
            </div>
          ) : null}
          {shouldShowProcessingSummary && (
            <ToolBlocksDisplay
              blocks={displayBlocks}
              isStreaming={isStreaming}
              startedAt={getProcessingSummaryStartMs(message, displayBlocks, isStreaming)}
              forceExpanded={isCancelled}
              hasFinalContent={hasVisibleContent}
              showSummary={!isCancelled}
              showRunningPlaceholder={!hasVisibleContent}
              stateKey={getMessageDisplayStateKey(conversationKey, message)}
              onOpenWorkspaceFile={onOpenWorkspaceFile}
              onRequestUserInputSubmit={onRequestUserInputSubmit}
              onRequestUserInputIgnore={onRequestUserInputIgnore}
              hideRequestUserInputBlocks={hideRequestUserInputBlocks}
              hiddenRequestUserInputIds={hiddenRequestUserInputIds}
            />
          )}
          {shouldShowInitialThinking && <WaitingAssistantIndicator />}
          {contextEvents.length > 0 && <CodexContextEvents events={contextEvents} />}
          {hasVisibleContent ? (
            isAssistantPlanContent(visibleContent) ? (
              <AssistantPlanCard
                content={normalizeAssistantPlanContent(visibleContent)}
                onOpenPlan={onOpenAssistantPlan}
              />
            ) : (
              <AssistantMarkdown content={visibleContent} onOpenFile={openFileFromLink} />
            )
          ) : null}
          {canShowFinalArtifacts && hasVisibleContent && webSearchSources.length > 0 && (
            <WebSearchSourcesChip sources={webSearchSources} />
          )}
          {canShowFinalArtifacts && memoryCitations.length > 0 && (
            <CodexMemoryCitations citations={memoryCitations} onOpenFile={onOpenWorkspaceFile} />
          )}
          {canShowFinalArtifacts && references.length > 0 && (
            <CodexReferenceList references={references} onOpenFile={openFileFromLink} />
          )}
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
          {canShowFinalArtifacts &&
          message.fileChanges &&
          message.turnId &&
          onLoadFileChangesDiff &&
          onRevertFileChanges ? (
            <FileChangesCard
              turnId={message.turnId}
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
        </div>
        {message.status !== 'streaming' &&
          !isCancelled &&
          (hasVisibleContent || message.status === 'failed') && (
            <MessageHoverActions message={message} align="left" visible={areHoverActionsVisible} />
          )}
      </div>
    </div>
  )
}

function getMessageDisplayStateKey(
  conversationKey: string | number | null | undefined,
  message: WorkbenchMessage
): string {
  const conversationPart = conversationKey == null ? 'default' : String(conversationKey)
  return `${conversationPart}:${message.id}`
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
