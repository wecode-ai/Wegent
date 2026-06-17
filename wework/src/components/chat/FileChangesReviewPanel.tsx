import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { parseUnifiedDiff } from './parseUnifiedDiff'

interface FileChangesReviewPanelProps {
  loading: boolean
  diff: string
  error?: string
  className?: string
}

export function FileChangesReviewPanel({
  loading,
  diff,
  error,
  className,
}: FileChangesReviewPanelProps) {
  const { t } = useTranslation('chat')
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())

  const toggleSection = (index: number) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return next
    })
  }

  const sections = parseUnifiedDiff(diff)

  return (
    <div
      data-testid="file-changes-review-panel"
      className={cn('min-h-0 flex-1 overflow-auto p-3', className)}
    >
      {loading ? (
        <p className="py-8 text-center text-sm text-text-muted">{t('file_changes.loading_diff')}</p>
      ) : error ? (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      ) : sections.length === 0 ? (
        <p className="py-8 text-center text-sm text-text-muted">{t('file_changes.empty_diff')}</p>
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
  )
}
