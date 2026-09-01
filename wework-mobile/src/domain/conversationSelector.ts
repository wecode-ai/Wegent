export type ConversationSelector =
  'device' | 'project' | 'workMode' | 'branch' | 'permission' | null

export function conversationSelectorVisible(
  selector: ConversationSelector,
  isNewConversation: boolean
): boolean {
  if (selector === 'permission') return true
  return isNewConversation && selector !== null && selector !== 'branch'
}
