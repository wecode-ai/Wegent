import { useOptionalAppearance } from '@/features/appearance'
import { parseWeworkScheme } from '@/features/notifications/scheme'
import { normalizeClipboardImageFiles } from '@/lib/clipboard-images'
import { cn } from '@/lib/utils'
import { BlockNoteSchema, type Block } from '@blocknote/core'
import { zh } from '@blocknote/core/locales'
import '@blocknote/core/style.css'
import { BlockNoteViewRaw, createReactBlockSpec, useCreateBlockNote } from '@blocknote/react'
import '@blocknote/react/style.css'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import { useWindowEvent } from '@wegent/collaboration/dom-events'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { X } from 'lucide-react'
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { createPortal } from 'react-dom'
import {
  detectInitialImeCodeBlockDuplicate,
  detectInitialImeDuplicate,
  inlineContentText,
  type ImeCompositionSnapshot,
} from './imeComposition'
import {
  BlockNoteSdkFilePanel,
  BlockNoteSdkSideMenu,
} from './task-description-ui/BlockNoteSdkBlockMenus'
import { BlockNoteSdkProvider } from './task-description-ui/BlockNoteSdkComponents'
import { blockNoteSdkEditorOptions } from './task-description-ui/blockNoteSdkEditorOptions'
import { BlockNoteSdkEscapeShortcut } from './task-description-ui/BlockNoteSdkEscapeShortcut'
import { BlockNoteSdkFormattingToolbar } from './task-description-ui/BlockNoteSdkFormattingToolbar'
import { BlockNoteSdkLinkToolbar } from './task-description-ui/BlockNoteSdkLinkToolbar'
import { BlockNoteSdkSuggestions } from './task-description-ui/BlockNoteSdkSuggestions'
import { BlockNoteSdkTableHandles } from './task-description-ui/BlockNoteSdkTableHandles'
import { normalizeTaskDescription } from './taskDescription'

interface TaskDescriptionEditorProps {
  value: string
  onChange: (markdown: string) => void
  onPasteFiles?: (files: File[]) => void | Promise<string | null>
  readAttachment?: (attachmentId: string) => Promise<Blob>
  onInlineAttachmentIdsChange?: (attachmentIds: string[]) => void
  testId?: string
  ariaLabel?: string
  placeholder?: string
  disabled?: boolean
  className?: string
}

const DEFAULT_LINK_SCHEMES = /^(https?|ftps?|mailto|tel|callto|sms|cid|xmpp):/i
const ATTACHMENT_LINK_PREFIX = 'wegent://attachments/'
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i

interface AttachmentImageServices {
  readAttachment?: (attachmentId: string) => Promise<Blob>
}

const AttachmentImageServicesContext = createContext<AttachmentImageServices>({})

function AttachmentImageBlockView({
  attachmentId,
  filename,
}: {
  attachmentId: string
  filename: string
}) {
  const { readAttachment } = useContext(AttachmentImageServicesContext)
  const resource = useMemo(
    () =>
      createAsyncResource(
        attachmentId,
        async signal => {
          if (!readAttachment || !attachmentId)
            throw new Error('An attachment reader and identity are required')
          const blob = await readAttachment(attachmentId)
          signal.throwIfAborted()
          return URL.createObjectURL(blob)
        },
        { release: url => URL.revokeObjectURL(url) }
      ),
    [attachmentId, readAttachment]
  )
  const image = useSyncExternalStore(
    readAttachment && attachmentId ? resource.subscribe : subscribeIdleResource,
    resource.getSnapshot,
    getIdleResourceSnapshot
  )
  const src = image.data ?? null
  const failed = image.status === 'error'
  const [previewOpen, setPreviewOpen] = useState(false)
  useWindowEvent(
    'keydown',
    event => {
      if (event.key === 'Escape') setPreviewOpen(false)
    },
    { enabled: previewOpen }
  )

  return (
    <figure
      className="task-description-attachment-image-block"
      data-testid={`task-description-attachment-image-${attachmentId}`}
      contentEditable={false}
    >
      {src ? (
        <ControlButton
          variant="unstyled"
          type="button"
          className="task-description-attachment-image-trigger"
          aria-label={`预览 ${filename}`}
          onClick={() => setPreviewOpen(true)}
        >
          <img src={src} alt={filename} />
        </ControlButton>
      ) : (
        <div className="task-description-attachment-image-placeholder">
          {!readAttachment || failed ? '图片加载失败' : '加载图片…'}
        </div>
      )}
      {previewOpen && src
        ? createPortal(
            <DialogSurface
              onClose={() => setPreviewOpen(false)}
              render={
                <div
                  className="task-description-attachment-image-lightbox"
                  aria-label={`预览 ${filename}`}
                  onClick={() => setPreviewOpen(false)}
                />
              }
            >
              <ControlButton
                variant="unstyled"
                type="button"
                className="task-description-attachment-image-lightbox-close"
                aria-label="关闭预览"
                onClick={() => setPreviewOpen(false)}
              >
                <X className="h-5 w-5" />
              </ControlButton>
              <img src={src} alt={filename} onClick={event => event.stopPropagation()} />
            </DialogSurface>,
            document.body
          )
        : null}
    </figure>
  )
}

