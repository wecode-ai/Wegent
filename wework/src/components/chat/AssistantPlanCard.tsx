import type { ComponentProps } from 'react'
import { AssistantPlanCard as SharedAssistantPlanCard } from '@wegent/collaboration/conversation'
import { MarkdownServicesProvider } from '@wegent/collaboration/markdown'
import { DesktopConversationTranslation } from './DesktopConversationTranslation'
import { useDesktopMarkdownServices } from './useDesktopMarkdownServices'
export type { AssistantPlanOpenRequest } from '@wegent/collaboration/conversation'

export function AssistantPlanCard(props: ComponentProps<typeof SharedAssistantPlanCard>) {
  const services = useDesktopMarkdownServices()
  return (
    <DesktopConversationTranslation>
      <MarkdownServicesProvider value={services}>
        <SharedAssistantPlanCard {...props} />
      </MarkdownServicesProvider>
    </DesktopConversationTranslation>
  )
}
