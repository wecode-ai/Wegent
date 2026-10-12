import { lazy, Suspense, type ComponentProps } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

const FilePanel = lazy(() =>
  import('./FileWorkspacePanel').then(module => ({ default: module.FileWorkspacePanel }))
)
const FilePreview = lazy(() =>
  import('./WorkspaceFilePreview').then(module => ({ default: module.WorkspaceFilePreview }))
)
const ReviewPanel = lazy(() =>
  import('@/components/chat/FileChangesReviewPanel').then(module => ({
    default: module.FileChangesReviewPanel,
  }))
)

function FilePanelLoading() {
  const { t } = useTranslation('common')
  return (
    <div
      role="status"
      className="flex min-h-0 flex-1 items-center justify-center text-sm text-text-secondary"
    >
      {t('common.loading')}
    </div>
  )
}

export function FileWorkspacePanel(props: ComponentProps<typeof FilePanel>) {
  return (
    <Suspense fallback={<FilePanelLoading />}>
      <FilePanel {...props} />
    </Suspense>
  )
}

export function WorkspaceFilePreview(props: ComponentProps<typeof FilePreview>) {
  return (
    <Suspense fallback={<FilePanelLoading />}>
      <FilePreview {...props} />
    </Suspense>
  )
}

export function FileChangesReviewPanel(props: ComponentProps<typeof ReviewPanel>) {
  return (
    <Suspense fallback={<FilePanelLoading />}>
      <ReviewPanel {...props} />
    </Suspense>
  )
}
