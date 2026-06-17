import { ChevronDown, ChevronRight, X } from 'lucide-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { parseUnifiedDiff } from './parseUnifiedDiff'

interface FileChangesReviewTarget {
  path: string
  oldPath?: string
}

interface FileChangesReviewDialogProps {
  open: boolean
  loading: boolean
  diff: string
  error?: string
  targetFile?: FileChangesReviewTarget
  onClose: () => void
}

export function FileChangesReviewDialog({
  open,
  loading,
  diff,
  error,
  targetFile,
  onClose,
}: FileChangesReviewDialogProps) {
  const { t } = useTranslation('chat')
  useEscapeKey(onClose, open)

  const reviewScope = targetFile ? `${targetFile.oldPath ?? ''}:${targetFile.path}` : 'all'
  const [collapsedState, setCollapsedState] = useState<{
    scope: string
    indexes: Set<number>
  }>({ scope: reviewScope, indexes: new Set() })
  const collapsed =
    collapsedState.scope === reviewScope ? collapsedState.indexes : new Set<number>()

  const toggleSection = (index: number) => {
    setCollapsedState(prev => {
      const next = new Set(prev.scope === reviewScope ? prev.indexes : [])
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return { scope: reviewScope, indexes: next }
    })
  }

  if (!open) return null

  const sections = targetFile
    ? parseUnifiedDiff(diff).filter(
        section =>
          section.path === targetFile.path ||
          section.oldPath === targetFile.path ||
          section.path === targetFile.oldPath ||
          section.oldPath === targetFile.oldPath
      )
    : parseUnifiedDiff(diff)
  const title = targetFile
    ? t('file_changes.file_review_title', { path: targetFile.path })
    : t('file_changes.review_title')

  return createPortal(
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4 py-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-changes-review-title"
        className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
          <h2 id="file-changes-review-title" className="text-base font-semibold text-text-primary">
            {title}
          </h2>
          <button
            type="button"
            data-testid="close-file-changes-review-button"
            onClick={onClose}
            className="flex h-8 min-w-[36px] items-center justify-center rounded text-text-muted hover:bg-muted hover:text-text-primary"
            aria-label={t('file_changes.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-40 flex-1 overflow-auto p-3">
          {loading ? (
            <p className="py-8 text-center text-sm text-text-muted">
              {t('file_changes.loading_diff')}
            </p>
          ) : error ? (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
          ) : sections.length === 0 ? (
            <p className="py-8 text-center text-sm text-text-muted">
              {targetFile ? t('file_changes.empty_file_diff') : t('file_changes.empty_diff')}
            </p>
          ) : (
            <div className="space-y-3">
              {sections.map((section, index) => {
                const additions = section.lines.filter(
                  line => line.startsWith('+') && !line.startsWith('+++')
                ).length
                const deletions = section.lines.filter(
                  line => line.startsWith('-') && !line.startsWith('---')
                ).length

                return (
                  <section
                    key={`${section.path}-${index}`}
                    className="overflow-hidden rounded-lg border border-border"
                  >
                    <button
                      type="button"
                      onClick={() => toggleSection(index)}
                      className="flex w-full items-center gap-1.5 border-b border-border bg-surface px-2.5 py-1.5 text-left font-mono text-xs font-medium text-text-primary hover:bg-muted"
                    >
                      {collapsed.has(index) ? (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                      )}
                      <span className="min-w-0 flex-1 truncate">{section.path}</span>
                      <span className="shrink-0 font-mono text-[11px]">
                        <span className="text-green-600">+{additions}</span>{' '}
                        <span className="text-red-600">-{deletions}</span>
                      </span>
                    </button>
                    {!collapsed.has(index) && (
                      <pre className="grid overflow-x-auto bg-background p-0 font-mono text-xs leading-5">
                        {section.lines.map((line, lineIndex) => (
                          <span
                            key={`${lineIndex}-${line}`}
                            className={cn(
                              'px-2',
                              line.startsWith('+') &&
                                !line.startsWith('+++') &&
                                'bg-green-50 text-green-800',
                              line.startsWith('-') &&
                                !line.startsWith('---') &&
                                'bg-red-50 text-red-800',
                              (line.startsWith('@@') ||
                                line.startsWith('diff --git') ||
                                line.startsWith('index ')) &&
                                'bg-surface text-text-secondary'
                            )}
                          >
                            {line || ' '}
                          </span>
                        ))}
                      </pre>
                    )}
                  </section>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
