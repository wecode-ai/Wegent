import {
  RuntimeExecutionDetails,
  type RuntimeExecutionDetailsProps,
} from './RuntimeExecutionDetails'
import { ConversationTranslationProvider } from '../conversation/ConversationTranslation'
import { ScrollableMessageArea } from '../conversation/ScrollableMessageArea'
import type { ScrollableMessageAreaProps } from '../conversation/scrollableMessageTypes'
import { DESKTOP_MESSAGE_LIST_WIDTH_CLASS } from '../conversation/conversationLayout'

/** Full PC execution viewer; adapters supply a session and real platform services. */
export function RuntimeExecutionConversation({
  conversation,
  ...details
}: Omit<RuntimeExecutionDetailsProps, 'children'> & {
  conversation: ScrollableMessageAreaProps
}) {
  return (
    <RuntimeExecutionDetails {...details}>
      <ConversationTranslationProvider translate={details.translate}>
        <ScrollableMessageArea
          {...conversation}
          className="h-full"
          messageListClassName={DESKTOP_MESSAGE_LIST_WIDTH_CLASS}
          scrollTestId="runtime-execution-detail-scroll"
        />
      </ConversationTranslationProvider>
    </RuntimeExecutionDetails>
  )
}
