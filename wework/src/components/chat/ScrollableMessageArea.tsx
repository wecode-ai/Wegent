import {
  ScrollableMessageArea as SharedScrollableMessageArea,
  type ScrollableMessageAreaProps,
} from '@wegent/collaboration/conversation'
import { DesktopToolServices } from './DesktopToolServices'
import {
  useDesktopConversationPresentation,
  type DesktopConversationPresentationProp,
} from './useDesktopConversationPresentation'

export function ScrollableMessageArea(
  props: Omit<ScrollableMessageAreaProps, DesktopConversationPresentationProp>
) {
  const presentation = useDesktopConversationPresentation()
  return (
    <DesktopToolServices>
      <SharedScrollableMessageArea {...props} {...presentation} />
    </DesktopToolServices>
  )
}
