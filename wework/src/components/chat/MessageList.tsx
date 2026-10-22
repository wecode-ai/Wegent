import {
  MessageList as SharedMessageList,
  type MessageListProps,
} from '@wegent/collaboration/conversation'
import { DesktopToolServices } from './DesktopToolServices'
import {
  useDesktopConversationPresentation,
  type DesktopConversationPresentationProp,
} from './useDesktopConversationPresentation'
export { AssistantMessage } from './AssistantMessage'
export function MessageList({
  workspacePath,
  imageTarget,
  ...props
}: Omit<MessageListProps, DesktopConversationPresentationProp> & {
  workspacePath?: string
  imageTarget?: { deviceId: string; workspacePath: string } | null
}) {
  const presentation = useDesktopConversationPresentation(props.messages, workspacePath)
  return (
    <DesktopToolServices imageTarget={imageTarget}>
      <SharedMessageList {...props} {...presentation} />
    </DesktopToolServices>
  )
}
