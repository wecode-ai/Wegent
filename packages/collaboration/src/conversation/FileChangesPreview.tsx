import type {
  TurnFileChangeItem,
  TurnFileChangesSummary,
} from '@wegent/chat-core/runtime'
import { ArrowUpRight, FileDiff } from 'lucide-react'
import {
  HoverCard,
  HoverCardTrigger,
  HoverCardContent,
} from '../controls/HoverCard'
import { controlPopup } from '../controls/recipes'
import { useCollaborationPortalTheme } from '../theme/CollaborationTheme'
import { useConversationTranslation } from './ConversationTranslation'
import { parseUnifiedDiff } from './parseUnifiedDiff'
const DIFF_PREVIEW_CLOSE_DELAY_MS = 140
const DIFF_PREVIEW_DELAY_MS = 500
const DIFF_PREVIEW_MAX_LINES = 240

export function FileChangeRow({
  file,
  summary,
  disabled,
  diffPreviewDisabled = false,
  onPreview,
}: {
  file: TurnFileChangeItem
  summary: TurnFileChangesSummary
  disabled: boolean
  diffPreviewDisabled?: boolean
  onPreview: () => void
}) {
  const { t } = useConversationTranslation()
  const displayPath =
    file.change_type === 'renamed' && file.old_path
      ? `${file.old_path} → ${file.path}`
      : file.path
  const diffPreview = buildFileDiffPreview(file, summary)

  return (
    <HoverCard
      delay={DIFF_PREVIEW_DELAY_MS}
      closeDelay={DIFF_PREVIEW_CLOSE_DELAY_MS}
      disabled={diffPreviewDisabled || !diffPreview}
    >
      <div
        data-testid="file-change-row"
        className="group/file-change-row flex min-w-0 items-center px-4 py-2.5 transition-colors hover:bg-muted"
      >
        <div
          data-testid="file-change-trigger"
          className="group/file-change-trigger relative min-w-0 flex-1"
        >
          <HoverCardTrigger
            render={<button type="button" disabled={disabled} />}
            onClick={onPreview}
            className="min-h-11 outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/40 md:min-h-8 grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-left disabled:cursor-not-allowed disabled:opacity-60"
            aria-label={t('file_changes.preview_file_label', {
              path: displayPath,
            })}
          >
            <span
              data-testid="file-change-title-label"
              className="min-w-0 truncate text-sm font-medium leading-5 text-text-primary"
            >
              {displayPath}
            </span>
            {file.binary ? (
              <span className="shrink-0 text-xs leading-5 text-text-secondary">
                {t('file_changes.binary_file')}
              </span>
            ) : (
              <span className="relative h-5 min-w-[5.5rem] text-xs font-medium leading-5">
                <span
                  data-testid="file-change-stats-label"
                  className="flex justify-end gap-2 group-hover/file-change-trigger:hidden group-focus-within/file-change-trigger:hidden"
                >
                  <span className="text-[rgb(var(--color-diff-added,22_163_74))] wework:text-green-600">
                    +{file.additions}
                  </span>
                  <span className="text-[rgb(var(--color-diff-removed,239_68_68))] wework:text-red-500">
                    -{file.deletions}
                  </span>
                </span>
                <span
                  data-testid="file-change-view-label"
                  className="hidden justify-end gap-1 truncate text-text-secondary group-hover/file-change-trigger:flex group-focus-within/file-change-trigger:flex"
                >
                  {t('file_changes.view_changes')}
                  <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.8} />
                </span>
              </span>
            )}
          </HoverCardTrigger>
          {diffPreview && <FileChangeDiffPreview preview={diffPreview} />}
        </div>
      </div>
    </HoverCard>
  )
}

