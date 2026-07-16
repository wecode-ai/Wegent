import { useState } from 'react'
import { Box, ChevronDown, ChevronUp, FileText } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { CodexMemoryCitation, CodexMemoryCitationEntry, CodexReference } from '@/types/api'
import type { WorkspaceFileOpenOptions } from '@/types/workspace-files'
import { basename, fileExtension, getDisplayCodexReferences } from './codexReferences'

const DEFAULT_VISIBLE_REFERENCE_COUNT = 3

export function CodexMemoryCitations({
  citations,
  onOpenFile,
}: {
  citations: CodexMemoryCitation[]
  onOpenFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
}) {
  const { t } = useTranslation('chat')
  const [expanded, setExpanded] = useState(false)
  const entries = citations.flatMap(citation => citation.entries ?? [])
  if (entries.length === 0) return null

  return (
    <section className="mt-3 min-w-0 text-[13px]" data-testid="codex-memory-citations">
      <button
        type="button"
        data-testid="codex-memory-citations-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}
        className="flex max-w-full items-center gap-1.5 text-text-muted hover:text-text-secondary"
      >
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? '' : '-rotate-90'}`}
          strokeWidth={2}
        />
        <span className="min-w-0 truncate">
          {t('memory_citations.summary', { count: entries.length })}
        </span>
      </button>
      {expanded && (
        <div className="mt-4 flex min-w-0 flex-col gap-2 pl-5">
          {entries.map((entry, index) => (
            <MemoryCitationEntryRow
              key={`${entry.path}:${index}`}
              entry={entry}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      )}
    </section>
  )
}

export function CodexReferenceList({
  references,
  onOpenFile,
}: {
  references: CodexReference[]
  onOpenFile: (path: string, options?: WorkspaceFileOpenOptions) => void
}) {
  const { t } = useTranslation('chat')
  const [expanded, setExpanded] = useState(false)
  const uniqueReferences = getDisplayCodexReferences(references)
  if (uniqueReferences.length === 0) return null
  const hiddenCount = Math.max(0, uniqueReferences.length - DEFAULT_VISIBLE_REFERENCE_COUNT)
  const visibleReferences = expanded
    ? uniqueReferences
    : uniqueReferences.slice(0, DEFAULT_VISIBLE_REFERENCE_COUNT)

  return (
    <section
      className="mt-3 min-w-0"
      data-testid="codex-reference-list"
      aria-label={t('codex_references.title')}
    >
      <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-surface">
        {visibleReferences.map(reference => (
          <button
            type="button"
            key={reference.path}
            data-testid="codex-reference-card"
            onClick={() =>
              openFileWithOptionalLocation(
                onOpenFile,
                reference.path,
                reference.lineStart,
                reference.lineEnd
              )
            }
            className="group/reference-card flex w-full min-w-0 items-center gap-3 border-b border-border px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-muted"
            aria-label={t('codex_references.open_label', { path: reference.path })}
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-base text-text-secondary">
              <ReferenceFileIcon path={reference.path} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold text-text-primary">
                {basename(reference.path)}
              </span>
              <span className="relative block h-5 truncate text-xs leading-5 text-text-secondary">
                <span
                  data-testid="codex-reference-kind-label"
                  className="block truncate transition-opacity group-hover/reference-card:opacity-0 group-focus-visible/reference-card:opacity-0"
                >
                  {formatReferenceKind(reference.path, t)}
                </span>
                <span
                  data-testid="codex-reference-preview-label"
                  className="absolute inset-0 block truncate opacity-0 transition-opacity group-hover/reference-card:opacity-100 group-focus-visible/reference-card:opacity-100"
                >
                  {t('codex_references.preview_label')}
                </span>
              </span>
            </span>
            <span className="hidden shrink-0 items-center gap-1 rounded-lg border border-border bg-base px-3 py-1.5 text-xs text-text-secondary sm:inline-flex">
              {t('codex_references.open_with')}
              <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} />
            </span>
          </button>
        ))}
        {hiddenCount > 0 ? (
          <button
            type="button"
            data-testid="toggle-codex-reference-list-button"
            aria-expanded={expanded}
            onClick={() => setExpanded(value => !value)}
            className="flex h-8 w-full items-center justify-center gap-1 border-t border-border text-xs font-medium text-text-secondary hover:bg-muted"
          >
            <span>
              {expanded
                ? t('codex_references.show_less')
                : t('codex_references.show_more', { count: hiddenCount })}
            </span>
            {expanded ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </button>
        ) : null}
      </div>
    </section>
  )
}

function ReferenceFileIcon({ path }: { path: string }) {
  const extension = fileExtension(path)
  if (extension === 'md' || extension === 'markdown') {
    return <FileText className="h-5 w-5" strokeWidth={1.8} />
  }

  return <Box className="h-5 w-5" strokeWidth={1.8} />
}

function formatReferenceKind(
  path: string,
  t: (key: string, options?: Record<string, string>) => string
) {
  const extension = fileExtension(path)
  if (!extension) return t('codex_references.kind')
  return t('codex_references.kind_with_extension', { extension: extension.toUpperCase() })
}

function MemoryCitationEntryRow({
  entry,
  onOpenFile,
}: {
  entry: CodexMemoryCitationEntry
  onOpenFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
}) {
  const { t } = useTranslation('chat')
  const lineStart = entry.lineStart ?? entry.line_start
  const lineEnd = entry.lineEnd ?? entry.line_end
  const lineRange =
    typeof lineStart === 'number'
      ? lineEnd && lineEnd !== lineStart
        ? `${lineStart}-${lineEnd}`
        : String(lineStart)
      : ''
  const filename = basename(entry.path)

  return (
    <button
      type="button"
      className="group/memory-entry relative block w-full min-w-0 rounded-lg px-2 py-1 text-left text-[13px] leading-6 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-default disabled:hover:bg-transparent"
      data-testid="codex-memory-citation-entry"
      onClick={() => openFileWithOptionalLocation(onOpenFile, entry.path, lineStart, lineEnd)}
      disabled={!onOpenFile}
      aria-label={t('memory_citations.open_label', { path: entry.path })}
    >
      <span className="block truncate text-text-primary">
        <span className="font-mono">{entry.path}</span>
        {lineRange ? (
          <span className="ml-2 text-text-muted">
            {t('memory_citations.line_label', { range: lineRange })}
          </span>
        ) : null}
      </span>
      {entry.note ? <span className="block break-words text-text-muted">{entry.note}</span> : null}
      <span
        data-testid="codex-memory-citation-tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1 hidden max-w-[min(28rem,calc(100vw-3rem))] -translate-x-1/2 whitespace-normal break-all rounded-xl border border-white/10 bg-[#2f2f2f] px-3 py-2 text-[13px] font-normal leading-5 text-white shadow-lg group-hover/memory-entry:block group-focus-visible/memory-entry:block"
      >
        {filename}
      </span>
    </button>
  )
}

function openFileWithOptionalLocation(
  onOpenFile: ((path: string, options?: WorkspaceFileOpenOptions) => void) | undefined,
  path: string,
  lineStart?: number | null,
  lineEnd?: number | null
) {
  if (typeof lineStart === 'number') {
    onOpenFile?.(path, {
      lineStart,
      lineEnd: typeof lineEnd === 'number' ? lineEnd : undefined,
    })
    return
  }
  onOpenFile?.(path)
}
