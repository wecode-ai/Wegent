import type { ChatMessage } from '@/types/runtime'

/** Matches the PC follow-up contract without treating prepended history as a send. */
export function hasAppendedUserMessage(
  previous: readonly ChatMessage[],
  messages: readonly ChatMessage[]
): boolean {
  if (previous === messages) return false
  const previousTail = previous.at(-1)
  if (!previousTail) return messages.at(-1)?.role === 'user'
  const tailIndex = messages.findIndex(message => message.id === previousTail.id)
  if (tailIndex < 0) return false
  return messages.slice(tailIndex + 1).some(message => message.role === 'user')
}
