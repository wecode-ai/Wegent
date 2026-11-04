import { randomUUID } from 'node:crypto'

export interface NotificationReply {
  id: string
  interactionId: string
  accountKey: string
  text: string
  url: string
}

/** Native replies survive renderer reloads until the main window acknowledges them. */
const replies = new Map<string, NotificationReply>()

export function enqueueNotificationReply(reply: Omit<NotificationReply, 'id'>): void {
  const id = randomUUID()
  replies.set(id, { ...reply, id })
}

export function pendingNotificationReplies(accountKey: string): NotificationReply[] {
  return [...replies.values()].filter(reply => reply.accountKey === accountKey)
}

export function acknowledgeNotificationReply(id: string, accountKey: string): void {
  if (replies.get(id)?.accountKey === accountKey) replies.delete(id)
}
