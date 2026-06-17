import { MessageSquare } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { CodeCommentContext, WorkspaceTextFileResponse } from '@/types/workspace-files'

interface WorkspaceFilePreviewProps {
  file: WorkspaceTextFileResponse | null
  loading: boolean
  error?: string | null
  onRetry: () => void
  onAddCodeComment: (context: CodeCommentContext) => void
}

interface SelectionState {
  filePath: string
  selectedText: string
  startLine: number
  endLine: number
}

interface CommentState {
  filePath: string | null
  value: string
}

interface WorkspaceFilePreviewContentProps {
  file: WorkspaceTextFileResponse
  onAddCodeComment: (context: CodeCommentContext) => void
}

function elementFromSelectionNode(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement
}

function lineNumberFromSelectionNode(node: Node): number | null {
  const element = elementFromSelectionNode(node)
  const lineRow = element?.closest<HTMLElement>('[data-workspace-file-line]')
  const line = lineRow?.dataset.workspaceFileLine
  return line ? Number(line) : null
}

function lineRangeForSelection(
  range: Range,
): Pick<SelectionState, 'startLine' | 'endLine'> | null {
  const startLine = lineNumberFromSelectionNode(range.startContainer)
  const endLine = lineNumberFromSelectionNode(range.endContainer)
  if (!startLine || !endLine) return null
  return {
    startLine: Math.min(startLine, endLine),
    endLine: Math.max(startLine, endLine),
  }
}

function WorkspaceFilePreviewContent({
  file,
  onAddCodeComment,
}: WorkspaceFilePreviewContentProps) {
  const { t } = useTranslation('common')
  const [selection, setSelection] = useState<SelectionState | null>(null)
  const [commentState, setCommentState] = useState<CommentState>({
    filePath: null,
    value: '',
  })
  const lines = useMemo(() => file.content.split('\n'), [file.content])
  const activeSelection = selection?.filePath === file.path ? selection : null
  const comment = commentState.filePath === file.path ? commentState.value : ''

  const captureSelection = () => {
    const browserSelection = window.getSelection()
    const selectedText = browserSelection?.toString().trim() ?? ''
    if (!selectedText) {
      setSelection(null)
      return
    }
    if (!browserSelection || browserSelection.rangeCount === 0) {
      setSelection(null)
      return
    }
    const range = lineRangeForSelection(browserSelection.getRangeAt(0))
    if (!range) {
      setSelection(null)
      return
    }
    setSelection({ filePath: file.path, selectedText, ...range })
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
      <header className="shrink-0 border-b border-border px-4 py-3">
        <p className="truncate text-sm font-medium text-text-primary">{file.name}</p>
        <p className="truncate text-xs text-text-muted">{file.path}</p>
        {file.truncated && (
          <p className="mt-1 text-xs text-amber-700">
            {t('workbench.workspace_file_truncated', '文件过大，仅显示前 256 KiB')}
          </p>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-auto" onMouseUp={captureSelection}>
        <pre className="m-0 min-w-max p-0 font-mono text-[13px] leading-5">
          {lines.map((line, index) => (
            <div
              key={index}
              data-workspace-file-line={index + 1}
              className="grid grid-cols-[4rem_minmax(0,1fr)]"
            >
              <span className="select-none border-r border-border bg-surface pr-3 text-right text-text-muted">
                {index + 1}
              </span>
              <code className="whitespace-pre px-3 text-text-primary">{line || ' '}</code>
            </div>
          ))}
        </pre>
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
            onChange={event => setCommentState({
              filePath: file.path,
              value: event.target.value,
            })}
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
      onAddCodeComment={onAddCodeComment}
    />
  )
}
