import {
  ConversationQueuePanel as SharedConversationQueuePanel,
  type ConversationQueuePanelProps,
} from '@wegent/collaboration/conversation/ConversationQueuePanel'
import { useTranslation } from '@/hooks/useTranslation'
import { createCollaborationTranslator } from '@wegent/collaboration'
export function ConversationQueuePanel(props: Omit<ConversationQueuePanelProps, 'translate'>) {
  const { i18n } = useTranslation('common')
  return (
    <SharedConversationQueuePanel
      {...props}
      translate={createCollaborationTranslator(i18n.language.startsWith('zh') ? 'zh-CN' : 'en')}
    />
  )
}
