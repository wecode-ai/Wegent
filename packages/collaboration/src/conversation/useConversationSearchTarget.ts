import { useId } from 'react'
import { useConversationSearchHighlights } from '../dom-events'
import type { ConversationSearchHighlightOptions } from './conversationSearchHighlightBinding'
export type { ConversationSearchTarget } from './conversationSearchHighlightBinding'
export {
  readConversationSearchContent,
  conversationSearchRanges,
} from './conversationSearchHighlightBinding'

export function useConversationSearchTarget(options: ConversationSearchHighlightOptions) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '')
  useConversationSearchHighlights(options, id)
}
