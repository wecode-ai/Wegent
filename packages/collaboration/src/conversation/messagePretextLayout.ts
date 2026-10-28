import { layout, prepare } from '@chenglou/pretext'
import type { PreparedText } from '@chenglou/pretext'
import type { Attachment } from '@wegent/chat-core/runtime'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import { isImageAttachment } from '../issue-detail/attachmentPresentation'
import { COLLAPSED_PROCESSING_HEIGHT } from './blocks/ToolBlocksDisplay'
import { DEFAULT_CODE_FONT_SIZE, DEFAULT_UI_FONT_SIZE } from '../theme/typography'

const DEFAULT_LAYOUT_WIDTH = 720
const MIN_TEXT_WIDTH = 160
export interface MessageLayoutTypography {
  font: string
  userFont: string
  lineHeight: number
  userLineHeight: number
  codeLineHeight: number
}

export function readMessageLayoutTypography(element?: HTMLElement | null): MessageLayoutTypography {
  const style = element ? getComputedStyle(element) : null
  const size =
    Number.parseFloat(style?.getPropertyValue('--text-chat') ?? '') || DEFAULT_UI_FONT_SIZE
  const userSize = Number.parseFloat(style?.getPropertyValue('--text-base') ?? '') || size
  const family =
    style?.getPropertyValue('--font-ui').trim() || style?.fontFamily || 'system-ui, sans-serif'
  const weight = style?.getPropertyValue('--font-weight-ui').trim() || style?.fontWeight || '400'
  const rootSize =
    typeof document === 'undefined'
      ? 16
      : Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  const paragraph = element?.querySelector<HTMLElement>(
    '[data-testid="message-assistant"] p[data-scroll-anchor]'
  )
  const paragraphLineHeight = paragraph
    ? Number.parseFloat(getComputedStyle(paragraph).lineHeight)
    : 0
  return {
    font: `${weight} ${size}px ${family}`,
    userFont: `${weight} ${userSize}px ${family}`,
    lineHeight: paragraphLineHeight || rootSize * 1.5,
    userLineHeight: rootSize * 1.25,
    codeLineHeight:
      (Number.parseFloat(style?.getPropertyValue('--text-code') ?? '') || DEFAULT_CODE_FONT_SIZE) *
      1.8,
  }
}

const DEFAULT_TYPOGRAPHY = readMessageLayoutTypography()
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
const MESSAGE_VERTICAL_BUFFER = 12
const MAX_LAYOUT_CACHE_SIZE = 1200
const STREAMING_MESSAGE_INTRINSIC_HEIGHT = 220
// `MarkdownCodeBlock` renders fenced code in a horizontally scrolling `<pre>`: `--text-code` at
// `line-height: 1.8`, a 40px header, 24px of padding and 20px of margin.
const CODE_BLOCK_CHROME_HEIGHT = 84
const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})/
const FENCE_CLOSE_PATTERN = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

const messageLayoutHeightCache = new Map<string, number>()
let messageObjectLayoutHeightCache = new WeakMap<WorkbenchMessage, Map<string, number>>()
let messagePreparedTextCache = new WeakMap<WorkbenchMessage, Map<string, PreparedText>>()
const messageSignatureCache = new WeakMap<WorkbenchMessage, string>()
const blockSignatureCache = new WeakMap<object, string>()
let fontMetricsRevision = 0
let observedFonts: FontFaceSet | undefined

export function getMessageFontMetricsRevision(): number {
  const fonts = typeof document === 'undefined' ? undefined : document.fonts
  if (fonts && fonts !== observedFonts) {
    observedFonts = fonts
    fonts.addEventListener('loadingdone', () => {
      fontMetricsRevision += 1
      clearMessagePretextLayoutCache()
    })
  }
  return fontMetricsRevision
}

