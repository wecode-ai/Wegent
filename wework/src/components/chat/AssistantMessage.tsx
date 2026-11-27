import type { ComponentProps } from 'react'
import { AssistantMessage as SharedAssistantMessage } from '@wegent/collaboration/conversation'
import { renderDesktopMessageVisualization } from './useDesktopConversationPresentation'
import { DesktopToolServices } from './DesktopToolServices'
import { useAttachmentImageServices } from './useAttachmentImageServices'

export function AssistantMessage(
  props: Omit<
    ComponentProps<typeof SharedAssistantMessage>,
    'imageServices' | 'renderVisualization'
  >
) {
  const imageServices = useAttachmentImageServices()
  return (
    <DesktopToolServices>
      <SharedAssistantMessage
        {...props}
        imageServices={imageServices}
        renderVisualization={renderDesktopMessageVisualization}
      />
    </DesktopToolServices>
  )
}