const attachmentImageBlock = createReactBlockSpec(
  {
    type: 'attachmentImage',
    propSchema: {
      attachmentId: { default: '' },
      filename: { default: '' },
    },
    content: 'none',
  },
  {
    render: ({ block }) => (
      <AttachmentImageBlockView
        attachmentId={block.props.attachmentId}
        filename={block.props.filename}
      />
    ),
    toExternalHTML: ({ block }) => (
      <div
        data-wegent-attachment-image=""
        data-attachment-id={block.props.attachmentId}
        data-filename={block.props.filename}
      />
    ),
    parse: element => {
      if (!element.hasAttribute('data-wegent-attachment-image')) return undefined
      return {
        attachmentId: element.getAttribute('data-attachment-id') ?? '',
        filename: element.getAttribute('data-filename') ?? '',
      }
    },
  }
)()

const taskDescriptionSchema = BlockNoteSchema.create().extend({
  blockSpecs: {
    attachmentImage: attachmentImageBlock,
  },
})

type TaskDescriptionBlock = typeof taskDescriptionSchema.Block
type TaskDescriptionEditorInstance = typeof taskDescriptionSchema.BlockNoteEditor

function attachmentLinkFromBlock(block: TaskDescriptionBlock): {
  attachmentId: string
  filename: string
} | null {
  if (block.type !== 'paragraph' || !Array.isArray(block.content)) return null
  if (block.content.length !== 1) return null
  const content = block.content[0]
  if (content.type !== 'link' || !content.href.startsWith(ATTACHMENT_LINK_PREFIX)) return null
  const filename = content.content
    .map(item => ('text' in item ? item.text : ''))
    .join('')
    .trim()
  if (!IMAGE_EXTENSION.test(filename)) return null
  return {
    attachmentId: content.href.slice(ATTACHMENT_LINK_PREFIX.length),
    filename,
  }
}

function parseTaskDescriptionBlocks(
  editor: TaskDescriptionEditorInstance,
  markdown: string
): TaskDescriptionBlock[] {
  return editor.tryParseMarkdownToBlocks(markdown).map(block => {
    const attachment = attachmentLinkFromBlock(block)
    if (!attachment) return block
    return {
      id: block.id,
      type: 'attachmentImage',
      props: attachment,
      content: undefined,
      children: block.children,
    }
  })
}

function taskDescriptionMarkdown(editor: TaskDescriptionEditorInstance): string {
  const documentBlocks = [...editor.document]
  const finalBlock = documentBlocks.at(-1)
  const previousBlock = documentBlocks.at(-2)
  if (
    previousBlock?.type === 'attachmentImage' &&
    finalBlock?.type === 'paragraph' &&
    Array.isArray(finalBlock.content) &&
    finalBlock.content.length === 0
  ) {
    documentBlocks.pop()
  }
  const serializableBlocks = documentBlocks.map(block => {
    if (block.type !== 'attachmentImage') return block
    return {
      id: block.id,
      type: 'paragraph' as const,
      props: {},
      content: [
        {
          type: 'link' as const,
          href: `${ATTACHMENT_LINK_PREFIX}${block.props.attachmentId}`,
          content: [
            {
              type: 'text' as const,
              text: block.props.filename,
              styles: {},
            },
          ],
        },
      ],
      children: block.children,
    }
  })
  return editor.blocksToMarkdownLossy(serializableBlocks).trimEnd()
}

function inlineAttachmentIds(editor: TaskDescriptionEditorInstance): string[] {
  return editor.document.flatMap(block =>
    block.type === 'attachmentImage' && block.props.attachmentId ? [block.props.attachmentId] : []
  )
}

function isAllowedLinkHref(href: string): boolean {
  return (
    DEFAULT_LINK_SCHEMES.test(href) ||
    href.startsWith('wegent://') ||
    Boolean(parseWeworkScheme(href))
  )
}

