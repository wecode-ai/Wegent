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
  virtualize,
  ...props
}: Omit<ScrollableMessageAreaProps, DesktopConversationPresentationProp> & {
  workspacePath?: string
  virtualize?: boolean
}) {
  const presentation = useDesktopConversationPresentation(props.messages, workspacePath)
  return (
    <DesktopToolServices>
      <SharedScrollableMessageArea
        {...props}
        {...presentation}
        virtualize={virtualize ?? presentation.virtualize}
      />
    </DesktopToolServices>
  )
}
