import type { CodeViewFileItem } from '@pierre/diffs'
import { CodeView, EditProvider, type CodeViewHandle } from '@pierre/diffs/react'
import FileViewer from '@file-viewer/react'
import engineeringRenderers from '@file-viewer/preset-engineering'
import officeRenderers from '@file-viewer/preset-office'
import liteRenderers from '@file-viewer/preset-lite'
import { MessageSquare } from 'lucide-react'
import {
  memo,
  Profiler,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
  type ProfilerOnRenderCallback,
} from 'react'
import { AssistantMarkdown } from '@/components/chat/AssistantMarkdown'
import { DiagramImageActions } from '@/components/chat/DiagramImageActions'
import { Button } from '@/components/ui/button'
import { captureDiagramArtifact } from '@/components/chat/diagramImageExport'
import { getRuntimeConfig } from '@/config/runtime'
import { defaultAppearance, useOptionalAppearance } from '@/features/appearance'
import { useTranslation } from '@/hooks/useTranslation'
import { isEditableShortcutTarget } from '@/lib/keybindings'
import { publishSelectedTextSelection, writeSelectedTextDragData } from '@/lib/selected-text-drag'
import {
  logFilePreviewDiagnostic,
  scheduleFilePreviewMainThreadProbe,
} from '@/lib/file-preview-diagnostics'
import { installCodeViewTextDrag } from './codeViewTextDrag'
import { useCodeTheme } from '@/features/appearance/useCodeTheme'
import type { CodeCommentContext, WorkspaceTextFileResponse } from '@/types/workspace-files'
import { WorkspaceXMindPreview } from './WorkspaceXMindPreview'
import { useWorkspaceCodeEditor } from './useWorkspaceCodeEditor'
import { PierreCodeProvider } from '@/components/code/PierreCodeProvider'
import { isHtmlFile, isMarkdownFile } from './workspaceFileTypes'
import { isDocxPreviewFile, safeOfficePreviewFile } from '@/lib/safe-office-preview'

const PIERRE_WORKSPACE_CODE_VIEW_CSS = `
  :host {
    --diffs-font-size: var(--text-code);
    --diffs-line-height: var(--wework-workspace-code-line-height, calc(var(--text-code) * 1.8));
    --diffs-font-family: var(--font-code);
    --diffs-header-font-family: var(--font-ui);
    --diffs-light-bg: rgb(var(--color-bg-base));
    --diffs-light: rgb(var(--color-text-primary));
    --diffs-dark-bg: rgb(var(--color-bg-base));
    --diffs-dark: rgb(var(--color-text-primary));
    --diffs-fg-number-override: rgb(var(--color-text-muted));
    --diffs-bg-context-override: rgb(var(--color-bg-base));
    --diffs-bg-context-gutter-override: rgb(var(--color-bg-surface));
    --diffs-bg-hover-override: rgb(var(--color-muted));
    --diffs-scrollbar-gutter-override: 5px;
    --diffs-min-number-column-width: 3ch;
    background: rgb(var(--color-bg-base)) !important;
  }
  [data-diffs-header],
  [data-diffs-header="default"] {
    min-height: 36px;
    padding-inline: 12px;
    border-bottom: 1px solid rgb(var(--color-border));
    font-size: var(--text-sm);
  }
  [data-file],
  pre,
  [data-code] {
    background: rgb(var(--color-bg-base));
  }
  [data-code] {
    scrollbar-width: thin;
    scrollbar-color: rgb(var(--color-text-muted) / 0.85) transparent;
    scrollbar-gutter: stable;
  }
  [data-code]::-webkit-scrollbar {
    width: 7px;
    height: 7px;
  }
  [data-code]::-webkit-scrollbar-track {
    background: transparent;
  }
  [data-code]::-webkit-scrollbar-thumb {
    background-color: rgb(var(--color-text-muted) / 0.85);
    border-radius: 999px;
  }
  [data-code]::-webkit-scrollbar-thumb:hover {
    background-color: rgb(var(--color-text-secondary) / 0.95);
  }
  [data-gutter] {
    border-right: 1px solid rgb(var(--color-border));
    background: rgb(var(--color-bg-surface));
  }
  [data-column-number] {
    min-width: 2.75rem;
    padding-left: 0;
    padding-right: 0.5rem;
  }
  [data-line-number-content] {
    min-width: 3ch;
  }
  [data-line] {
    padding-left: 0.5rem;
    padding-right: 0.75rem;
  }
  [data-line][data-hovered],
  [data-column-number][data-hovered] {
    background: rgb(var(--color-muted));
  }
`

