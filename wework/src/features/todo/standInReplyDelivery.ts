import type { StandInInboxWork, StandInReplyDelivery } from '@/api/standIn'

export function standInWorkDelivery(work?: StandInInboxWork): StandInReplyDelivery | undefined {
  return work?.replyDelivery ?? work?.latestMessage?.replyDelivery ?? undefined
}

export function replyDeliveryStatus(
  delivery: StandInReplyDelivery
): StandInReplyDelivery['status'] {
  return delivery.status === 'confirmed_sent' && !delivery.receipt?.messageId?.trim()
    ? 'unknown'
    : delivery.status
}

export function replyDeliveryOwnerLabel(delivery?: StandInReplyDelivery) {
  if (delivery?.reasonCode === 'owner_intervened') {
    return 'standIn.workspace.reply_delivery_owner_intervened'
  }
  if (delivery?.takenOver) return 'standIn.workspace.reply_delivery_taken_over'
}
