import {
  MessageTurnNavigation as SharedMessageTurnNavigation,
  type MessageTurnNavigationProps,
} from '@wegent/collaboration/conversation'
import { createCollaborationTranslator } from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'

export function MessageTurnNavigation(props: Omit<MessageTurnNavigationProps, 'translate'>) {
  const { i18n } = useTranslation('chat')
  return (
    <SharedMessageTurnNavigation
      {...props}
      translate={createCollaborationTranslator(i18n.language.startsWith('zh') ? 'zh-CN' : 'en')}
    />
  )
}
