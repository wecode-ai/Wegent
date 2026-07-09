import type { CodeViewItem } from '@pierre/diffs'
import { CodeView, type CodeViewHandle } from '@pierre/diffs/react'
import { MessageSquare } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { CodeCommentContext, WorkspaceTextFileResponse } from '@/types/workspace-files'

const PIERRE_WORKSPACE_CODE_VIEW_CSS = `
  :host {
    --diffs-font-size: 12px;
    --diffs-line-height: 20px;
    --diffs-font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    --diffs-header-font-family: Inter, ui-sans-serif, system-ui, sans-serif;
    --diffs-light-bg: rgb(255 255 255);
    --diffs-light: rgb(26 26 26);
    --diffs-fg-number-override: rgb(140 140 140);
    --diffs-bg-context-override: rgb(255 255 255);
    --diffs-bg-context-gutter-override: rgb(247 247 248);
    --diffs-bg-hover-override: rgb(247 247 248);
    --diffs-scrollbar-gutter-override: 5px;
    --diffs-min-number-column-width: 3ch;
    background: rgb(255 255 255) !important;
  }
  [data-diffs-header],
  [data-diffs-header="default"] {
    min-height: 36px;
    padding-inline: 12px;
    border-bottom: 1px solid rgb(224 224 224);
    font-size: 13px;
  }
  [data-file],
  pre,
  [data-code] {
    background: rgb(255 255 255);
  }
  [data-code] {
    scrollbar-width: thin;
    scrollbar-color: rgb(224 224 224 / 0.55) transparent;
  }
  [data-code]::-webkit-scrollbar {
    width: 5px;
    height: 5px;
  }
  [data-code]::-webkit-scrollbar-track {
    background: transparent;
  }
  [data-code]::-webkit-scrollbar-thumb {
    background-color: rgb(224 224 224 / 0.55);
    border-radius: 999px;
  }
  [data-gutter] {
    border-right: 1px solid rgb(224 224 224);
    background: rgb(247 247 248);
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
    background: rgb(247 247 248);
  }
`

interface WorkspaceFilePreviewProps {
  file: WorkspaceTextFileResponse | null
  loading: boolean
  error?: string | null
  onRetry: () => void
  targetLineStart?: number
  targetLineEnd?: number
  onAddCodeComment: (context: CodeCommentContext) => void
}

interface SelectionState {
  filePath: string
  targetKey: string
  selectedText: string
  startLine: number
  endLine: number
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
  targetLineStart?: number
  targetLineEnd?: number
  onAddCodeComment: (context: CodeCommentContext) => void
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

function WorkspaceFilePreviewContent({
  file,
  targetLineStart,
  targetLineEnd,
  onAddCodeComment,
}: WorkspaceFilePreviewContentProps) {
  const { t } = useTranslation('common')
  const codeViewRef = useRef<CodeViewHandle<undefined>>(null)
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
  const codeViewItems = useMemo<CodeViewItem[]>(
    () => [
      {
        id: file.path,
        type: 'file',
        file: {
          name: file.path || file.name,
          contents: file.content,
          cacheKey: `${file.path}:${file.content.length}`,
        },
        version: file.content.length,
      },
    ],
    [file.content, file.name, file.path]
  )
  const activeSelection =
    selection?.filePath === file.path && selection.targetKey === targetLineKey ? selection : null
  const comment = commentState.filePath === file.path ? commentState.value : ''
  const selectedLines = activeSelection
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
      : null

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

  const captureLineSelection = (selectionRange: WorkspaceCodeViewLineSelection | null) => {
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
    })
    setCommentState({ filePath: file.path, value: '' })
  }

  const addComment = () => {
    if (!file || !activeSelection || !comment.trim()) return
    onAddCodeComment({
      id: `code-comment-${Date.now()}`,
      filePath: file.path,
      fileName: file.name,
      startLine: activeSelection.startLine,
      endLine: activeSelection.endLine,
      selectedText: activeSelection.selectedText,
      comment: comment.trim(),
      createdAt: new Date().toISOString(),
    })
    setSelection(null)
    setCommentState({ filePath: file.path, value: '' })
  }

  return (
    <section
      data-testid="workspace-file-preview"
      className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background"
    >
      <div data-testid="workspace-file-preview-code-view" className="min-h-0 flex-1 bg-background">
        <CodeView
          ref={codeViewRef}
          key={file.path}
          items={codeViewItems}
          selectedLines={selectedLines}
          onSelectedLinesChange={captureLineSelection}
          options={{
            disableFileHeader: false,
            enableLineSelection: true,
            lineHoverHighlight: 'both',
            overflow: 'scroll',
            stickyHeaders: true,
            layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
            theme: { dark: 'pierre-dark', light: 'pierre-light' },
            themeType: 'light',
            unsafeCSS: PIERRE_WORKSPACE_CODE_VIEW_CSS,
          }}
          renderHeaderMetadata={() =>
            file.truncated ? (
              <span className="text-xs text-amber-700">
                {t('workbench.workspace_file_truncated', '文件过大，仅显示前 256 KiB')}
              </span>
            ) : null
          }
          className="h-full min-h-0 w-full scrollbar-soft"
          style={{ height: '100%', overflow: 'auto' }}
        />
      </div>
      {activeSelection && (
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
              className="h-8 rounded-md bg-text-primary px-3 text-sm font-medium text-white disabled:opacity-50"
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
  loading,
  error,
  onRetry,
  targetLineStart,
  targetLineEnd,
  onAddCodeComment,
}: WorkspaceFilePreviewProps) {
  const { t } = useTranslation('common')

  if (loading) {
    return (
      <section className="flex min-w-0 flex-1 items-center justify-center text-sm text-text-secondary">
        {t('workbench.workspace_file_preview_loading', '正在加载文件...')}
      </section>
    )
  }

  if (error) {
    return (
      <section className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 text-sm text-red-500">
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
    return (
      <section className="flex min-w-0 flex-1 items-center justify-center text-sm text-text-muted">
        {t('workbench.workspace_file_preview_empty', '选择文件查看内容')}
      </section>
    )
  }

  return (
    <WorkspaceFilePreviewContent
      key={file.path}
      file={file}
      targetLineStart={targetLineStart}
      targetLineEnd={targetLineEnd}
      onAddCodeComment={onAddCodeComment}
    />
  )
}
