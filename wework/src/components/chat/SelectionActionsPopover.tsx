import type { ComponentProps } from 'react'
import { SelectionActionsPopover as SharedSelectionActionsPopover } from '@wegent/collaboration/conversation'
import { DesktopConversationTranslation } from './DesktopConversationTranslation'

export function SelectionActionsPopover(
  props: ComponentProps<typeof SharedSelectionActionsPopover>
) {
  return (
    <DesktopConversationTranslation>
      <SharedSelectionActionsPopover {...props} />
    </DesktopConversationTranslation>
  )
}

export type { SelectionActionsPosition } from '@wegent/collaboration/conversation'
