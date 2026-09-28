import { PermissionModeSelector as SharedPermissionModeSelector } from '@wegent/collaboration/controls'
import { createCollaborationTranslator } from '@wegent/collaboration'
import type { PermissionModeSelectorProps } from '@wegent/collaboration/controls'
import { useTranslation } from '@/hooks/useTranslation'

export function PermissionModeSelector(props: Omit<PermissionModeSelectorProps, 'translate'>) {
  const { i18n } = useTranslation('common')
  return (
    <SharedPermissionModeSelector
      {...props}
      translate={createCollaborationTranslator(i18n.language.startsWith('zh') ? 'zh-CN' : 'en')}
    />
  )
}
