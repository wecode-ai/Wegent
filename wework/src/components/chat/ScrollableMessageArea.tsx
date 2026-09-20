import {
  ScrollableMessageArea as SharedScrollableMessageArea,
  type ScrollableMessageAreaProps,
} from '@wegent/collaboration/conversation'
import { DesktopToolServices } from './DesktopToolServices'
import {
  useDesktopConversationPresentation,
  type DesktopConversationPresentationProp,
} from './useDesktopConversationPresentation'

export function ScrollableMessageArea({
  workspacePath,
  ...props
}: Omit<ScrollableMessageAreaProps, DesktopConversationPresentationProp> & {
  workspacePath?: string
}) {
  const presentation = useDesktopConversationPresentation(props.messages, workspacePath)
  return (
    <DesktopToolServices>
      <SharedScrollableMessageArea {...props} {...presentation} />
    </DesktopToolServices>
  )
}