export function TaskDescriptionEditor({
  value,
  onChange,
  onPasteFiles,
  readAttachment,
  onInlineAttachmentIdsChange,
  testId = 'cloud-todo-detail-description',
  ariaLabel = '任务描述',
  placeholder = '添加任务描述，输入 / 使用 Markdown…',
  disabled = false,
  className,
}: TaskDescriptionEditorProps) {
  const appearance = useOptionalAppearance()
  const callbacks = useRef({ onChange, onPasteFiles, onInlineAttachmentIdsChange })
  const composingRef = useRef(false)
  const compositionSnapshotRef = useRef<ImeCompositionSnapshot | null>(null)
  const repairingImeRef = useRef(false)
  // Tracks the markdown value the editor state is currently mirrored from, so
  // external value updates replace content only when they are real changes.
  const lastEmittedMarkdownRef = useRef<string | null>(null)
  // Compare edits with the parsed document, whose Markdown may differ from the source.
  const lastSerializedMarkdownRef = useRef<string | null>(null)
  // Guards onChange while an external value is being applied, so opening an
  // item never rewrites its stored description just because the editor's
  // markdown round-trip normalizes line breaks.
  const applyingExternalRef = useRef(false)

  const editor = useCreateBlockNote({
    ...blockNoteSdkEditorOptions,
    schema: taskDescriptionSchema,
    tabBehavior: 'prefer-indent',
    dictionary: {
      ...zh,
      placeholders: {
        ...zh.placeholders,
        default: placeholder,
      },
    },
    domAttributes: {
      editor: {
        'data-testid': testId,
        'aria-label': ariaLabel,
      },
    },
    links: {
      // Attachment links stored as wegent:// URLs plus the default URI set.
      isValidLink: isAllowedLinkHref,
      // Keep attachment links inert inside the editor; downloads go through
      // the attachment section, and http(s) links use the app link handler.
      onClick: event => {
        const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
        if (anchor?.getAttribute('href')?.startsWith('wegent://')) {
          event.preventDefault()
          return true
        }
        return undefined
      },
    },
  })

  // Bind controlled content only after BlockNote's own DOM mount has committed.
  const attachEditor = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) return
      callbacks.current = { onChange, onPasteFiles, onInlineAttachmentIdsChange }
      const surface = editor.domElement
      if (surface && surface.getAttribute('aria-label') !== ariaLabel) {
        surface.setAttribute('aria-label', ariaLabel)
      }
      const next = normalizeTaskDescription(value)
      if (next === lastEmittedMarkdownRef.current) return
      applyingExternalRef.current = true
      try {
        editor.replaceBlocks(editor.document, parseTaskDescriptionBlocks(editor, next))
        const finalBlock = editor.document.at(-1)
        if (finalBlock?.type === 'attachmentImage')
          editor.insertBlocks([{ type: 'paragraph' }], finalBlock.id, 'after')
      } finally {
        applyingExternalRef.current = false
      }
      lastEmittedMarkdownRef.current = next
      lastSerializedMarkdownRef.current = taskDescriptionMarkdown(editor)
      callbacks.current.onInlineAttachmentIdsChange?.(inlineAttachmentIds(editor))
    },
    [ariaLabel, editor, onChange, onPasteFiles, onInlineAttachmentIdsChange, value]
  )

  const emitEditorChange = useCallback(() => {
    const markdown = taskDescriptionMarkdown(editor)
    callbacks.current.onInlineAttachmentIdsChange?.(inlineAttachmentIds(editor))
    if (applyingExternalRef.current) return
    if (markdown === lastSerializedMarkdownRef.current) return
    lastSerializedMarkdownRef.current = markdown
    lastEmittedMarkdownRef.current = markdown
    callbacks.current.onChange(markdown)
  }, [editor])

  const handleEditorChange = useCallback(() => {
    if (composingRef.current || repairingImeRef.current) {
      return
    }
    emitEditorChange()
  }, [emitEditorChange])

  const handleKeyDownCapture = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return
      if (
        event.key !== 'Enter' ||
        event.shiftKey ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return
      }
      const selection = editor.getSelection()
      const selectedBlock =
        selection?.blocks.length === 1 && selection.blocks[0]?.type === 'attachmentImage'
          ? selection.blocks[0]
          : null
      if (!selectedBlock) return

      event.preventDefault()
      event.stopPropagation()
      const [paragraph] = editor.insertBlocks([{ type: 'paragraph' }], selectedBlock.id, 'after')
      editor.setTextCursorPosition(paragraph.id, 'start')
      emitEditorChange()
    },
    [disabled, editor, emitEditorChange]
  )

  // File pastes are routed to the shared attachment flow before ProseMirror
  // sees them, keeping image/file blocks out of the markdown description.
  const handlePasteCapture = useCallback(
    (event: React.ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? [])
      const pasteFiles = callbacks.current.onPasteFiles
      if (!files.length || !pasteFiles) return
      const referenceBlockId = editor.getTextCursorPosition().block.id
      event.preventDefault()
      event.stopPropagation()
      void normalizeClipboardImageFiles(files)
        .then(async normalizedFiles => pasteFiles(normalizedFiles))
        .then(markdown => {
          if (!markdown) return
          const blocks = parseTaskDescriptionBlocks(editor, markdown)
          if (!blocks.length) return
          const inserted = editor.insertBlocks(blocks, referenceBlockId, 'after')
          let lastInserted = inserted.at(-1)
          if (lastInserted?.type === 'attachmentImage') {
            ;[lastInserted] = editor.insertBlocks([{ type: 'paragraph' }], lastInserted.id, 'after')
          }
          if (lastInserted) editor.setTextCursorPosition(lastInserted.id, 'end')
          emitEditorChange()
        })
    },
    [editor, emitEditorChange]
  )

  const handleCompositionStartCapture = useCallback(() => {
    composingRef.current = true
    const cursor = editor.getTextCursorPosition()
    compositionSnapshotRef.current =
      inlineContentText(cursor.block.content) === ''
        ? {
            blockId: cursor.block.id,
            nextBlockId: cursor.nextBlock?.id,
            parentBlockId: cursor.parentBlock?.id,
          }
        : null
  }, [editor])

  const handleCompositionEndCapture = useCallback(
    (event: React.CompositionEvent<HTMLDivElement>) => {
      const snapshot = compositionSnapshotRef.current
      const committedText = event.data
      compositionSnapshotRef.current = null
      composingRef.current = false

      // WebKit may split the first composition in an empty nested block into
      // two sibling blocks: the original pinyin buffer and a new committed
      // Chinese block. Wait for its native DOM transaction, then reconcile
      // only that exact shape in one undoable editor transaction.
      window.setTimeout(() => {
        if (snapshot) {
          const originalBlock = editor.getBlock(snapshot.blockId)
          const nextBlock = editor.getNextBlock(snapshot.blockId)
          const repair =
            detectInitialImeDuplicate(
              snapshot,
              originalBlock as unknown as Block | undefined,
              nextBlock as unknown as Block | undefined,
              nextBlock ? editor.getParentBlock(nextBlock.id)?.id : undefined,
              committedText
            ) ??
            detectInitialImeCodeBlockDuplicate(
              snapshot,
              originalBlock as unknown as Block | undefined,
              nextBlock as unknown as Block | undefined,
              committedText
            )
          if (repair) {
            repairingImeRef.current = true
            try {
              editor.transact(() => {
                editor.updateBlock(repair.targetBlockId, { content: repair.content })
                if (repair.duplicateBlockId) {
                  editor.removeBlocks([repair.duplicateBlockId])
                }
                editor.setTextCursorPosition(repair.targetBlockId, 'end')
              })
            } finally {
              repairingImeRef.current = false
            }
          }
        }
        emitEditorChange()
      }, 0)
    },
    [editor, emitEditorChange]
  )

  return (
    <div
      ref={attachEditor}
      className={cn('task-description-editor relative', className)}
      onPasteCapture={handlePasteCapture}
      onKeyDownCapture={handleKeyDownCapture}
      onCompositionStartCapture={handleCompositionStartCapture}
      onCompositionEndCapture={handleCompositionEndCapture}
    >
      {disabled && !normalizeTaskDescription(value).trim() ? (
        <p
          data-testid={`${testId}-empty`}
          className="pointer-events-none absolute inset-x-0 top-0 m-0 text-sm leading-7 text-text-muted"
        >
          {placeholder}
        </p>
      ) : null}
      <AttachmentImageServicesContext.Provider value={{ readAttachment }}>
        <BlockNoteSdkProvider>
          <BlockNoteViewRaw
            editor={editor}
            onChange={handleEditorChange}
            editable={!disabled}
            formattingToolbar={false}
            linkToolbar={false}
            slashMenu={false}
            emojiPicker={false}
            sideMenu={false}
            filePanel={false}
            tableHandles={false}
            comments={false}
            theme={appearance?.resolvedMode === 'dark' ? 'dark' : 'light'}
          >
            {!disabled && (
              <>
                <BlockNoteSdkEscapeShortcut />
                <BlockNoteSdkFormattingToolbar ariaLabel={ariaLabel} />
                <BlockNoteSdkLinkToolbar />
                <BlockNoteSdkSuggestions />
                <BlockNoteSdkSuggestions emoji />
                <BlockNoteSdkSideMenu />
                <BlockNoteSdkFilePanel />
                <BlockNoteSdkTableHandles />
              </>
            )}
          </BlockNoteViewRaw>
        </BlockNoteSdkProvider>
      </AttachmentImageServicesContext.Provider>
    </div>
  )
}