interface WorkspaceFilePreviewProps {
  file: WorkspaceTextFileResponse | null
  binaryFile?: {
    path: string
    name: string
    size: number
    file: File
    traceId?: string
  } | null
  loading: boolean
  loadingProgress?: { loadedBytes: number; totalBytes: number | null } | null
  error?: string | null
  onRetry: () => void
  targetLineStart?: number
  targetLineEnd?: number
  onAddCodeComment?: (context: CodeCommentContext) => void
  editing?: boolean
  editedContent?: string
  loadVersion?: number
  onEditedContentChange?: (content: string) => void
  onSave?: () => void
  previewMode?: 'preview' | 'source'
}

const FILE_VIEWER_TYPE_BY_MIME: Record<string, string> = {
  'application/epub+zip': 'epub',
  'application/msword': 'doc',
  'application/pdf': 'pdf',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/zip': 'zip',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
  'image/webp': 'webp',
  'text/csv': 'csv',
}

const DIAGRAM_FILE_VIEWER_TYPE_BY_EXTENSION: Record<string, string> = {
  mermaid: 'mermaid',
  mmd: 'mermaid',
  plantuml: 'plantuml',
  puml: 'plantuml',
}

function workspaceFileViewerType(name: string, mimeType: string): string | undefined {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  return (
    ({ csv: 'csv', tsv: 'csv', xlsm: 'xlsx' } as Record<string, string>)[extension] ??
    DIAGRAM_FILE_VIEWER_TYPE_BY_EXTENSION[extension] ??
    FILE_VIEWER_TYPE_BY_MIME[mimeType.split(';', 1)[0].trim().toLowerCase()]
  )
}