export function getMessagePretextIntrinsicHeight(
  message: WorkbenchMessage,
  containerWidth: number,
  typography: MessageLayoutTypography = DEFAULT_TYPOGRAPHY
): number {
  if (message.status === 'streaming') {
    return STREAMING_MESSAGE_INTRINSIC_HEIGHT
  }

  const width = normalizeLayoutWidth(containerWidth)
  const layoutKey = `${width}|${JSON.stringify(typography)}`
  const objectCachedHeight = messageObjectLayoutHeightCache.get(message)?.get(layoutKey)
  if (objectCachedHeight !== undefined) return objectCachedHeight

  const cacheKey = `${getMessageLayoutSignature(message)}|${layoutKey}`
  const cachedHeight = messageLayoutHeightCache.get(cacheKey)
  if (cachedHeight !== undefined) {
    setObjectCachedLayoutHeight(message, layoutKey, cachedHeight)
    return cachedHeight
  }

  const height =
    message.role === 'user'
      ? estimateUserMessageHeight(message, width, typography)
      : estimateAssistantMessageHeight(message, width, typography)

  setCachedLayoutHeight(cacheKey, height)
  setObjectCachedLayoutHeight(message, layoutKey, height)
  return height
}

export function clearMessagePretextLayoutCache() {
  messageLayoutHeightCache.clear()
  messageObjectLayoutHeightCache = new WeakMap()
  messagePreparedTextCache = new WeakMap()
}

function setObjectCachedLayoutHeight(message: WorkbenchMessage, width: string, height: number) {
  const cachedByWidth = messageObjectLayoutHeightCache.get(message)
  if (cachedByWidth) {
    if (cachedByWidth.size >= 8) cachedByWidth.delete(cachedByWidth.keys().next().value!)
    cachedByWidth.set(width, height)
    return
  }
  messageObjectLayoutHeightCache.set(message, new Map([[width, height]]))
}

function estimateUserMessageHeight(
  message: WorkbenchMessage,
  containerWidth: number,
  typography: MessageLayoutTypography
): number {
  const contentWidth = Math.max(
    MIN_TEXT_WIDTH,
    Math.floor(containerWidth * USER_MAX_WIDTH_RATIO) - USER_CONTENT_HORIZONTAL_PADDING
  )
  const textHeight = message.content
    ? measurePretextHeight(
        message,
        message.content,
        contentWidth,
        typography.userLineHeight,
        typography.userFont
      )
    : 0
  const collapsedTextHeight = shouldCollapseUserMessage(message.content)
    ? Math.min(textHeight, COLLAPSED_USER_TEXT_HEIGHT) + USER_COLLAPSE_BUTTON_HEIGHT
    : textHeight
  const attachmentHeight = estimateAttachmentStackHeight(message.attachments)
  const contentHeight =
    (collapsedTextHeight > 0 ? collapsedTextHeight + MESSAGE_VERTICAL_BUFFER : 0) + attachmentHeight

  return Math.max(MIN_USER_ROW_HEIGHT, contentHeight + HOVER_ACTION_HEIGHT)
}

function estimateAssistantMessageHeight(
  message: WorkbenchMessage,
  containerWidth: number,
  typography: MessageLayoutTypography
): number {
  if (message.status === 'failed' && !message.content.trim()) {
    return FAILED_ASSISTANT_CARD_HEIGHT + HOVER_ACTION_HEIGHT
  }

  const textHeight = message.content.trim()
    ? measureAssistantMarkdownHeight(message, containerWidth, typography)
    : 0
  // A finished turn renders its process section collapsed: one summary row, however many blocks it ran.
  // The per-block rows only exist once the reader opens it, and that re-measure is a real layout change,
  // so budgeting a block row per block counted heights that were never on screen — the conversation's
  // height then fell by exactly that much as each row was reached and measured.
  const blockHeight = (message.blocks?.length ?? 0) > 0 ? COLLAPSED_PROCESSING_HEIGHT : 0
  const finalArtifactsHeight =
    (message.references?.length || message.memoryCitations?.length || message.fileChanges
      ? FINAL_ARTIFACT_CARD_HEIGHT
      : 0) + (message.status === 'failed' ? FAILED_ASSISTANT_CARD_HEIGHT : 0)

  return Math.max(
    MIN_ASSISTANT_ROW_HEIGHT,
    textHeight + blockHeight + finalArtifactsHeight + HOVER_ACTION_HEIGHT + MESSAGE_VERTICAL_BUFFER
  )
}

