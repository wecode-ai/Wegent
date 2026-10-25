import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

interface WorkbenchErrorPageProps {
  kind?: 'startup' | 'crash'
}

export function WorkbenchErrorPage({ kind = 'crash' }: WorkbenchErrorPageProps) {
  const { t } = useTranslation('common')
  const testId = kind === 'startup' ? 'workbench-startup' : 'workbench-crash'

  return (
    <main
      className="flex min-h-screen items-center justify-center bg-background p-6 text-text-primary"
      data-testid={`${testId}-error`}
    >
      <section className="max-w-md space-y-4" role="alert">
        <h1 className="heading-subsection">{t(`workbench_error.${kind}_title`)}</h1>
        <p className="text-base text-text-secondary">{t(`workbench_error.${kind}_description`)}</p>
        <Button
          data-testid={`${testId}-retry`}
          onClick={() => window.location.reload()}
          type="button"
        >
          {t('workbench_error.reload')}
        </Button>
      </section>
    </main>
  )
}
