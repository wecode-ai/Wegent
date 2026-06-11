import { X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { parseUnifiedDiff } from './parseUnifiedDiff'

interface FileChangesReviewDialogProps {
  open: boolean
  loading: boolean
  diff: string
  error?: string
  onClose: () => void
}

export function FileChangesReviewDialog({
  open,
  loading,
  diff,
  error,
  onClose,
}: FileChangesReviewDialogProps) {
  const { t } = useTranslation('chat')
  useEscapeKey(onClose, open)

  if (!open) return null

  const sections = parseUnifiedDiff(diff)

  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4 py-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-changes-review-title"
        className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-base shadow-2xl"
      >
        <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-3">
          <h2
            id="file-changes-review-title"
            className="text-base font-semibold text-text-primary"
          >
            {t('file_changes.review_title')}
          </h2>
          <button
            type="button"
            data-testid="close-file-changes-review-button"
            onClick={onClose}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text-primary"
            aria-label={t('file_changes.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-40 flex-1 overflow-auto p-4">
          {loading ? (
            <p className="py-12 text-center text-sm text-text-muted">
              {t('file_changes.loading_diff')}
            </p>
          ) : error ? (
            <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </p>
          ) : sections.length === 0 ? (
            <p className="py-12 text-center text-sm text-text-muted">
              {t('file_changes.empty_diff')}
            </p>
          ) : (
            <div className="space-y-4">
              {sections.map((section, index) => (
                <section
                  key={`${section.path}-${index}`}
                  className="overflow-hidden rounded-lg border border-border"
                >
                  <h3 className="border-b border-border bg-surface px-3 py-2 font-mono text-xs font-medium text-text-primary">
                    {section.path}
                  </h3>
                  <pre className="overflow-x-auto bg-base p-0 font-mono text-xs leading-5">
                    {section.lines.map((line, lineIndex) => (
                      <span
                        key={`${lineIndex}-${line}`}
                        className={cn(
                          'block min-w-max px-3',
                          line.startsWith('+') &&
                            !line.startsWith('+++') &&
                            'bg-green-50 text-green-800',
                          line.startsWith('-') &&
                            !line.startsWith('---') &&
                            'bg-red-50 text-red-800',
                          (line.startsWith('@@') ||
                            line.startsWith('diff --git') ||
                            line.startsWith('index ')) &&
                            'bg-surface text-text-secondary',
                        )}
                      >
                        {line || ' '}
                      </span>
                    ))}
                  </pre>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
