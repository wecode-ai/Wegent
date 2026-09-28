import {
  ImSourceBadge as SharedImSourceBadge,
  type ImSourceBadgeProps,
} from '@wegent/collaboration/conversation'
import { DesktopConversationTranslation } from '../chat/DesktopConversationTranslation'

export function ImSourceBadge(props: ImSourceBadgeProps) {
  return (
    <DesktopConversationTranslation>
      <SharedImSourceBadge {...props} />
    </DesktopConversationTranslation>
  )
}
