import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  CSSProperties,
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
  File as FileIcon,
  FileText,
  Package,
  Pencil,
  Target,
} from 'lucide-react'
import type {
  Attachment,
  DeviceInfo,
  RequestUserInputResponse,
  TurnFileChangesSummary,
} from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import type { ProcessingBlock, WorkbenchMessage } from '@/types/workbench'
import {
  getAttachmentTextPreview,
  getAttachmentTypeLabel,
  isImageAttachment,
  isTextAttachment,
} from '@/lib/attachments'
import { openLocalFile } from '@/lib/local-terminal'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { parseChatError } from '@/lib/chat-error'
import { isIMSource } from '@/lib/im-source'
import { ImSourceBadge } from '@/components/common/ImSourceBadge'
import { cn } from '@/lib/utils'
import { AssistantMarkdown } from './AssistantMarkdown'
import { AssistantThinkingIndicator } from './AssistantThinkingIndicator'
import { AttachmentImagePreview } from './AttachmentImagePreview'
import { ToolBlocksDisplay } from './blocks/ToolBlocksDisplay'
import { CODEX_IMPLEMENT_PLAN_RESPONSE_LABEL } from './requestUserInputMessages'
import type { RequestUserInputPayload } from './RequestUserInputCard'
import { buildProcessingDisplayRows, isWebSearchToolName } from './blocks/toolBlockActivity'
import { WebSearchSourcesChip } from './blocks/WebSearchSources'
import { getWebSearchSourceItems } from './blocks/webSearchActivity'
import { CodexMemoryCitations, CodexReferenceList } from './CodexTurnArtifacts'
import { getAssistantReferences } from './codexReferences'
import { FileChangesCard } from './FileChangesCard'
import { getMessagePretextIntrinsicHeight } from './messagePretextLayout'

interface MessageListProps {
  messages: WorkbenchMessage[]
  className?: string
  conversationKey?: string | number | null
  isWaitingForAssistant?: boolean
  disableContentVisibility?: boolean
  devices?: DeviceInfo[]
  onRetryFailedMessage?: (message: WorkbenchMessage) => void
  onSwitchModelForFailedMessage?: (message: WorkbenchMessage) => void
  onLoadFileChangesDiff?: (subtaskId: string) => Promise<string>
  onRevertFileChanges?: (subtaskId: string) => Promise<TurnFileChangesSummary>
  onOpenFileChangesReview?: (request: {
    subtaskId: string
    loadDiff: () => Promise<string>
    reviewTitle?: string
    defaultFileTreeVisible?: boolean
    focusFilePath?: string
  }) => void
  onOpenWorkspaceFile?: (path: string) => void
  onRequestUserInputSubmit?: (response: RequestUserInputResponse) => void
  onRequestUserInputIgnore?: (payload: RequestUserInputPayload) => void
  onOpenAssistantPlan?: (content: string) => void
  onEditLastUserMessage?: (
    message: WorkbenchMessage,
    content: string
  ) => Promise<boolean | void> | boolean | void
  canEditLastUserMessage?: boolean
  hideRequestUserInputBlocks?: boolean
  hiddenRequestUserInputIds?: ReadonlySet<string>
  renderGapAfterMessage?: (
    message: WorkbenchMessage,
    nextMessage: WorkbenchMessage | undefined
  ) => ReactNode
}

