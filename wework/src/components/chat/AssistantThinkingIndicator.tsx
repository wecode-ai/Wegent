import type { ComponentProps } from 'react'
import { AssistantThinkingIndicator as SharedAssistantThinkingIndicator } from '@wegent/collaboration/conversation'
import { DesktopConversationTranslation } from './DesktopConversationTranslation'

export function AssistantThinkingIndicator(
  props: ComponentProps<typeof SharedAssistantThinkingIndicator>
) {
  return (
    <DesktopConversationTranslation>
      <SharedAssistantThinkingIndicator {...props} />
    </DesktopConversationTranslation>
  )
}
