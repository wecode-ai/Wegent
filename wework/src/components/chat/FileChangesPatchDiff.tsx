import type { DiffLineAnnotation, DiffLineEventBaseProps, SelectedLineRange } from '@pierre/diffs'
import { PatchDiff } from '@pierre/diffs/react'
import { useCallback, useMemo } from 'react'
import type { GitPatchAction } from '@/api/environment'
import { useCodeTheme } from '@/features/appearance/useCodeTheme'
import { useStableEvent } from '@/features/workbench/useStableEvent'
import { ReviewPatchActionButton } from './fileChangesReviewInteractions'
import {
  getDiffSelection,
  getHunkActionAnchor,
  getHunkPatches,
  getOpenSourceLine,
  getReviewActions,
  type DiffCommentSelection,
  type FileChangesReviewMode,
} from './fileChangesReviewUtils'

interface HunkAction {
  patch: string
  key: string
}

interface FileChangesPatchDiffProps {
  patch: string
  selectionKey: string
  path: string
  codeLineHeight: number
  wrapLines: boolean
  diffStyle: 'unified' | 'split'
  hunksCollapsed: boolean
  reviewMode?: FileChangesReviewMode
  pendingAction: string | null
  onApplyPatch: (action: GitPatchAction, patch: string, operationKey: string) => Promise<void>
  onOpenSourceFile?: (path: string, lineStart?: number, lineEnd?: number) => void
  canComment: boolean
  selectedLines: SelectedLineRange | null
  onCommentSelectionChange: (selection: DiffCommentSelection | null) => void
  themeType: 'light' | 'dark'
}

export function FileChangesPatchDiff({
  patch,
  selectionKey,
  path,
  codeLineHeight,
  wrapLines,
  diffStyle,
  hunksCollapsed,
  reviewMode,
  pendingAction,
  onApplyPatch,
  onOpenSourceFile,
  canComment,
  selectedLines,
  onCommentSelectionChange,
  themeType,
}: FileChangesPatchDiffProps) {
  const codeTheme = useCodeTheme()
  const fileActions = useMemo(() => getReviewActions(reviewMode), [reviewMode])
  const lineAnnotations = useMemo<DiffLineAnnotation<HunkAction>[]>(
    () =>
      fileActions.length === 0
        ? []
        : getHunkPatches(patch).flatMap((hunkPatch, hunkIndex) => {
            const anchor = getHunkActionAnchor(hunkPatch)
            return anchor
              ? [{ ...anchor, metadata: { patch: hunkPatch, key: `${selectionKey}:${hunkIndex}` } }]
              : []
          }),
    [fileActions, patch, selectionKey]
  )
  // Callback identity is a render option in Pierre. Keep it independent of owner refreshes.
  const onLineNumberClick = useStableEvent((line: DiffLineEventBaseProps) => {
    const sourceLine = getOpenSourceLine(line)
    if (sourceLine !== null) onOpenSourceFile?.(path, sourceLine, sourceLine)
  })
  const onLineSelectionEnd = useStableEvent((range: SelectedLineRange | null) => {
    const selected = range ? getDiffSelection(patch, range) : null
    onCommentSelectionChange(
      range && selected ? { key: selectionKey, path, range, ...selected } : null
    )
  })
  const options = useMemo(
    () => ({
      collapsed: hunksCollapsed,
      controlledSelection: true,
      diffStyle,
      disableFileHeader: true,
      enableLineSelection: canComment,
      lineHoverHighlight: 'both' as const,
      onLineNumberClick,
      onLineSelectionEnd,
      overflow: wrapLines ? ('wrap' as const) : ('scroll' as const),
      stickyHeader: false,
      theme: codeTheme,
      themeType,
      tokenizeMaxLength: 250_000,
      tokenizeMaxLineLength: 2_000,
      unsafeCSS: PIERRE_DIFF_CSS,
    }),
    [
      hunksCollapsed,
      diffStyle,
      canComment,
      onLineNumberClick,
      onLineSelectionEnd,
      wrapLines,
      codeTheme,
      themeType,
    ]
  )
  const metrics = useMemo(
    () => ({
      diffHeaderHeight: 0,
      hunkLineCount: 120,
      lineHeight: codeLineHeight,
      paddingBottom: 0,
      paddingTop: 0,
      spacing: 0,
    }),
    [codeLineHeight]
  )
  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<HunkAction>) => (
      <div className="relative h-0">
        <div
          data-testid="file-changes-review-hunk-actions"
          className="pointer-events-none absolute -top-8 right-0.5 z-20 flex items-center gap-1 rounded-full bg-surface/90 p-0.5 opacity-0 shadow-sm ring-1 ring-border/60 transition-opacity group-hover/file-diff:pointer-events-auto group-hover/file-diff:opacity-100 hover:pointer-events-auto hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100"
        >
          {fileActions.map(action => (
            <ReviewPatchActionButton
              key={action}
              action={action}
              scope="hunk"
              disabled={Boolean(pendingAction)}
              pending={pendingAction === `hunk:${annotation.metadata.key}:${action}`}
              onClick={() =>
                onApplyPatch(
                  action,
                  annotation.metadata.patch,
                  `hunk:${annotation.metadata.key}:${action}`
                )
              }
            />
          ))}
        </div>
      </div>
    ),
    [fileActions, onApplyPatch, pendingAction]
  )
  return (
    <PatchDiff<HunkAction>
      patch={patch}
      lineAnnotations={lineAnnotations}
      renderAnnotation={renderAnnotation}
      selectedLines={selectedLines}
      options={options}
      metrics={metrics}
    />
  )
}
const PIERRE_DIFF_CSS = `
  :host {
    --diffs-font-size: var(--text-code);
    --diffs-line-height: var(--wework-review-code-line-height);
    --diffs-light-bg: rgb(var(--color-bg-base));
    --diffs-light: rgb(var(--color-text-primary));
    --diffs-dark-bg: rgb(var(--color-bg-base));
    --diffs-dark: rgb(var(--color-text-primary));
    --diffs-fg-number-override: rgb(var(--color-text-muted));
    --diffs-bg-context-override: rgb(var(--color-bg-base));
    --diffs-bg-context-gutter-override: rgb(var(--color-bg-surface));
    --diffs-bg-hover-override: rgb(var(--color-muted));
    background: rgb(var(--color-bg-base)) !important;
  }
  :host, pre, code {
    font-family: var(--font-code);
    font-size: var(--text-code);
    line-height: var(--diffs-line-height);
  }
  [data-diffs-file-header], [data-diffs-header] {
    min-height: 36px;
    border-bottom: 1px solid rgb(var(--color-border));
    background: rgb(var(--color-bg-base));
    font-family: var(--font-ui);
    font-size: var(--text-sm);
    font-weight: 500;
  }
  [data-diffs-line-addition], [data-diffs-line-added] {
    background: rgb(var(--color-review-added, var(--color-diff-added)) / 0.12);
  }
  [data-diffs-line-deletion], [data-diffs-line-deleted] {
    background: rgb(var(--color-review-removed, var(--color-diff-removed)) / 0.12);
  }
`
