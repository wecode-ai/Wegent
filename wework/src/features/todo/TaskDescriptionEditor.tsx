import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import { zh } from '@blocknote/core/locales'
import { Maximize2, Minus, Plus, X } from 'lucide-react'
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
  onPasteFiles?: (files: File[]) => void
  readAttachment?: (attachmentId: string) => Promise<Blob>
  testId?: string
  ariaLabel?: string
  placeholder?: string
  disabled?: boolean
  className?: string
}

const DEFAULT_LINK_SCHEMES = /^(https?|ftps?|mailto|tel|callto|sms|cid|xmpp):/i
const ATTACHMENT_LINK_PREFIX = 'wegent://attachments/'
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i
const MIN_ZOOM = 0.5
const MAX_ZOOM = 4
const ZOOM_STEP = 0.25
// Pointer grace while crossing the gap between the attachment link and the
// floating preview; entering the preview cancels the timer.
const PREVIEW_HIDE_GRACE_MS = 400

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value))
}

interface AttachmentPreviewState {
  attachmentId: string
  label: string
  rect: { left: number; top: number; right: number; bottom: number }
}

function isAllowedLinkHref(href: string): boolean {
  return DEFAULT_LINK_SCHEMES.test(href) || href.startsWith('wegent://')
}

export function TaskDescriptionEditor({
  value,
  onChange,
  onPasteFiles,
  readAttachment,
  testId = 'cloud-todo-detail-description',
  ariaLabel = '任务描述',
  placeholder = '添加任务描述，输入 / 使用 Markdown…',
  disabled = false,
  className,
}: TaskDescriptionEditorProps) {
  const appearance = useOptionalAppearance()
  const onChangeRef = useRef(onChange)
  const onPasteFilesRef = useRef(onPasteFiles)
  const readAttachmentRef = useRef(readAttachment)
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
    readAttachmentRef.current = readAttachment
  }, [onChange, onPasteFiles, readAttachment])

  const editor = useCreateBlockNote({
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
    editor.replaceBlocks(editor.document, editor.tryParseMarkdownToBlocks(next))
    applyingExternalRef.current = false
    lastEmittedMarkdownRef.current = next
  }, [editor, value])

  const emitEditorChange = useCallback(() => {
    const markdown = editor.blocksToMarkdownLossy()
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

  // File pastes are routed to the shared attachment flow before ProseMirror
  // sees them, keeping image/file blocks out of the markdown description.
  const handlePasteCapture = useCallback((event: React.ClipboardEvent) => {
    const files = Array.from(event.clipboardData?.files ?? [])
    if (!files.length || !onPasteFilesRef.current) return
    event.preventDefault()
    event.stopPropagation()
    onPasteFilesRef.current(files)
  }, [])

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
              originalBlock,
              nextBlock,
              nextBlock ? editor.getParentBlock(nextBlock.id)?.id : undefined,
              committedText
            ) ??
            detectInitialImeCodeBlockDuplicate(snapshot, originalBlock, nextBlock, committedText)
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

  const [preview, setPreview] = useState<AttachmentPreviewState | null>(null)
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<{ src: string; label: string } | null>(null)
  const [zoom, setZoom] = useState(1)
  const previewRef = useRef<HTMLDivElement | null>(null)
  const previewUrlsRef = useRef(new Map<string, string>())
  const hidePreviewTimerRef = useRef<number | null>(null)

  // Fetches attachment bytes only while the image link is hovered, so opening
  // a task never downloads every embedded image.
  useEffect(() => {
    if (!preview) return
    if (previewUrlsRef.current.has(preview.attachmentId)) return
    let cancelled = false
    const reader = readAttachmentRef.current
    if (!reader) return
    reader(preview.attachmentId)
      .then(blob => {
        if (cancelled) return
        const url = URL.createObjectURL(blob)
        previewUrlsRef.current.set(preview.attachmentId, url)
        setPreviewSrc(url)
      })
      .catch(error => {
        console.error('[Wework] Failed to load attachment preview', error)
        if (!cancelled) setPreviewSrc(null)
      })
    return () => {
      cancelled = true
    }
  }, [preview])

  useEffect(() => {
    const urls = previewUrlsRef.current
    return () => {
      urls.forEach(url => URL.revokeObjectURL(url))
      urls.clear()
    }
  }, [])

  useEffect(() => {
    if (!lightbox) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLightbox(null)
      if (event.key === '=' || event.key === '+') setZoom(current => clampZoom(current + ZOOM_STEP))
      if (event.key === '-') setZoom(current => clampZoom(current - ZOOM_STEP))
      if (event.key === '0') setZoom(1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [lightbox])

  const attachmentAnchorFrom = useCallback((target: EventTarget | null) => {
    if (!(target instanceof Element)) return null
    return target.closest<HTMLAnchorElement>(`a[href^='${ATTACHMENT_LINK_PREFIX}']`)
  }, [])

  const showPreviewFor = useCallback((anchor: HTMLAnchorElement) => {
    if (hidePreviewTimerRef.current !== null) {
      window.clearTimeout(hidePreviewTimerRef.current)
      hidePreviewTimerRef.current = null
    }
    const href = anchor.getAttribute('href') ?? ''
    const attachmentId = href.slice(ATTACHMENT_LINK_PREFIX.length)
    const label = anchor.textContent?.trim() || attachmentId
    if (!IMAGE_EXTENSION.test(label) || !readAttachmentRef.current) return
    setPreviewSrc(previewUrlsRef.current.get(attachmentId) ?? null)
    const rect = anchor.getBoundingClientRect()
    setPreview({
      attachmentId,
      label,
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
    })
  }, [])

  const hidePreviewSoon = useCallback(() => {
    if (hidePreviewTimerRef.current !== null) return
    hidePreviewTimerRef.current = window.setTimeout(() => {
      hidePreviewTimerRef.current = null
      setPreview(null)
      setPreviewSrc(null)
    }, PREVIEW_HIDE_GRACE_MS)
  }, [])

  const handleMouseOver = useCallback(
    (event: React.MouseEvent) => {
      const anchor = attachmentAnchorFrom(event.target)
      if (anchor) {
        showPreviewFor(anchor)
        return
      }
      // Moving onto the preview keeps it open and cancels any pending hide
      // timer started while crossing the gap between the link and the preview.
      if (previewRef.current?.contains(event.target as Node)) {
        if (hidePreviewTimerRef.current !== null) {
          window.clearTimeout(hidePreviewTimerRef.current)
          hidePreviewTimerRef.current = null
        }
      }
    },
    [attachmentAnchorFrom, showPreviewFor]
  )

  const handleMouseOut = useCallback(
    (event: React.MouseEvent) => {
      const related = event.relatedTarget as Node | null
      if (related instanceof Element) {
        if (attachmentAnchorFrom(related)) return
        if (previewRef.current?.contains(related)) return
        if (event.currentTarget.contains(related)) {
          // Still inside the editor: give the pointer time to reach the
          // preview before hiding it.
          hidePreviewSoon()
          return
        }
      }
      // Pointer left the editor: hide immediately.
      if (hidePreviewTimerRef.current !== null) {
        window.clearTimeout(hidePreviewTimerRef.current)
        hidePreviewTimerRef.current = null
      }
      setPreview(null)
      setPreviewSrc(null)
    },
    [attachmentAnchorFrom, hidePreviewSoon]
  )

  const openLightbox = useCallback(() => {
    if (!previewSrc) return
    setZoom(1)
    setLightbox({ src: previewSrc, label: preview?.label ?? '' })
  }, [preview?.label, previewSrc])

  return (
    <div
      className={cn('task-description-editor', className)}
      onMouseOver={handleMouseOver}
      onMouseOut={handleMouseOut}
      onPasteCapture={handlePasteCapture}
      onCompositionStartCapture={handleCompositionStartCapture}
      onCompositionEndCapture={handleCompositionEndCapture}
    >
      <BlockNoteView
        editor={editor}
        onChange={handleEditorChange}
        editable={!disabled}
        theme={appearance?.resolvedMode === 'dark' ? 'dark' : 'light'}
      />
      {preview ? (
        <div
          ref={previewRef}
          className="task-description-attachment-preview"
          data-testid="cloud-todo-preview"
          style={{
            position: 'fixed',
            left: Math.min(preview.rect.right + 8, window.innerWidth - 320),
            top: Math.max(preview.rect.top, 8),
          }}
          onMouseOver={handleMouseOver}
          onMouseOut={handleMouseOut}
        >
          {previewSrc ? (
            <div className="task-description-attachment-preview-figure">
              <img
                className="task-description-attachment-preview-image"
                src={previewSrc}
                alt={preview.label}
                onClick={openLightbox}
              />
              <button
                type="button"
                data-testid="cloud-todo-preview-view"
                className="task-description-attachment-preview-view"
                aria-label="查看大图"
                title="查看大图"
                onClick={openLightbox}
              >
                <Maximize2 className="h-3.5 w-3.5" />
                查看大图
              </button>
            </div>
          ) : (
            <span className="task-description-attachment-preview-label">{preview.label}</span>
          )}
        </div>
      ) : null}
      {lightbox
        ? createPortal(
            <div
              className="task-description-image-lightbox"
              role="dialog"
              aria-label={lightbox.label}
              data-testid="cloud-todo-preview-lightbox"
              onClick={() => setLightbox(null)}
            >
              <div
                className="task-description-image-lightbox-toolbar"
                onClick={event => event.stopPropagation()}
              >
                <button
                  type="button"
                  data-testid="cloud-todo-preview-zoom-out"
                  aria-label="缩小"
                  title="缩小"
                  onClick={() => setZoom(current => clampZoom(current - ZOOM_STEP))}
                >
                  <Minus className="h-4 w-4" />
                </button>
                <span>{Math.round(zoom * 100)}%</span>
                <button
                  type="button"
                  data-testid="cloud-todo-preview-zoom-in"
                  aria-label="放大"
                  title="放大"
                  onClick={() => setZoom(current => clampZoom(current + ZOOM_STEP))}
                >
                  <Plus className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  data-testid="cloud-todo-preview-close"
                  aria-label="关闭"
                  title="关闭"
                  onClick={() => setLightbox(null)}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div
                className="task-description-image-lightbox-stage"
                onClick={event => event.stopPropagation()}
              >
                <img
                  src={lightbox.src}
                  alt={lightbox.label}
                  style={{ transform: `scale(${zoom})` }}
                />
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
