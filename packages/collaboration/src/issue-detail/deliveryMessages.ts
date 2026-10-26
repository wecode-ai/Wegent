export interface DeliveryMessage {
  role: string
  content: string
}

/** Runtime and project-activity snapshots persist different sender fields. */
export function deliveryMessages(
  chat: Record<string, unknown> | null | undefined
): DeliveryMessage[] {
  if (!Array.isArray(chat?.messages)) return []
  return chat.messages.flatMap((message: unknown) => {
    if (
      !message ||
      typeof message !== 'object' ||
      !('content' in message) ||
      typeof message.content !== 'string'
    )
      return []
    if ('role' in message && typeof message.role === 'string') {
      return [{ role: message.role, content: message.content }]
    }
    if (
      !('sender' in message) ||
      !message.sender ||
      typeof message.sender !== 'object' ||
      !('type' in message.sender)
    )
      return []
    const role = message.sender.type === 'agent' ? 'assistant' : message.sender.type
    return typeof role === 'string' ? [{ role, content: message.content }] : []
  })
}
