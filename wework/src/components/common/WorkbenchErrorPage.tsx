import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { copyTextToClipboard } from '@/lib/clipboard'
import { useState } from 'react'

interface WorkbenchErrorPageProps {
  kind?: 'startup' | 'crash'
  error: unknown
  componentStack?: string | null
}

export function WorkbenchErrorPage({
  kind = 'crash',
  error,
  componentStack,
}: WorkbenchErrorPageProps) {
  const { t } = useTranslation('common')
  const testId = kind === 'startup' ? 'workbench-startup' : 'workbench-crash'
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'copy_failed'>('idle')

  async function copyDebugInfo() {
    setCopyState('copying')
    try {
      const details =
        error instanceof Error
          ? error.stack || `${error.name}: ${error.message}`
          : typeof error === 'string'
            ? error
            : `Thrown value type: ${error === null ? 'null' : typeof error}`
      await copyTextToClipboard(
        [`Wework frontend error (${kind})`, details, componentStack?.trim()]
          .filter(Boolean)
          .join('\n\n')
      )
      setCopyState('copied')
    } catch {
      setCopyState('copy_failed')
    }
  }

  return (
    <main
      className="flex min-h-screen items-center justify-center bg-background p-6 text-text-primary"
      data-testid={`${testId}-error`}
    >
      <section className="max-w-md space-y-4" role="alert">
        <h1 className="heading-subsection">{t(`workbench_error.${kind}_title`)}</h1>
        <p className="text-base text-text-secondary">{t(`workbench_error.${kind}_description`)}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            data-testid={`${testId}-retry`}
            onClick={() => window.location.reload()}
            type="button"
          >
            {t('workbench_error.reload')}
          </Button>
          <Button
            data-testid={`${testId}-copy-debug`}
            disabled={copyState === 'copying'}
            onClick={copyDebugInfo}
            type="button"
            variant="secondary"
          >
            {t('workbench_error.copy_debug')}
          </Button>
        </div>
        <div role="status" className="text-sm text-text-secondary empty:hidden">
          {copyState !== 'idle' && t(`workbench_error.${copyState}`)}
        </div>
      </section>
    </main>
  )
}
