import { layout, prepare } from '@chenglou/pretext'
import type { Attachment } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import { isImageAttachment } from '@/lib/attachments'

const DEFAULT_LAYOUT_WIDTH = 720
const MIN_TEXT_WIDTH = 160
const ASSISTANT_FONT =
  '13px Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
const USER_FONT = '13px Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
const ASSISTANT_LINE_HEIGHT = 24
const USER_LINE_HEIGHT = 20
const USER_CONTENT_HORIZONTAL_PADDING = 32
const USER_MAX_WIDTH_RATIO = 0.8
const HOVER_ACTION_HEIGHT = 20
const MIN_ASSISTANT_ROW_HEIGHT = 44
const MIN_USER_ROW_HEIGHT = 48
const COLLAPSED_USER_TEXT_HEIGHT = 176
const USER_COLLAPSE_BUTTON_HEIGHT = 36
const IMAGE_ATTACHMENT_HEIGHT = 80
const DOCUMENT_ATTACHMENT_HEIGHT = 34
const FAILED_ASSISTANT_CARD_HEIGHT = 128
const FINAL_ARTIFACT_CARD_HEIGHT = 76
const PROCESSING_BLOCK_HEIGHT = 48
const MESSAGE_VERTICAL_BUFFER = 12
const WIDTH_BUCKET_SIZE = 32
const MAX_LAYOUT_CACHE_SIZE = 1200

let pretextMeasurementAvailable = true
const messageLayoutHeightCache = new Map<string, number>()

export function getMessagePretextIntrinsicHeight(
  message: WorkbenchMessage,
  containerWidth: number
): number {
  const width = normalizeLayoutWidth(containerWidth)
  const cacheKey = getMessageLayoutCacheKey(message, width)
  const cachedHeight = messageLayoutHeightCache.get(cacheKey)
  if (cachedHeight !== undefined) return cachedHeight

  const height =
    message.role === 'user'
      ? estimateUserMessageHeight(message, width)
      : estimateAssistantMessageHeight(message, width)

  setCachedLayoutHeight(cacheKey, height)
  return height
}

export function clearMessagePretextLayoutCache() {
  messageLayoutHeightCache.clear()
  pretextMeasurementAvailable = true
}

function estimateUserMessageHeight(message: WorkbenchMessage, containerWidth: number): number {
  const contentWidth = Math.max(
    MIN_TEXT_WIDTH,
    Math.floor(containerWidth * USER_MAX_WIDTH_RATIO) - USER_CONTENT_HORIZONTAL_PADDING
  )
  const textHeight = message.content
    ? measurePretextHeight(message.content, USER_FONT, contentWidth, USER_LINE_HEIGHT)
    : 0
  const collapsedTextHeight = shouldCollapseUserMessage(message.content)
    ? Math.min(textHeight, COLLAPSED_USER_TEXT_HEIGHT) + USER_COLLAPSE_BUTTON_HEIGHT
    : textHeight
  const attachmentHeight = estimateAttachmentStackHeight(message.attachments)
  const contentHeight =
    (collapsedTextHeight > 0 ? collapsedTextHeight + MESSAGE_VERTICAL_BUFFER : 0) + attachmentHeight

  return Math.max(MIN_USER_ROW_HEIGHT, contentHeight + HOVER_ACTION_HEIGHT)
}

function estimateAssistantMessageHeight(message: WorkbenchMessage, containerWidth: number): number {
  if (message.status === 'failed' && !message.content.trim()) {
    return FAILED_ASSISTANT_CARD_HEIGHT + HOVER_ACTION_HEIGHT
  }

  const textHeight = message.content.trim()
    ? measurePretextHeight(message.content, ASSISTANT_FONT, containerWidth, ASSISTANT_LINE_HEIGHT)
    : 0
  const blockHeight = (message.blocks?.length ?? 0) * PROCESSING_BLOCK_HEIGHT
  const finalArtifactsHeight =
    (message.references?.length || message.memoryCitations?.length || message.fileChanges
      ? FINAL_ARTIFACT_CARD_HEIGHT
      : 0) + (message.status === 'failed' ? FAILED_ASSISTANT_CARD_HEIGHT : 0)

  return Math.max(
    MIN_ASSISTANT_ROW_HEIGHT,
    textHeight + blockHeight + finalArtifactsHeight + HOVER_ACTION_HEIGHT + MESSAGE_VERTICAL_BUFFER
  )
}