/**
 * Fenced code does not wrap in the transcript — `MarkdownCodeBlock` renders it in a horizontally
 * scrolling `<pre>` — so measuring the raw source as wrapped text counts every long code line as two
 * or more lines. For a code-heavy answer that made the intrinsic height several times the height the
 * answer actually renders at, which is what pushed the conversation's content height down (and the
 * scrollbar with it) while the reader scrolled up through it.
 */
function measureAssistantMarkdownHeight(
  message: WorkbenchMessage,
  containerWidth: number,
  typography: MessageLayoutTypography
): number {
  let height = 0
  for (const block of splitMarkdownCodeBlocks(message.content)) {
    height +=
      block.kind === 'code'
        ? Math.max(1, block.lineCount) * typography.codeLineHeight + CODE_BLOCK_CHROME_HEIGHT
        : measurePretextHeight(
            message,
            block.content,
            containerWidth,
            typography.lineHeight,
            typography.font
          )
  }
  return height
}

type MarkdownCodeBlock = { kind: 'text'; content: string } | { kind: 'code'; lineCount: number }

/** Splits markdown into the wrapped prose the renderer reflows and the fenced code it does not. */
function splitMarkdownCodeBlocks(source: string): MarkdownCodeBlock[] {
  const blocks: MarkdownCodeBlock[] = []
  let prose = ''
  let openFence: { marker: string; length: number; code: string } | null = null
  for (const line of source.match(/.*(?:\n|$)/g) ?? []) {
    const trimmedLine = line.replace(/\r?\n$/, '')
    if (openFence) {
      const closing = trimmedLine.match(FENCE_CLOSE_PATTERN)?.[1]
      if (closing?.startsWith(openFence.marker) && closing.length >= openFence.length) {
        blocks.push({ kind: 'code', lineCount: countLines(openFence.code) })
        openFence = null
        continue
      }
      openFence.code += line
      continue
    }
    const opening = trimmedLine.match(FENCE_OPEN_PATTERN)?.[1]
    if (opening) {
      if (prose) {
        blocks.push({ kind: 'text', content: prose })
        prose = ''
      }
      openFence = {
        marker: opening[0] ?? '`',
        length: opening.length,
        code: '',
      }
      continue
    }
    prose += line
  }
  if (openFence) {
    blocks.push({ kind: 'code', lineCount: countLines(openFence.code) })
  }
  if (prose) {
    blocks.push({ kind: 'text', content: prose })
  }
  return blocks
}

function countLines(text: string): number {
  const trimmed = text.replace(/\n$/, '')
  return trimmed ? trimmed.split('\n').length : 0
}

function measurePretextHeight(
  message: WorkbenchMessage,
  text: string,
  width: number,
  lineHeight: number,
  font: string
): number {
  try {
    const prepared = getPreparedMessageText(message, text, font)
    return layout(prepared, Math.max(MIN_TEXT_WIDTH, width), lineHeight).height
  } catch {
    return estimateFallbackTextHeight(text, width, lineHeight)
  }
}

function getPreparedMessageText(
  message: WorkbenchMessage,
  text: string,
  font: string
): PreparedText {
  let preparedBlocks = messagePreparedTextCache.get(message)
  const key = `${font}|${text}`
  const cached = preparedBlocks?.get(key)
  if (cached) return cached

  const prepared = prepare(text, font, { whiteSpace: 'pre-wrap' })
  if (!preparedBlocks) {
    preparedBlocks = new Map()
    messagePreparedTextCache.set(message, preparedBlocks)
  }
  // Preparation is width-independent; keep it with the message, not each width's height.
  preparedBlocks.set(key, prepared)
  return prepared
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
  return Math.max(MIN_TEXT_WIDTH, Math.round(normalizedWidth))
}

export function getMessageLayoutSignature(message: WorkbenchMessage): string {
  const cached = messageSignatureCache.get(message)
  if (cached) return cached
  const signature = [
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
  messageSignatureCache.set(message, signature)
  return signature
}

function getBlockSignature(message: WorkbenchMessage): string {
  return (message.blocks ?? [])
    .map(block => {
      const cached = blockSignatureCache.get(block)
      if (cached) return cached
      // Equal lengths do not imply equal wrapping, cards or rendered controls.
      const signature = stableTextHash(JSON.stringify(block))
      blockSignatureCache.set(block, signature)
      return signature
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