const WorkspaceBinaryFilePreview = memo(function WorkspaceBinaryFilePreview({
  file,
  themeType,
}: {
  file: NonNullable<WorkspaceFilePreviewProps['binaryFile']>
  themeType: 'light' | 'dark'
}) {
  const containerRef = useRef<HTMLElement>(null)
  const { t } = useTranslation('common')
  const [preparationAttempt, setPreparationAttempt] = useState(0)
  const [prepared, setPrepared] = useState<{ source: File; file?: File; error?: boolean } | null>(
    null
  )
  const requiresPreparation = isDocxPreviewFile(file.file)
  useEffect(() => {
    if (!requiresPreparation) return
    let active = true
    void safeOfficePreviewFile(file.file).then(
      result => {
        if (active) setPrepared({ source: file.file, file: result })
      },
      () => {
        if (active) setPrepared({ source: file.file, error: true })
      }
    )
    return () => {
      active = false
    }
  }, [file.file, requiresPreparation, preparationAttempt])
  const preparedFile = requiresPreparation
    ? prepared?.source === file.file
      ? prepared.file
      : undefined
    : file.file
  const viewerType = workspaceFileViewerType(file.name, file.file.type)
  const isDiagram = viewerType === 'mermaid' || viewerType === 'plantuml'
  const diagramFilename = `${file.name.replace(/\.[^.]+$/, '')}.png`
  const viewerOptions = useMemo(
    () => ({
      preset: [officeRenderers, liteRenderers, engineeringRenderers],
      drawing: { plantumlServerUrl: getRuntimeConfig().plantumlServerUrl },
      spreadsheet: { worker: false },
      theme: themeType,
    }),
    [themeType]
  )

  useLayoutEffect(() => {
    const traceId = file.traceId
    if (!traceId) return
    logFilePreviewDiagnostic(traceId, 'binary_preview_committed', {
      fileSize: file.size,
      viewerType: viewerType ?? null,
    })
    scheduleFilePreviewMainThreadProbe(traceId, 'binary_preview_committed')
    return () => {
      logFilePreviewDiagnostic(traceId, 'binary_preview_unmounted')
    }
  }, [file.size, file.traceId, viewerType])

  const handleFileViewerRender = useCallback<ProfilerOnRenderCallback>(
    (_id, phase, actualDuration, baseDuration, startTime, commitTime) => {
      if (!file.traceId) return
      logFilePreviewDiagnostic(file.traceId, 'file_viewer_react_commit', {
        phase,
        actualDurationMs: Math.round(actualDuration * 10) / 10,
        baseDurationMs: Math.round(baseDuration * 10) / 10,
        startTimeMs: Math.round(startTime * 10) / 10,
        commitTimeMs: Math.round(commitTime * 10) / 10,
        viewerType: viewerType ?? null,
      })
    },
    [file.traceId, viewerType]
  )

  if (/\.(mp4|ogv|webm)$/i.test(file.name)) return <WorkspaceVideoPreview file={file.file} />

  if (/\.xmind$/i.test(file.name)) {
    return (
      <WorkspaceXMindPreview key={`${file.path}:${file.size}`} file={file.file} name={file.name} />
    )
  }

  if (!preparedFile) {
    return (
      <section
        data-testid="workspace-office-preview-preparing"
        className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 text-sm text-text-secondary"
      >
        {prepared?.source === file.file && prepared.error
          ? t('workbench.workspace_file_preview_failed')
          : t('workbench.workspace_file_preview_loading', '正在加载文件...')}
        {prepared?.source === file.file && prepared.error && (
          <Button
            type="button"
            data-testid="workspace-office-preview-retry-button"
            variant="link"
            size="sm"
            onClick={() => {
              setPrepared(null)
              setPreparationAttempt(attempt => attempt + 1)
            }}
          >
            {t('workbench.workspace_file_retry', '重试')}
          </Button>
        )}
      </section>
    )
  }

  return (
    <section
      data-testid="workspace-binary-file-preview"
      ref={containerRef}
      className="wework-diagram-preview relative min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
    >
      <Profiler id="workspace-file-viewer" onRender={handleFileViewerRender}>
        <FileViewer
          key={`${file.path}:${file.size}`}
          file={preparedFile}
          filename={file.name}
          type={viewerType}
          size={file.size}
          data-viewer-theme={themeType}
          className="wework-workspace-file-viewer scrollbar-soft h-full w-full overflow-auto"
          options={viewerOptions}
        />
      </Profiler>
      {isDiagram ? (
        <DiagramImageActions
          getArtifact={() => captureDiagramArtifact(containerRef.current)}
          filename={diagramFilename}
          theme={themeType}
        />
      ) : null}
    </section>
  )
})

function WorkspaceVideoPreview({ file }: { file: File }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const value = URL.createObjectURL(file)
    video.src = value
    return () => {
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(value)
    }
  }, [file])
  return (
    <video
      data-testid="workspace-video-preview"
      ref={videoRef}
      controls
      className="h-full min-h-0 w-full flex-1 bg-background"
    />
  )
}

interface SelectionState {
  filePath: string
  targetKey: string
  selectedText: string
  startLine: number
  endLine: number
  source: 'line' | 'keyboard'
}

interface CommentState {
  filePath: string | null
  value: string
}

interface WorkspaceCodeViewLineSelection {
  id: string
  range: {
    start: number
    end: number
  }
}

interface WorkspaceFilePreviewContentProps {
  file: WorkspaceTextFileResponse
  themeType: 'light' | 'dark'
  targetLineStart?: number
  targetLineEnd?: number
  onAddCodeComment?: (context: CodeCommentContext) => void
  editing?: boolean
  editedContent?: string
  loadVersion?: number
  onEditedContentChange?: (value: string) => void
  onSave?: () => void
}

function WorkspaceHtmlPreview({ file }: { file: WorkspaceTextFileResponse }) {
  const { t } = useTranslation('common')
  return (
    <section
      data-testid="workspace-html-file-preview"
      className="relative min-w-0 flex-1 overflow-hidden bg-background"
    >
      <iframe
        title={file.name}
        srcDoc={file.content}
        sandbox="allow-forms allow-popups allow-scripts"
        className="h-full w-full border-0 bg-white"
      />
      {file.truncated && (
        <div
          data-testid="workspace-html-file-preview-truncated"
          className="absolute inset-x-0 bottom-0 border-t border-border bg-background/95 px-4 py-2 text-xs text-warning backdrop-blur wework:text-amber-700"
        >
          {t('workbench.workspace_file_truncated', '文件过大，仅显示前 256 KiB')}
        </div>
      )}
    </section>
  )
}