export function FileChangeSummaryTrigger({
  file,
  summary,
  disabled,
  diffPreviewDisabled = false,
  onPreview,
}: {
  file: TurnFileChangeItem
  summary: TurnFileChangesSummary
  disabled: boolean
  diffPreviewDisabled?: boolean
  onPreview: () => void
}) {
  const { t } = useConversationTranslation()
  const displayPath =
    file.change_type === 'renamed' && file.old_path
      ? `${file.old_path} → ${file.path}`
      : file.path
  const filename = basename(file.path)
  const diffPreview = buildFileDiffPreview(file, summary)

  return (
    <HoverCard
      delay={DIFF_PREVIEW_DELAY_MS}
      closeDelay={DIFF_PREVIEW_CLOSE_DELAY_MS}
      disabled={diffPreviewDisabled || !diffPreview}
    >
      <div
        data-testid="file-change-trigger"
        className="group/file-change-trigger relative min-w-0 flex-1 self-stretch"
      >
        <HoverCardTrigger
          render={<button type="button" disabled={disabled} />}
          onClick={onPreview}
          className="min-h-11 outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/40 md:min-h-8 flex h-full w-full min-w-0 items-center gap-3 rounded-lg text-left disabled:cursor-not-allowed disabled:opacity-60"
          aria-label={t('file_changes.preview_file_label', {
            path: displayPath,
          })}
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-base text-text-secondary">
            <FileDiff className="h-5 w-5" strokeWidth={1.8} />
          </span>
          <span className="min-w-0 flex-1">
            <span
              data-testid="file-changes-summary-title"
              className="block truncate text-sm font-semibold leading-5 text-text-primary"
            >
              {t(fileChangeLabelKey(file.change_type), { filename })}
            </span>
            {file.binary ? (
              <span className="block truncate text-xs leading-5 text-text-secondary">
                {t('file_changes.binary_file')}
              </span>
            ) : (
              <span className="relative block h-5 text-xs font-medium leading-5">
                <span
                  data-testid="file-change-stats-label"
                  className="flex items-center gap-2 group-hover/file-change-trigger:hidden group-focus-within/file-change-trigger:hidden"
                >
                  <span className="text-[rgb(var(--color-diff-added,22_163_74))] wework:text-green-600">
                    +{summary.additions}
                  </span>
                  <span className="text-[rgb(var(--color-diff-removed,239_68_68))] wework:text-red-500">
                    -{summary.deletions}
                  </span>
                </span>
                <span
                  data-testid="file-change-view-label"
                  className="hidden items-center gap-1 truncate text-text-secondary group-hover/file-change-trigger:flex group-focus-within/file-change-trigger:flex"
                >
                  {t('file_changes.view_changes')}
                  <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.8} />
                </span>
              </span>
            )}
          </span>
        </HoverCardTrigger>
        {diffPreview && <FileChangeDiffPreview preview={diffPreview} />}
      </div>
    </HoverCard>
  )
}

function fileChangeLabelKey(changeType: TurnFileChangeItem['change_type']) {
  switch (changeType) {
    case 'created':
      return 'file_changes.created_file'
    case 'deleted':
      return 'file_changes.deleted_file'
    case 'renamed':
      return 'file_changes.renamed_file'
    case 'modified':
    default:
      return 'file_changes.edited_file'
  }
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

interface DiffPreview {
  path: string
  displayPath: string
  additions: number
  deletions: number
  lines: DiffPreviewLine[]
  truncated: boolean
}

interface DiffPreviewLine {
  key: string
  type: 'addition' | 'deletion' | 'context' | 'separator'
  lineNumber?: number
  content: string
}

export function FileChangesStats({
  additions,
  deletions,
}: {
  additions: number
  deletions: number
}) {
  return (
    <span className="flex items-center gap-2 text-xs font-medium leading-5">
      <span className="text-[rgb(var(--color-diff-added,22_163_74))] wework:text-green-600">
        +{additions}
      </span>
      <span className="text-[rgb(var(--color-diff-removed,239_68_68))] wework:text-red-500">
        -{deletions}
      </span>
    </span>
  )
}

function FileChangeDiffPreview({ preview }: { preview: DiffPreview }) {
  const portalTheme = useCollaborationPortalTheme()
  return (
    <HoverCardContent
      {...portalTheme}
      data-testid="file-change-diff-preview"
      side="top"
      align="start"
      sideOffset={8}
      collisionPadding={16}
      className={
        portalTheme.className +
        ' ' +
        controlPopup +
        ' w-[min(640px,calc(100vw-2rem))] select-text overflow-hidden p-0 text-left'
      }
    >
      <div className="flex h-10 items-center gap-3 border-b border-border px-4 text-sm font-semibold">
        <span className="min-w-0 flex-1 truncate" title={preview.displayPath}>
          {preview.displayPath}
        </span>
        <span className="shrink-0 font-medium text-[rgb(var(--color-diff-added,74_222_128))] wework:text-green-400">
          +{preview.additions}
        </span>
        <span className="shrink-0 font-medium text-[rgb(var(--color-diff-removed,248_113_113))] wework:text-red-400">
          -{preview.deletions}
        </span>
      </div>
      <div className="max-h-[min(24rem,calc(100vh-9rem))] overflow-auto py-1 font-mono text-xs leading-5">
        {preview.lines.map((line) =>
          line.type === 'separator' ? (
            <div key={line.key} className="my-1 h-px bg-border" />
          ) : (
            <div
              key={line.key}
              className={[
                'grid min-w-full grid-cols-[3.5rem_max-content] overflow-visible',
                line.type === 'addition'
                  ? 'border-l-4 border-[rgb(var(--color-diff-added,74_222_128))] bg-[rgb(var(--color-diff-added,34_197_94)/0.1)] wework:border-green-400 wework:bg-green-500/10'
                  : line.type === 'deletion'
                    ? 'border-l-4 border-[rgb(var(--color-diff-removed,248_113_113))] bg-[rgb(var(--color-diff-removed,239_68_68)/0.1)] wework:border-red-400 wework:bg-red-500/10'
                    : 'border-l-4 border-transparent',
              ].join(' ')}
            >
              <span
                className={[
                  'select-none px-3 text-right',
                  line.type === 'addition'
                    ? 'text-[rgb(var(--color-diff-added,74_222_128))] wework:text-green-400'
                    : line.type === 'deletion'
                      ? 'text-[rgb(var(--color-diff-removed,248_113_113))] wework:text-red-400'
                      : 'text-text-muted',
                ].join(' ')}
              >
                {line.lineNumber ?? ''}
              </span>
              <span className="pr-4 whitespace-pre">{line.content || ' '}</span>
            </div>
          ),
        )}
        {preview.truncated ? (
          <div className="px-4 py-1 text-xs text-text-muted">...</div>
        ) : null}
      </div>
    </HoverCardContent>
  )
}

function buildFileDiffPreview(
  file: TurnFileChangeItem,
  summary: TurnFileChangesSummary,
): DiffPreview | null {
  if (file.binary || !summary.diff?.trim()) return null

  const sectionLines = fileDiffLines(file, summary)
  if (!sectionLines.length) return null

  const lines = parseDiffPreviewLines(sectionLines)
  if (!lines.length) return null

  return {
    path: file.path,
    displayPath: absoluteFilePath(summary.workspace_path, file.path),
    additions: file.additions,
    deletions: file.deletions,
    lines: lines.slice(0, DIFF_PREVIEW_MAX_LINES),
    truncated: lines.length > DIFF_PREVIEW_MAX_LINES,
  }
}

function absoluteFilePath(workspacePath: string, filePath: string): string {
  if (isAbsolutePath(filePath)) return filePath
  const normalizedWorkspacePath = workspacePath.replace(/[\\/]+$/, '')
  if (!normalizedWorkspacePath) return filePath
  return `${normalizedWorkspacePath}/${filePath.replace(/^[\\/]+/, '')}`
}

function isAbsolutePath(path: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path)
}

