import { CheckCircle2, Code2, Loader2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { createLocalCodexPluginApi, type ExternalContentSource } from '@/api/local/codexPlugins'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

interface ExternalContentImportDialogProps {
  onClose: () => void
}

const sources: Array<{ id: ExternalContentSource; name: string }> = [
  { id: 'codex', name: 'Codex' },
  { id: 'claude-code', name: 'Claude Code' },
]

export function ExternalContentImportDialog({ onClose }: ExternalContentImportDialogProps) {
  const { t } = useTranslation('common')
  const api = useMemo(() => createLocalCodexPluginApi(), [])
  const [source, setSource] = useState<ExternalContentSource>('codex')
  const [importing, setImporting] = useState(false)
  const [completed, setCompleted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleImport = async () => {
    setImporting(true)
    setError(null)
    try {
      await api.importExternalContent(source)
      setCompleted(true)
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/30 px-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="external-content-import-title"
        data-testid="external-content-import-dialog"
        className="w-full max-w-lg rounded-xl border border-border bg-background p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2
              id="external-content-import-title"
              className="text-base font-semibold text-text-primary"
            >
              {t('workbench.external_import_title')}
            </h2>
            <p className="mt-1 text-sm leading-6 text-text-secondary">
              {t('workbench.external_import_description')}
            </p>
          </div>
          <button
            type="button"
            data-testid="external-content-import-close-button"
            aria-label={t('common.close', '关闭')}
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-surface hover:text-text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {completed ? (
          <div data-testid="external-content-import-success" className="py-8 text-center">
            <CheckCircle2 className="mx-auto h-10 w-10 text-primary" />
            <div className="mt-3 text-sm font-medium text-text-primary">
              {sources.find(item => item.id === source)?.name}{' '}
              {t('workbench.external_import_success')}
            </div>
          </div>
        ) : (
          <>
            <div className="mt-5 grid grid-cols-2 gap-3">
              {sources.map(item => (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`external-content-source-${item.id}`}
                  aria-pressed={source === item.id}
                  disabled={importing}
                  onClick={() => setSource(item.id)}
                  className={cn(
                    'flex min-h-20 flex-col items-start justify-center rounded-lg border px-4 text-left transition-colors disabled:opacity-60',
                    source === item.id
                      ? 'border-primary bg-primary/5'
                      : 'border-border bg-background hover:bg-surface'
                  )}
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-text-primary">
                    <Code2 className="h-4 w-4" />
                    {item.name}
                  </span>
                  <span className="mt-1 text-xs leading-4 text-text-secondary">
                    {t(`workbench.external_import_${item.id.replace('-', '_')}_description`)}
                  </span>
                </button>
              ))}
            </div>
            {error && (
              <div
                data-testid="external-content-import-error"
                className="mt-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-500"
              >
                {error}
              </div>
            )}
          </>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-md px-3 text-sm text-text-secondary hover:bg-surface"
          >
            {completed ? t('common.done', '完成') : t('common.cancel', '取消')}
          </button>
          {!completed && (
            <button
              type="button"
              data-testid="external-content-import-confirm-button"
              disabled={importing}
              onClick={() => void handleImport()}
              className="flex h-8 items-center gap-2 rounded-md bg-text-primary px-3 text-sm font-medium text-background hover:bg-text-primary/90 disabled:opacity-60"
            >
              {importing && <Loader2 className="h-4 w-4 animate-spin" />}
              {importing
                ? t('workbench.external_import_importing')
                : t('workbench.external_import_action')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