function WorkspaceMarkdownPreview({
  file,
  targetLineStart,
}: {
  file: WorkspaceTextFileResponse
  targetLineStart?: number
}) {
  const { t } = useTranslation('common')
  const containerRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!Number.isInteger(targetLineStart) || Number(targetLineStart) < 1) return
    const container = containerRef.current
    if (!container) return
    const target = Array.from(container.querySelectorAll<HTMLElement>('[data-source-line]'))
      .filter(anchor => Number(anchor.dataset.sourceLine) <= Number(targetLineStart))
      .at(-1)
    if (!target) return
    target.dataset.sourceLineTarget = 'true'
    target.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const timeoutId = window.setTimeout(() => {
      target.removeAttribute('data-source-line-target')
    }, 1_200)
    return () => {
      window.clearTimeout(timeoutId)
      target.removeAttribute('data-source-line-target')
    }
  }, [file.path, file.revision, targetLineStart])

  return (
    <section
      ref={containerRef}
      data-testid="workspace-markdown-preview"
      className="scrollbar-soft min-w-0 flex-1 overflow-y-scroll bg-background"
    >
      <div className="mx-auto max-w-4xl px-8 py-6 text-base leading-7 text-text-primary [&_[data-source-line-target=true]]:rounded-md [&_[data-source-line-target=true]]:bg-amber-100 [&_[data-source-line-target=true]]:ring-2 [&_[data-source-line-target=true]]:ring-amber-300 [&_[data-source-line-target=true]]:transition-colors [&_[data-source-line-target=true]]:duration-700 dark:[&_[data-source-line-target=true]]:bg-amber-900/30 dark:[&_[data-source-line-target=true]]:ring-amber-600/60">
        <AssistantMarkdown content={file.content} variant="document" sourceLineAnchors />
      </div>
      {file.truncated && (
        <div className="sticky bottom-0 border-t border-border bg-background/95 px-4 py-2 text-xs text-warning backdrop-blur-sm wework:text-amber-700">
          {t('workbench.workspace_file_truncated', '文件过大，仅显示前 256 KiB')}
        </div>
      )}
    </section>
  )
}

function normalizeTargetLineRange(
  lineStart: number | undefined,
  lineEnd: number | undefined,
  lineCount: number
): { start: number; end: number } | null {
  if (!Number.isInteger(lineStart) || Number(lineStart) < 1) return null
  const boundedStart = Math.min(Number(lineStart), Math.max(lineCount, 1))
  const rawEnd = Number.isInteger(lineEnd) && Number(lineEnd) >= 1 ? Number(lineEnd) : boundedStart
  const boundedEnd = Math.min(rawEnd, Math.max(lineCount, 1))
  return {
    start: Math.min(boundedStart, boundedEnd),
    end: Math.max(boundedStart, boundedEnd),
  }
}

function createWorkspaceCodeItem(
  file: WorkspaceTextFileResponse,
  editing: boolean,
  editedContent?: string,
  version = 0
): CodeViewFileItem<undefined> {
  return {
    id: file.path,
    type: 'file',
    edit: editing,
    version,
    file: {
      name: file.path || file.name,
      contents: editing ? (editedContent ?? file.content) : file.content,
      cacheKey: editing ? undefined : `${file.path}:${file.revision}`,
    },
  }
}

