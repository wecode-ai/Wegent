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
  imageTarget,
  ...props
}: Omit<MessageListProps, DesktopConversationPresentationProp> & {
  imageTarget?: { deviceId: string; workspacePath: string } | null
}) {
  const presentation = useDesktopConversationPresentation(props.messages)
  return (
    <DesktopToolServices imageTarget={imageTarget}>
      <SharedMessageList {...props} {...presentation} />
    </DesktopToolServices>
  )
}
