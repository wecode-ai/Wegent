import { XMindPreview } from '../../../../../packages/collaboration/src/files/XMindPreview'
import { useTranslation } from '@/hooks/useTranslation'

export function WorkspaceXMindPreview({ file, name }: { file: File; name: string }) {
  const { t } = useTranslation('common')
  return (
    <XMindPreview
      file={file}
      name={name}
      loadingLabel={t('workbench.workspace_file_preview_loading')}
      errorLabel={t('workbench.workspace_file_preview_failed')}
    />
  )
}