function WorkspaceFilePreviewContent({
  file,
  themeType,
  codeFontSize,
  targetLineStart,
  targetLineEnd,
  onAddCodeComment,
  editing = false,
  editedContent,
  loadVersion = 0,
  onEditedContentChange,
  onSave,
}: WorkspaceFilePreviewContentProps & { codeFontSize: number }) {
  const codeTheme = useCodeTheme()
  const { t } = useTranslation('common')
  const codeViewRef = useRef<CodeViewHandle<undefined, undefined>>(null)
  const codeViewHostRef = useRef<HTMLDivElement>(null)
  const editor = useWorkspaceCodeEditor(file.path, codeViewHostRef, targetLineStart, targetLineEnd)
  const currentPathRef = useRef(file.path)
  const currentLoadVersion = useRef(loadVersion)
  const [selection, setSelection] = useState<SelectionState | null>(null)
  const [commentState, setCommentState] = useState<CommentState>({
    filePath: null,
    value: '',
  })
  const lines = useMemo(() => file.content.split('\n'), [file.content])
  const targetLineRange = useMemo(
    () => normalizeTargetLineRange(targetLineStart, targetLineEnd, lines.length),
    [lines.length, targetLineEnd, targetLineStart]
  )
  const targetLineKey = targetLineRange
    ? `${file.path}:${targetLineRange.start}:${targetLineRange.end}`
    : `${file.path}:none`
  const codeLineHeight = Math.round(codeFontSize * 1.8)
  const [initialItems] = useState(() => [createWorkspaceCodeItem(file, editing, editedContent)])

  // Pierre owns the live document and undo stack. Saving must not echo a disk
  // snapshot back over edits made while the write request was in flight.
  useLayoutEffect(() => {
    const view = codeViewRef.current
    if (
      view &&
      (currentPathRef.current !== file.path || currentLoadVersion.current !== loadVersion)
    ) {
      view.removeItem(currentPathRef.current)
      view.addItems([createWorkspaceCodeItem(file, editing, editedContent)])
      currentPathRef.current = file.path
      currentLoadVersion.current = loadVersion
      return
    }
    const item = view?.getItem(file.path)
    if (!view || !item || item.type !== 'file') return
    if (item.edit && editing) return
    const cacheKey = `${file.path}:${file.revision}`
    if (item.edit === editing && item.file.cacheKey === cacheKey) return
    const nextItem = createWorkspaceCodeItem(file, editing, editedContent, (item.version ?? 0) + 1)
    view.updateItem({ ...item, ...nextItem, file: item.edit ? item.file : nextItem.file })
  }, [editedContent, editing, file, loadVersion])
  const activeSelection =
    selection?.filePath === file.path && selection.targetKey === targetLineKey ? selection : null
  const activeCommentSelection =
    !editing && activeSelection?.source === 'line' ? activeSelection : null
  const comment = commentState.filePath === file.path ? commentState.value : ''
  const selectedLines = useMemo<WorkspaceCodeViewLineSelection | null>(
    () =>
      activeSelection
        ? {
            id: file.path,
            range: {
              start: activeSelection.startLine,
              end: activeSelection.endLine,
            },
          }
        : targetLineRange
          ? {
              id: file.path,
              range: targetLineRange,
            }
          : null,
    [activeSelection, file.path, targetLineRange]
  )
  const allLinesSelected =
    activeSelection?.startLine === 1 && activeSelection.endLine === lines.length

  useEffect(() => {
    const source = `workspace-preview:${file.path}`
    const host = codeViewHostRef.current
    const cleanup =
      host && activeCommentSelection
        ? installCodeViewTextDrag(host, activeCommentSelection.selectedText, rect => {
            publishSelectedTextSelection(source, activeCommentSelection.selectedText, rect)
          })
        : undefined
    if (!activeCommentSelection) publishSelectedTextSelection(source, null)
    return () => {
      cleanup?.()
      publishSelectedTextSelection(source, null)
    }
  }, [activeCommentSelection, file.path])

  useEffect(() => {
    if (!targetLineRange) return
    codeViewRef.current?.scrollTo({
      type: 'range',
      id: file.path,
      range: targetLineRange,
      align: 'center',
      behavior: 'instant',
    })
  }, [file.path, targetLineRange])

  const captureLineSelection = useCallback(
    (selectionRange: WorkspaceCodeViewLineSelection | null) => {
      if (!selectionRange || selectionRange.id !== file.path) {
        setSelection(null)
        return
      }
      const { range } = selectionRange
      const startLine = Math.min(range.start, range.end)
      const endLine = Math.max(range.start, range.end)
      const selectedText = lines
        .slice(startLine - 1, endLine)
        .join('\n')
        .trim()
      if (!selectedText) {
        setSelection(null)
        return
      }
      setSelection({
        filePath: file.path,
        targetKey: targetLineKey,
        selectedText,
        startLine,
        endLine,
        source: 'line',
      })
      setCommentState({ filePath: file.path, value: '' })
    },
    [file.path, lines, targetLineKey]
  )
  const codeViewOptions = useMemo(
    () => ({
      disableFileHeader: true,
      enableLineSelection: !editing,
      lineHoverHighlight: 'both' as const,
      overflow: 'scroll' as const,
      stickyHeaders: false,
      itemMetrics: { lineHeight: codeLineHeight },
      layout: { paddingTop: 0, paddingBottom: codeLineHeight, gap: 0 },
      theme: codeTheme,
      themeType,
      unsafeCSS: PIERRE_WORKSPACE_CODE_VIEW_CSS,
    }),
    [codeLineHeight, codeTheme, editing, themeType]
  )

  const addComment = () => {
    if (!file || !activeCommentSelection || !comment.trim() || !onAddCodeComment) return
    onAddCodeComment({
      id: `code-comment-${Date.now()}`,
      filePath: file.path,
      fileName: file.name,
      startLine: activeCommentSelection.startLine,
      endLine: activeCommentSelection.endLine,
      selectedText: activeCommentSelection.selectedText,
      comment: comment.trim(),
      createdAt: new Date().toISOString(),
    })
    setSelection(null)
    setCommentState({ filePath: file.path, value: '' })
  }

  const selectEntireFile = () => {
    setSelection({
      filePath: file.path,
      targetKey: targetLineKey,
      selectedText: file.content,
      startLine: 1,
      endLine: lines.length,
      source: 'keyboard',
    })
    setCommentState({ filePath: file.path, value: '' })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (editing) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        onSave?.()
      }
      return
    }
    if (isEditableShortcutTarget(event.target)) return
    const usesShortcutModifier = event.ctrlKey || event.metaKey
    if (
      !usesShortcutModifier ||
      event.altKey ||
      event.shiftKey ||
      event.key.toLowerCase() !== 'a'
    ) {
      return
    }
    event.preventDefault()
    selectEntireFile()
  }

  const handleCopy = (event: ClipboardEvent<HTMLElement>) => {
    if (editing) return
    if (!allLinesSelected) return
    event.preventDefault()
    event.clipboardData.setData('text/plain', file.content)
  }

  return (
    <section
      data-testid={editing ? 'workspace-file-editor' : 'workspace-file-preview'}
      data-pierre-editor-surface={editing ? '' : undefined}
      data-theme={themeType}
      draggable={!editing && Boolean(activeCommentSelection)}
      onDragStart={event => {
        if (editing) {
          editor.onDragStart(event)
          return
        }
        if (!activeCommentSelection) return
        writeSelectedTextDragData(event.dataTransfer, activeCommentSelection.selectedText)
      }}
      className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background"
      onCopy={handleCopy}
      onKeyDown={handleKeyDown}
      onKeyUp={editing ? editor.publishSelection : undefined}
      onMouseUp={editing ? editor.publishSelection : undefined}
    >
      <div
        data-testid="workspace-file-preview-code-view"
        data-file-path={file.path}
        data-theme={themeType}
        className="min-h-0 flex-1 bg-background"
      >
        <PierreCodeProvider>
          <EditProvider createEditor={editor.createEditor}>
            <CodeView
              ref={codeViewRef}
              containerRef={codeViewHostRef}
              initialItems={initialItems}
              selectedLines={editing ? null : selectedLines}
              onSelectedLinesChange={captureLineSelection}
              options={codeViewOptions}
              onItemEditChange={event => onEditedContentChange?.(event.file.contents)}
              onItemEditComplete={() => 'accept'}
              className="h-full min-h-0 w-full scrollbar-soft"
              style={
                {
                  height: '100%',
                  overflow: 'auto',
                  '--wework-workspace-code-line-height': `${codeLineHeight}px`,
                } as CSSProperties
              }
            />
          </EditProvider>
        </PierreCodeProvider>
      </div>
      {file.truncated && (
        <div className="shrink-0 border-t border-border bg-background px-4 py-2 text-xs text-warning wework:text-amber-700">
          {t('workbench.workspace_file_truncated', '文件过大，仅显示前 256 KiB')}
        </div>
      )}
      {activeCommentSelection && onAddCodeComment && (
        <div className="absolute bottom-4 left-4 right-4 rounded-xl border border-border bg-background p-3 shadow-xl">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-text-primary">
            <MessageSquare className="h-4 w-4" />
            {t('workbench.workspace_file_local_comment', '本地评论')}
          </div>
          <textarea
            data-testid="workspace-file-comment-input"
            value={comment}
            onChange={event =>
              setCommentState({
                filePath: file.path,
                value: event.target.value,
              })
            }
            placeholder={t('workbench.workspace_file_comment_placeholder', '请输入评论')}
            className="min-h-20 w-full resize-none rounded-lg border border-border bg-surface p-2 text-sm outline-none"
          />
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              data-testid="workspace-file-comment-cancel-button"
              className="h-8 rounded-md px-3 text-sm text-text-secondary hover:bg-muted"
              onClick={() => {
                setSelection(null)
                setCommentState({ filePath: file.path, value: '' })
              }}
            >
              {t('workbench.cancel', '取消')}
            </button>
            <button
              type="button"
              data-testid="workspace-file-add-comment-button"
              className="h-8 rounded-md bg-text-primary px-3 text-sm font-medium text-background disabled:opacity-50"
              disabled={!comment.trim()}
              onClick={addComment}
            >
              {t('workbench.comment', '评论')}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

export function WorkspaceFilePreview({
  file,
  binaryFile,
  loading,
  loadingProgress,
  error,
  onRetry,
  targetLineStart,
  targetLineEnd,
  onAddCodeComment,
  editing = false,
  editedContent,
  loadVersion,
  onEditedContentChange,
  onSave,
  previewMode = 'preview',
}: WorkspaceFilePreviewProps) {
  const { t } = useTranslation('common')
  const appearance = useOptionalAppearance()
  const themeType =
    appearance?.resolvedMode ??
    (typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark'
      ? 'dark'
      : 'light')
  const codeFontSize = appearance?.appearance.codeFontSize ?? defaultAppearance.codeFontSize

  if (loading && !file && !binaryFile) {
    const progress =
      loadingProgress?.totalBytes && loadingProgress.totalBytes > 0
        ? Math.min(
            100,
            Math.round((loadingProgress.loadedBytes / loadingProgress.totalBytes) * 100)
          )
        : null
    return (
      <section className="flex min-w-0 flex-1 items-center justify-center px-6 text-sm text-text-secondary">
        <div className="w-full max-w-xs space-y-2 text-center">
          <p>
            {progress === null
              ? t('workbench.workspace_file_preview_loading', '正在加载文件...')
              : t('workbench.workspace_file_preview_loading_progress', { progress })}
          </p>
          <div
            data-testid="workspace-file-preview-progress"
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-150 ease-out"
              style={{ width: `${progress ?? 35}%` }}
            />
          </div>
        </div>
      </section>
    )
  }

  if (error) {
    return (
      <section
        className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 text-sm text-destructive wework:text-red-500"
        data-testid="workspace-file-preview-error"
        role="alert"
      >
        <p>{error}</p>
        <button
          type="button"
          data-testid="workspace-file-preview-retry-button"
          className="underline"
          onClick={onRetry}
        >
          {t('workbench.workspace_file_retry', '重试')}
        </button>
      </section>
    )
  }

  if (!file) {
    if (binaryFile) {
      return <WorkspaceBinaryFilePreview file={binaryFile} themeType={themeType} />
    }
    return (
      <section className="flex min-w-0 flex-1 items-center justify-center text-sm text-text-muted">
        {t('workbench.workspace_file_preview_empty', '选择文件查看内容')}
      </section>
    )
  }

  if (!editing && isHtmlFile(file.name) && previewMode === 'preview') {
    return <WorkspaceHtmlPreview file={file} />
  }

  if (!editing && isMarkdownFile(file.name) && previewMode === 'preview') {
    return <WorkspaceMarkdownPreview file={file} targetLineStart={targetLineStart} />
  }

  return (
    <WorkspaceFilePreviewContent
      editing={editing}
      editedContent={editedContent}
      loadVersion={loadVersion}
      onEditedContentChange={onEditedContentChange}
      onSave={onSave}
      file={file}
      themeType={themeType}
      codeFontSize={codeFontSize}
      targetLineStart={targetLineStart}
      targetLineEnd={targetLineEnd}
      onAddCodeComment={onAddCodeComment}
    />
  )
}
