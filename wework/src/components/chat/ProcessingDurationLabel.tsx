import type { ComponentProps } from 'react'
import { ProcessingDurationLabel as SharedProcessingDurationLabel } from '@wegent/collaboration/conversation'
import { DesktopConversationTranslation } from './DesktopConversationTranslation'

export function ProcessingDurationLabel(
  props: ComponentProps<typeof SharedProcessingDurationLabel>
) {
  return (
    <DesktopConversationTranslation>
      <SharedProcessingDurationLabel {...props} />
    </DesktopConversationTranslation>
  )
}
