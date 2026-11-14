import type { RuntimeTaskAddress } from '@/types/api'
import type { ExperiencePrivateConversation } from '../model'

const accepted = new Map<string, ExperiencePrivateConversation>()

function receiptKey(accountKey: string, address: Pick<RuntimeTaskAddress, 'deviceId' | 'taskId'>) {
  return JSON.stringify([accountKey, address.deviceId, address.taskId])
}

/** Called only after the owned conversation API has accepted a message. Never persisted from URLs. */
export function recordAcceptedAssistantConversation(
  accountKey: string,
  ownerUserId: number,
  address: RuntimeTaskAddress,
  title: string
) {
  const conversation: ExperiencePrivateConversation = {
    key: JSON.stringify([address.deviceId, address.taskId]),
    ownerUserId,
    address,
    title,
    bindingIds: [],
    sourceNodeIds: [],
    linkedAt: null,
  }
  accepted.set(receiptKey(accountKey, address), conversation)
  return conversation
}

export function acceptedAssistantConversation(
  accountKey: string,
  address: Pick<RuntimeTaskAddress, 'deviceId' | 'taskId'>
) {
  return accepted.get(receiptKey(accountKey, address)) ?? null
}
