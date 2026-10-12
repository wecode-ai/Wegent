import { parseWeworkScheme } from '@/features/notifications/scheme'
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BlockNoteSchema, type Block } from '@blocknote/core'
import { createReactBlockSpec, useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import { zh } from '@blocknote/core/locales'
import { X } from 'lucide-react'
import '@blocknote/core/style.css'
import '@blocknote/react/style.css'
import '@blocknote/mantine/style.css'
import { useOptionalAppearance } from '@/features/appearance'
import { cn } from '@/lib/utils'
import {
  detectInitialImeCodeBlockDuplicate,
  detectInitialImeDuplicate,
  inlineContentText,
  type ImeCompositionSnapshot,
} from './imeComposition'
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
  const [loadState, setLoadState] = useState<{
    attachmentId: string
    src: string | null
    failed: boolean
  }>({ attachmentId, src: null, failed: false })
  const [previewOpen, setPreviewOpen] = useState(false)

  useEffect(() => {
    if (!readAttachment || !attachmentId) return
    let active = true
    let objectUrl: string | null = null
    void readAttachment(attachmentId)
      .then(blob => {
        if (!active) return
        objectUrl = URL.createObjectURL(blob)
        setLoadState({ attachmentId, src: objectUrl, failed: false })
      })
      .catch(() => {
        if (active) setLoadState({ attachmentId, src: null, failed: true })
      })
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [attachmentId, readAttachment])

  useEffect(() => {
    if (!previewOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [previewOpen])

  const currentState =
    loadState.attachmentId === attachmentId ? loadState : { attachmentId, src: null, failed: false }

  return (
    <figure
      className="task-description-attachment-image-block"
      data-testid={`task-description-attachment-image-${attachmentId}`}
      contentEditable={false}
    >
      {currentState.src ? (
        <button
          type="button"
          className="task-description-attachment-image-trigger"
          aria-label={`预览 ${filename}`}
          onClick={() => setPreviewOpen(true)}
        >
          <img src={currentState.src} alt={filename} />
        </button>
      ) : (
        <div className="task-description-attachment-image-placeholder">
          {!readAttachment || currentState.failed ? '图片加载失败' : '加载图片…'}
        </div>
      )}
      {previewOpen && currentState.src
        ? createPortal(
            <div
              className="task-description-attachment-image-lightbox"
              role="dialog"
              aria-modal="true"
              aria-label={`预览 ${filename}`}
              onClick={() => setPreviewOpen(false)}
            >
              <button
                type="button"
                className="task-description-attachment-image-lightbox-close"
                aria-label="关闭预览"
                onClick={() => setPreviewOpen(false)}
              >
                <X className="h-5 w-5" />
              </button>
              <img
                src={currentState.src}
                alt={filename}
                onClick={event => event.stopPropagation()}
              />
            </div>,
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
  const onChangeRef = useRef(onChange)
  const onPasteFilesRef = useRef(onPasteFiles)
  const onInlineAttachmentIdsChangeRef = useRef(onInlineAttachmentIdsChange)
  const composingRef = useRef(false)
  const pendingCompositionChangeRef = useRef(false)
  const compositionSnapshotRef = useRef<ImeCompositionSnapshot | null>(null)
  const repairingImeRef = useRef(false)
  // Tracks the markdown value the editor state is currently mirrored from, so
  // external value updates replace content only when they are real changes.
  const lastEmittedMarkdownRef = useRef<string | null>(null)
  // Guards onChange while an external value is being applied, so opening an
  // item never rewrites its stored description just because the editor's
  // markdown round-trip normalizes line breaks.
  const applyingExternalRef = useRef(false)

  useEffect(() => {
    onChangeRef.current = onChange
    onPasteFilesRef.current = onPasteFiles
    onInlineAttachmentIdsChangeRef.current = onInlineAttachmentIdsChange
  }, [onChange, onInlineAttachmentIdsChange, onPasteFiles])

  const editor = useCreateBlockNote({
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

  // Mirror external markdown into the editor without resetting it on every
  // keystroke: only apply the value when it differs from the markdown we last
  // emitted (or the value we last loaded).
  useEffect(() => {
    if (!editor) return
    const next = normalizeTaskDescription(value)
    if (next === lastEmittedMarkdownRef.current) return
    applyingExternalRef.current = true
    editor.replaceBlocks(editor.document, parseTaskDescriptionBlocks(editor, next))
    const finalBlock = editor.document.at(-1)
    if (finalBlock?.type === 'attachmentImage') {
      editor.insertBlocks([{ type: 'paragraph' }], finalBlock.id, 'after')
    }
    applyingExternalRef.current = false
    lastEmittedMarkdownRef.current = next
    onInlineAttachmentIdsChangeRef.current?.(inlineAttachmentIds(editor))
  }, [editor, value])

  const emitEditorChange = useCallback(() => {
    const markdown = taskDescriptionMarkdown(editor)
    onInlineAttachmentIdsChangeRef.current?.(inlineAttachmentIds(editor))
    if (applyingExternalRef.current) return
    if (markdown === lastEmittedMarkdownRef.current) return
    lastEmittedMarkdownRef.current = markdown
    onChangeRef.current(markdown)
  }, [editor])

  const handleEditorChange = useCallback(() => {
    if (composingRef.current || repairingImeRef.current) {
      pendingCompositionChangeRef.current = true
      return
    }
    pendingCompositionChangeRef.current = false
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
      const pasteFiles = onPasteFilesRef.current
      if (!files.length || !pasteFiles) return
      const referenceBlockId = editor.getTextCursorPosition().block.id
      event.preventDefault()
      event.stopPropagation()
      void Promise.resolve(pasteFiles(files)).then(markdown => {
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
    pendingCompositionChangeRef.current = false
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

        pendingCompositionChangeRef.current = false
        emitEditorChange()
      }, 0)
    },
    [editor, emitEditorChange]
  )

  return (
    <div
      className={cn('task-description-editor', className)}
      onPasteCapture={handlePasteCapture}
      onKeyDownCapture={handleKeyDownCapture}
      onCompositionStartCapture={handleCompositionStartCapture}
      onCompositionEndCapture={handleCompositionEndCapture}
    >
      <AttachmentImageServicesContext.Provider value={{ readAttachment }}>
        <BlockNoteView
          editor={editor}
          onChange={handleEditorChange}
          editable={!disabled}
          theme={appearance?.resolvedMode === 'dark' ? 'dark' : 'light'}
        />
      </AttachmentImageServicesContext.Provider>
    </div>
  )
}
