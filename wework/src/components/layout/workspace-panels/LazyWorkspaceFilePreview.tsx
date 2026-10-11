import { lazy, Suspense, type ComponentProps } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

const FilePreview = lazy(() =>
  import('./WorkspaceFilePreview').then(module => ({ default: module.WorkspaceFilePreview }))
)

export function WorkspaceFilePreview(props: ComponentProps<typeof FilePreview>) {
  const { t } = useTranslation('common')
  return (
    <Suspense
      fallback={
        <section
          role="status"
          className="flex min-w-0 flex-1 items-center justify-center px-6 text-sm text-text-secondary"
        >
          {t('workbench.workspace_file_preview_loading')}
        </section>
      }
    >
      <FilePreview {...props} />
    </Suspense>
  )
}