function fileDiffLines(
  file: TurnFileChangeItem,
  summary: TurnFileChangesSummary,
): string[] {
  const diff = summary.diff?.trimEnd()
  if (!diff) return []

  const sections = parseUnifiedDiff(diff)
  if (sections.length === 0) {
    return summary.files.length === 1 ? diff.split('\n') : []
  }

  const section = sections.find(
    (item) =>
      pathsMatch(item.path, file.path) ||
      (file.old_path ? pathsMatch(item.oldPath, file.old_path) : false),
  )
  return section?.lines ?? []
}

function pathsMatch(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (!left || !right) return false
  return (
    left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`)
  )
}

function parseDiffPreviewLines(lines: string[]): DiffPreviewLine[] {
  const previewLines: DiffPreviewLine[] = []
  let oldLine: number | undefined
  let newLine: number | undefined
  let seenHunk = false

  lines.forEach((rawLine, index) => {
    if (
      rawLine.startsWith('diff --git') ||
      rawLine.startsWith('---') ||
      rawLine.startsWith('+++')
    ) {
      return
    }
    if (
      rawLine.startsWith('index ') ||
      rawLine.startsWith('new file mode ') ||
      rawLine.startsWith('deleted file mode ') ||
      rawLine.startsWith('similarity index ') ||
      rawLine.startsWith('rename from ') ||
      rawLine.startsWith('rename to ') ||
      rawLine.startsWith('\\ No newline')
    ) {
      return
    }

    const hunk = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      if (seenHunk && previewLines.length > 0) {
        previewLines.push({
          key: `separator-${index}`,
          type: 'separator',
          content: '',
        })
      }
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      seenHunk = true
      return
    }

    if (!seenHunk && !rawLine.startsWith('+') && !rawLine.startsWith('-')) {
      return
    }

    const prefix = rawLine[0]
    if (prefix === '+') {
      previewLines.push({
        key: `addition-${index}`,
        type: 'addition',
        lineNumber: newLine,
        content: rawLine.slice(1),
      })
      if (newLine !== undefined) newLine += 1
      return
    }
    if (prefix === '-') {
      previewLines.push({
        key: `deletion-${index}`,
        type: 'deletion',
        lineNumber: oldLine,
        content: rawLine.slice(1),
      })
      if (oldLine !== undefined) oldLine += 1
      return
    }

    previewLines.push({
      key: `context-${index}`,
      type: 'context',
      lineNumber: newLine ?? oldLine,
      content: prefix === ' ' ? rawLine.slice(1) : rawLine,
    })
    if (oldLine !== undefined) oldLine += 1
    if (newLine !== undefined) newLine += 1
  })

  return previewLines
}