function measurePretextHeight(
  text: string,
  font: string,
  width: number,
  lineHeight: number
): number {
  if (!pretextMeasurementAvailable) {
    return estimateFallbackTextHeight(text, width, lineHeight)
  }

  try {
    const prepared = prepare(text, font, { whiteSpace: 'pre-wrap' })
    return layout(prepared, Math.max(MIN_TEXT_WIDTH, width), lineHeight).height
  } catch {
    pretextMeasurementAvailable = false
    return estimateFallbackTextHeight(text, width, lineHeight)
  }
}

function estimateFallbackTextHeight(text: string, width: number, lineHeight: number): number {
  const averageCharacterWidth = 7
  const charactersPerLine = Math.max(1, Math.floor(width / averageCharacterWidth))
  const lineCount = text.split('\n').reduce((count, line) => {
    return count + Math.max(1, Math.ceil(line.length / charactersPerLine))
  }, 0)

  return lineCount * lineHeight
}

function estimateAttachmentStackHeight(attachments: Attachment[] | undefined): number {
  if (!attachments?.length) return 0

  const hasImages = attachments.some(isImageAttachment)
  const documentCount = attachments.filter(attachment => !isImageAttachment(attachment)).length
  return (
    (hasImages ? IMAGE_ATTACHMENT_HEIGHT + MESSAGE_VERTICAL_BUFFER : 0) +
    documentCount * (DOCUMENT_ATTACHMENT_HEIGHT + MESSAGE_VERTICAL_BUFFER)
  )
}

function shouldCollapseUserMessage(content: string): boolean {
  return content.length > 600 || content.split('\n').length > 10
}

function normalizeLayoutWidth(width: number): number {
  const normalizedWidth = Number.isFinite(width) && width > 0 ? width : DEFAULT_LAYOUT_WIDTH
  return Math.max(
    MIN_TEXT_WIDTH,
    Math.round(normalizedWidth / WIDTH_BUCKET_SIZE) * WIDTH_BUCKET_SIZE
  )
}

function getMessageLayoutCacheKey(message: WorkbenchMessage, width: number): string {
  return [
    width,
    message.id,
    message.role,
    message.status,
    message.runtimeStatus ?? '',
    stableTextHash(message.content),
    message.error ? stableTextHash(message.error) : '',
    getBlockSignature(message),
    getAttachmentSignature(message.attachments),
    message.references?.length ?? 0,
    message.memoryCitations?.length ?? 0,
    message.fileChanges
      ? `${message.fileChanges.status}:${message.fileChanges.file_count}:${message.fileChanges.additions}:${message.fileChanges.deletions}`
      : '',
  ].join('|')
}

function getBlockSignature(message: WorkbenchMessage): string {
  return (message.blocks ?? [])
    .map(block => {
      if (block.type === 'thinking' || block.type === 'text' || block.type === 'plan') {
        return `${block.id}:${block.type}:${block.status}:${block.content.length}`
      }
      if (block.type === 'file_changes') {
        return `${block.id}:${block.type}:${block.status}:${block.fileChanges.file_count}:${block.fileChanges.diff?.length ?? 0}`
      }
      return `${block.id}:${block.type}:${block.status}:${String(block.toolOutput ?? '').length}`
    })
    .join(',')
}

function getAttachmentSignature(attachments: Attachment[] | undefined): string {
  return (attachments ?? [])
    .map(
      attachment =>
        `${attachment.id}:${attachment.status}:${attachment.file_size}:${attachment.mime_type}`
    )
    .join(',')
}

function stableTextHash(text: string): string {
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0
  }
  return `${text.length}:${hash}`
}

function setCachedLayoutHeight(cacheKey: string, height: number) {
  if (messageLayoutHeightCache.size >= MAX_LAYOUT_CACHE_SIZE) {
    const oldestKey = messageLayoutHeightCache.keys().next().value
    if (oldestKey) {
      messageLayoutHeightCache.delete(oldestKey)
    }
  }
  messageLayoutHeightCache.set(cacheKey, height)
}
