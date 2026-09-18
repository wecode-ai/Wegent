import { useCallback, type ComponentProps } from 'react'
import { AssistantMessage as SharedAssistantMessage } from '@wegent/collaboration/conversation'
import { CodexInlineVisualizationHost } from './CodexInlineVisualizationHost'
import { DesktopToolServices } from './DesktopToolServices'
import { useAttachmentImageServices } from './useAttachmentImageServices'

export function AssistantMessage(
  props: Omit<
    ComponentProps<typeof SharedAssistantMessage>,
    'imageServices' | 'renderVisualization'
  >
) {
  const imageServices = useAttachmentImageServices()
  const fileChanges = props.message.fileChanges
  const renderVisualization = useCallback(
    (part: { file: string; mode?: 'wide'; title?: string }) => (
      <CodexInlineVisualizationHost {...part} fileChanges={fileChanges} />
    ),
    [fileChanges]
  )
  return (
    <DesktopToolServices>
      <SharedAssistantMessage
        {...props}
        imageServices={imageServices}
        renderVisualization={renderVisualization}
      />
    </DesktopToolServices>
  )
}
