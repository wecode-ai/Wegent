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
  ...props
}: Omit<MessageListProps, DesktopConversationPresentationProp> & { workspacePath?: string }) {
  const presentation = useDesktopConversationPresentation(props.messages, workspacePath)
  return (
    <DesktopToolServices>
      <SharedMessageList {...props} {...presentation} />
    </DesktopToolServices>
  )
}