const USER_MESSAGE_COLLAPSE_LINES = 10
const USER_MESSAGE_COLLAPSE_CHARACTERS = 600
const MESSAGE_LAYOUT_RESIZE_SETTLE_MS = 120
const CODEX_FILE_MENTIONS_HEADER_PATTERN = /^\s*# Files mentioned by the user:\s*/i
const CODEX_REQUEST_MARKER_PATTERN = /^## My request for Codex:\s*$/im
const CODEX_FILE_MENTION_LINE_PATTERN = /^##\s+(.+?):\s+(.+)$/gm
const CODEX_IMPLEMENT_PLAN_USER_MESSAGE_PREFIX = 'PLEASE IMPLEMENT THIS PLAN:'
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
  onEditLastUserMessage,
  canEditLastUserMessage = false,
  hideRequestUserInputBlocks,
  hiddenRequestUserInputIds,
  renderGapAfterMessage,
}: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const layoutWidthUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [isTextSelectionActive, setIsTextSelectionActive] = useState(false)
  const [layoutWidth, setLayoutWidth] = useState(0)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [submittingEditMessageId, setSubmittingEditMessageId] = useState<string | null>(null)
  const isTauri = isTauriRuntime()
  const visibleMessages = useMemo(() => messages.filter(shouldRenderMessage), [messages])
  const editableLastUserMessageId = useMemo(
    () =>
      editableLastUserMessage(
        visibleMessages,
        canEditLastUserMessage && Boolean(onEditLastUserMessage)
      )?.id ?? null,
    [canEditLastUserMessage, onEditLastUserMessage, visibleMessages]
  )
  const activeEditingMessageId =
    editingMessageId === editableLastUserMessageId ? editingMessageId : null
  const activeSubmittingEditMessageId =
    submittingEditMessageId === editableLastUserMessageId ? submittingEditMessageId : null
  const shouldShowWaitingIndicator =
    isWaitingForAssistant &&
    !messages.some(message => message.role === 'assistant' && message.status === 'streaming')
  const disableMessageContentVisibility =
    disableContentVisibility || isTextSelectionActive || isTauri
  const messageIntrinsicHeights = useMemo(() => {
    return new Map(
      visibleMessages.map(message => [
        message.id,
        getMessagePretextIntrinsicHeight(message, layoutWidth),
      ])
    )
  }, [layoutWidth, visibleMessages])
  const listLayoutClass = className
    ? 'mx-auto flex min-w-0 flex-col gap-4 pb-2 pt-8'
    : 'mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4 px-6 pb-2 pt-8'

  useLayoutEffect(() => {
    const element = listRef.current
    if (!element) return

    const updateLayoutWidth = () => {
      setLayoutWidth(currentWidth => {
        const nextWidth = element.clientWidth
        return nextWidth === currentWidth ? currentWidth : nextWidth
      })
    }

    const scheduleLayoutWidthUpdate = () => {
      if (layoutWidthUpdateTimerRef.current !== null) {
        clearTimeout(layoutWidthUpdateTimerRef.current)
      }

      layoutWidthUpdateTimerRef.current = setTimeout(() => {
        layoutWidthUpdateTimerRef.current = null
        updateLayoutWidth()
      }, MESSAGE_LAYOUT_RESIZE_SETTLE_MS)
    }

    updateLayoutWidth()
    if (typeof ResizeObserver === 'undefined') return

    const resizeObserver = new ResizeObserver(scheduleLayoutWidthUpdate)
    resizeObserver.observe(element)
    return () => {
      resizeObserver.disconnect()
      if (layoutWidthUpdateTimerRef.current !== null) {
        clearTimeout(layoutWidthUpdateTimerRef.current)
        layoutWidthUpdateTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (isTauri) {
      return
    }

    const updateSelectionState = () => {
      const selection = document.getSelection?.()
      const root = listRef.current
      if (!selection || !root || selection.isCollapsed || selection.rangeCount === 0) {
        setIsTextSelectionActive(false)
        return
      }

      const selectionTouchesList =
        isNodeInsideElement(selection.anchorNode, root) ||
        isNodeInsideElement(selection.focusNode, root)
      setIsTextSelectionActive(selectionTouchesList)
    }

    const handlePointerUp = () => {
      window.requestAnimationFrame(updateSelectionState)
    }

    const handleBlur = () => {
      updateSelectionState()
    }

    document.addEventListener('pointerup', handlePointerUp)
    document.addEventListener('pointercancel', handlePointerUp)
    document.addEventListener('selectionchange', updateSelectionState)
    window.addEventListener('blur', handleBlur)

    return () => {
      document.removeEventListener('pointerup', handlePointerUp)
      document.removeEventListener('pointercancel', handlePointerUp)
      document.removeEventListener('selectionchange', updateSelectionState)
      window.removeEventListener('blur', handleBlur)
    }
  }, [isTauri])

  if (visibleMessages.length === 0 && !shouldShowWaitingIndicator) {
    return null
  }

  return (
    <div ref={listRef} className={cn(listLayoutClass, className)}>
      {visibleMessages.map((message, index) => {
        const nextMessage = visibleMessages[index + 1]
        return (
          <Fragment key={message.id}>
            <article
              className={[
                'min-w-0',
                disableMessageContentVisibility ? '' : '[content-visibility:auto]',
                message.role === 'user' ? 'flex justify-end' : '',
              ].join(' ')}
              style={
                disableMessageContentVisibility
                  ? undefined
                  : getMessageContainmentStyle(messageIntrinsicHeights.get(message.id))
              }
              data-message-id={message.id}
              data-testid={`message-${message.role}`}
            >
              {message.role === 'user' ? (
                <UserMessage
                  message={message}
                  onOpenWorkspaceFile={onOpenWorkspaceFile}
                  editable={message.id === editableLastUserMessageId}
                  editing={message.id === activeEditingMessageId}
                  editSubmitting={message.id === activeSubmittingEditMessageId}
                  onStartEdit={() => setEditingMessageId(message.id)}
                  onCancelEdit={() => setEditingMessageId(null)}
                  onSubmitEdit={async content => {
                    if (!onEditLastUserMessage) return false
                    setSubmittingEditMessageId(message.id)
                    try {
                      const result = await onEditLastUserMessage(message, content)
                      if (result !== false) {
                        setEditingMessageId(null)
                      }
                      return result
                    } finally {
                      setSubmittingEditMessageId(current =>
                        current === message.id ? null : current
                      )
                    }
                  }}
                />
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
        <article className="min-w-0" data-testid="message-assistant-waiting">
          <AssistantThinkingIndicator />
        </article>
      )}
    </div>
  )
}, areMessageListPropsEqual)

function getMessageContainmentStyle(estimatedHeight: number | undefined): CSSProperties {
  return {
    containIntrinsicSize: `0 ${Math.ceil(estimatedHeight ?? 220)}px`,
  } as CSSProperties
}

function isNodeInsideElement(node: Node | null, root: HTMLElement): boolean {
  if (!node) return false

  if (node.nodeType === Node.ELEMENT_NODE) {
    return root.contains(node)
  }

  return Boolean(node.parentElement && root.contains(node.parentElement))
}

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
    previous.onOpenAssistantPlan !== next.onOpenAssistantPlan ? 'onOpenAssistantPlan' : null,
    previous.onEditLastUserMessage !== next.onEditLastUserMessage ? 'onEditLastUserMessage' : null,
    previous.canEditLastUserMessage !== next.canEditLastUserMessage
      ? 'canEditLastUserMessage'
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
  if (message.references?.length || message.memoryCitations?.length) {
    return true
  }

  const visibleContent = shouldHideFailedAssistantContent(message) ? '' : message.content
  if (visibleContent.trim()) return true

  return getDisplayProcessingBlocks(message.blocks).length > 0
}

function editableLastUserMessage(
  messages: WorkbenchMessage[],
  canEdit: boolean
): WorkbenchMessage | null {
  if (!canEdit) return null

  const lastUserIndex = findLastIndex(messages, message => message.role === 'user')
  if (lastUserIndex === -1) return null

  const followingMessages = messages.slice(lastUserIndex + 1)
  if (followingMessages.length === 0) return null
  if (followingMessages.some(message => message.status === 'streaming')) return null
  if (!followingMessages.some(message => message.role === 'assistant')) return null

  return messages[lastUserIndex] ?? null
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item !== undefined && predicate(item)) return index
  }
  return -1
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

function getStoppedElapsedDuration(message: WorkbenchMessage): string | null {
  const startedAt = getTurnStartMs(message.createdAt)
  if (startedAt === undefined) return null

  const completedAt = getMessageTimestampMs(message.completedAt)
  if (completedAt !== undefined && completedAt >= startedAt) {
    const durationMs = completedAt - startedAt
    return durationMs >= 1000 ? formatCompactDuration(durationMs) : null
  }

  const blockEndTimes =
    message.blocks
      ?.map(block => block.createdAt)
      .filter((createdAt): createdAt is number => Number.isFinite(createdAt)) ?? []
  const endedAt = blockEndTimes.length > 0 ? Math.max(...blockEndTimes) : startedAt

  const durationMs = endedAt - startedAt
  return durationMs >= 1000 ? formatCompactDuration(durationMs) : null
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
  editable = false,
  editing = false,
  editSubmitting = false,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
}: {
  message: WorkbenchMessage
  onOpenWorkspaceFile?: (path: string) => void
  editable?: boolean
  editing?: boolean
  editSubmitting?: boolean
  onStartEdit?: () => void
  onCancelEdit?: () => void
  onSubmitEdit?: (content: string) => Promise<boolean | void> | boolean | void
}) {
  const { t } = useTranslation('common')
  const [isExpanded, setIsExpanded] = useState(false)
  const [areHoverActionsVisible, setAreHoverActionsVisible] = useState(false)
  const codexLocalFileMentions = useMemo(
    () => parseCodexLocalFileMentions(message.content),
    [message.content]
  )
  const displayContent = normalizeCodexUserMessageContent(
    codexLocalFileMentions?.requestText ?? message.content
  )
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
  const showGoalRequestBadge = message.runtimeGoalRequest === true

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
              <MessageDocumentAttachment
                key={attachment.id}
                attachment={attachment}
                onOpenFile={onOpenWorkspaceFile}
              />
            ))}
          </div>
        )}
        {displayContent && editing ? (
          <UserMessageEditForm
            initialContent={displayContent}
            submitting={editSubmitting}
            onCancel={onCancelEdit}
            onSubmit={onSubmitEdit}
          />
        ) : displayContent ? (
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
              {showGoalRequestBadge && (
                <div className="mt-1.5 flex">
                  <span
                    data-testid="user-message-goal-badge"
                    className="inline-flex h-6 w-fit items-center gap-1 rounded-md border border-border/70 bg-background/70 px-2 text-xs font-medium leading-none text-text-secondary"
                  >
                    <Target className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{t('workbench.goal_chip', '目标')}</span>
                  </span>
                </div>
              )}
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
        ) : null}
        {showSourceBadge && (
          <div
            data-testid="message-source-row"
            className="flex min-h-5 items-center justify-end gap-1"
          >
            <ImSourceBadge source={message.source} testId="message-source-badge" />
          </div>
        )}
      </div>
      {!editing && (
        <MessageHoverActions
          message={message}
          align="right"
          visible={areHoverActionsVisible}
          onEdit={editable ? onStartEdit : undefined}
        />
      )}
    </div>
  )
}

