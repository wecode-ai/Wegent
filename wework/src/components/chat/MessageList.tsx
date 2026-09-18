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
export function MessageList(props: Omit<MessageListProps, DesktopConversationPresentationProp>) {
  const presentation = useDesktopConversationPresentation()
  return (
    <DesktopToolServices>
      <SharedMessageList {...props} {...presentation} />
    </DesktopToolServices>
  )
}
