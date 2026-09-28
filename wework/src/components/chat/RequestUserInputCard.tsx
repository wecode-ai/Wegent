import type { ComponentProps } from 'react'
import {
  RequestUserInputCard as SharedRequestUserInputCard,
  RequestUserInputSummary as SharedRequestUserInputSummary,
} from '@wegent/collaboration/conversation'
import { DesktopConversationTranslation } from './DesktopConversationTranslation'
export type { RequestUserInputPayload } from '@wegent/chat-core/runtime'

export function RequestUserInputCard(props: ComponentProps<typeof SharedRequestUserInputCard>) {
  return (
    <DesktopConversationTranslation>
      <SharedRequestUserInputCard {...props} />
    </DesktopConversationTranslation>
  )
}

export function RequestUserInputSummary(
  props: ComponentProps<typeof SharedRequestUserInputSummary>
) {
  return (
    <DesktopConversationTranslation>
      <SharedRequestUserInputSummary {...props} />
    </DesktopConversationTranslation>
  )
}