function UserMessageEditForm({
  initialContent,
  submitting,
  onCancel,
  onSubmit,
}: {
  initialContent: string
  submitting: boolean
  onCancel?: () => void
  onSubmit?: (content: string) => Promise<boolean | void> | boolean | void
}) {
  const [draft, setDraft] = useState(initialContent)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const trimmedDraft = draft.trim()
  const submitDisabled = submitting || trimmedDraft.length === 0

  const resizeTextarea = () => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 280)}px`
  }

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    resizeTextarea()
  }, [])

  useLayoutEffect(() => {
    resizeTextarea()
  }, [draft])

  const submit = () => {
    if (submitDisabled) return
    void onSubmit?.(trimmedDraft)
  }

  return (
    <div
      data-testid="edit-user-message-form"
      className="w-[min(560px,80vw)] max-w-full rounded-2xl bg-muted px-3 py-2 text-[13px] leading-5 text-text-primary"
    >
      <textarea
        ref={textareaRef}
        data-testid="edit-user-message-textarea"
        value={draft}
        disabled={submitting}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter' && event.shiftKey) return
          if (event.key === 'Enter') {
            event.preventDefault()
            submit()
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel?.()
          }
        }}
        className="block max-h-[280px] min-h-24 w-full resize-none overflow-y-auto rounded-xl border border-border bg-base px-3 py-2 text-[13px] leading-5 text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-wait disabled:opacity-70"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          data-testid="cancel-edit-user-message-button"
          disabled={submitting}
          onClick={onCancel}
          className="flex h-8 items-center justify-center rounded-md px-3 text-[13px] font-medium text-text-secondary hover:bg-surface disabled:cursor-not-allowed disabled:opacity-60"
        >
          取消
        </button>
        <button
          type="button"
          data-testid="submit-edit-user-message-button"
          disabled={submitDisabled}
          onClick={submit}
          className="flex h-8 items-center justify-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-contrast hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          发送
        </button>
      </div>
    </div>
  )
}

function normalizeCodexUserMessageContent(content: string): string {
  return content.trimStart().startsWith(CODEX_IMPLEMENT_PLAN_USER_MESSAGE_PREFIX)
    ? CODEX_IMPLEMENT_PLAN_RESPONSE_LABEL
    : content
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

function openableAttachmentPath(attachment: Attachment): string | null {
  return attachment.local_path?.trim() || attachment.local_preview_url?.trim() || null
}

async function openLocalAttachmentPath(
  path: string,
  onOpenFile?: (path: string) => void
): Promise<void> {
  try {
    await openLocalFile(path)
  } catch (error) {
    if (onOpenFile) {
      onOpenFile(path)
      return
    }
    console.error('Failed to open local attachment:', error)
  }
}

function MessageDocumentAttachment({
  attachment,
  onOpenFile,
}: {
  attachment: Attachment
  onOpenFile?: (path: string) => void
}) {
  if (isTextAttachment(attachment)) {
    return <MessageTextAttachment attachment={attachment} onOpenFile={onOpenFile} />
  }

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

function MessageTextAttachment({
  attachment,
  onOpenFile,
}: {
  attachment: Attachment
  onOpenFile?: (path: string) => void
}) {
  const preview = getAttachmentTextPreview(attachment) ?? attachment.filename
  const attachmentPath = openableAttachmentPath(attachment)
  const clickable = Boolean(attachmentPath)
  const className =
    'inline-flex h-9 max-w-[360px] items-center gap-2 rounded-full border border-border bg-muted px-3 text-left text-[13px] font-semibold leading-none text-text-primary shadow-sm'
  const content = (
    <>
      <FileText
        data-testid="message-text-attachment-icon"
        className="h-3.5 w-3.5 shrink-0 text-text-muted"
        strokeWidth={1.8}
      />
      <span data-testid="message-text-attachment-preview" className="min-w-0 truncate">
        {preview}
      </span>
    </>
  )

  if (clickable && attachmentPath) {
    return (
      <button
        type="button"
        data-testid="message-text-attachment"
        className={`${className} cursor-pointer hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2`}
        aria-label={preview}
        title={preview}
        onClick={() => {
          void openLocalAttachmentPath(attachmentPath, onOpenFile)
        }}
      >
        {content}
      </button>
    )
  }

  return (
    <div
      data-testid="message-text-attachment"
      className={className}
      aria-label={preview}
      title={preview}
    >
      {content}
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
  onEdit,
}: {
  message: WorkbenchMessage
  align: 'left' | 'right'
  visible: boolean
  onEdit?: () => void
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

  const editAction = onEdit ? (
    <span
      data-testid="edit-message-action"
      className="group/edit relative flex h-6 w-6 items-center justify-center"
    >
      <button
        type="button"
        data-testid="edit-message-button"
        onClick={event => {
          if (event.detail > 0) {
            event.currentTarget.blur()
          }
          onEdit()
        }}
        title="编辑"
        className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-muted hover:text-text-secondary"
        aria-label="编辑消息"
      >
        <Pencil data-testid="edit-message-icon" className="h-3.5 w-3.5" />
      </button>
      <span
        data-testid="edit-message-label"
        className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-base px-1.5 py-0.5 text-xs text-text-secondary opacity-0 shadow-sm transition-opacity group-hover/edit:opacity-100"
      >
        编辑
      </span>
    </span>
  ) : null

  const timeLabel = time ? (
    <span
      data-testid="message-hover-time"
      className="select-none whitespace-nowrap px-1 text-xs text-text-muted"
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
        'flex min-h-5 select-none items-center gap-1 text-xs text-text-muted transition-opacity duration-150',
        visible ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0',
        align === 'right' ? 'justify-end' : 'justify-start',
      ].join(' ')}
    >
      {align === 'right' ? (
        <>
          {timeLabel}
          {copyAction}
          {editAction}
        </>
      ) : (
        <>
          {editAction}
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
  onLoadFileChangesDiff?: (subtaskId: string) => Promise<string>
  onRevertFileChanges?: (subtaskId: string) => Promise<TurnFileChangesSummary>
  onOpenFileChangesReview?: (request: {
    subtaskId: string
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
  const stoppedElapsedDuration =
    isCancelled && message.stoppedNotice !== false ? getStoppedElapsedDuration(message) : null
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
  const hasRunningBlocks = hasRunningProcessingBlocks(displayBlocks)
  const isAssistantRunning = isStreaming || hasRunningBlocks
  const canShowFinalArtifacts = !isAssistantRunning
  const hasStreamedResponse = hasBlocks || hasVisibleContent
  const shouldShowProcessingSummary = hasBlocks || (isAssistantRunning && hasStreamedResponse)
  const shouldShowThinking = shouldShowAssistantThinkingIndicator({
    isAssistantRunning,
    hasVisibleContent,
    hasLiveProcessingDisplayBlock: hasLiveProcessingDisplayBlock(displayBlocks),
  })
  const webSearchSources = isStreaming
    ? []
    : getWebSearchSourceItems(getWebSearchToolBlocks(displayBlocks))
  const memoryCitations = message.memoryCitations ?? []
  const [areHoverActionsVisible, setAreHoverActionsVisible] = useState(false)

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
  const references = getAssistantReferences(message.references, visibleContent, message.fileChanges)

  return (
    <div className="min-w-0 max-w-full text-[13px] leading-6 text-text-primary">
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
              className="mb-3 w-full border-b border-border pb-2 text-xs text-text-muted"
            >
              {stoppedElapsedDuration
                ? t('assistant_status.stopped_after', {
                    duration: stoppedElapsedDuration,
                  })
                : t('assistant_status.stopped')}
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
              stateKey={getMessageDisplayStateKey(conversationKey, message)}
              onOpenWorkspaceFile={onOpenWorkspaceFile}
              onRequestUserInputSubmit={onRequestUserInputSubmit}
              onRequestUserInputIgnore={onRequestUserInputIgnore}
              onOpenAssistantPlan={onOpenAssistantPlan}
              hideRequestUserInputBlocks={hideRequestUserInputBlocks}
              hiddenRequestUserInputIds={hiddenRequestUserInputIds}
            />
          )}
          {shouldShowThinking && !hasVisibleContent && <AssistantThinkingIndicator />}
          {hasVisibleContent ? (
            <AssistantMarkdown content={visibleContent} onOpenFile={openFileFromLink} />
          ) : null}
          {shouldShowThinking && hasVisibleContent && <AssistantThinkingIndicator />}
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
          message.subtaskId &&
          onLoadFileChangesDiff &&
          onRevertFileChanges ? (
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

function hasRunningProcessingBlocks(blocks: ProcessingBlock[]): boolean {
  return blocks.some(block => block.status !== 'done' && block.status !== 'error')
}

function hasLiveProcessingDisplayBlock(blocks: ProcessingBlock[]): boolean {
  return buildProcessingDisplayRows(blocks).some(row => {
    if (row.type !== 'block') return false

    const { block } = row
    return (
      block.status !== 'done' &&
      block.status !== 'error' &&
      (block.type === 'tool' || block.type === 'file_changes' || Boolean(block.content.trim()))
    )
  })
}

function shouldShowAssistantThinkingIndicator({
  isAssistantRunning,
  hasVisibleContent,
  hasLiveProcessingDisplayBlock,
}: {
  isAssistantRunning: boolean
  hasVisibleContent: boolean
  hasLiveProcessingDisplayBlock: boolean
}): boolean {
  if (!isAssistantRunning) return false
  if (hasVisibleContent) return true
  return !hasLiveProcessingDisplayBlock
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
