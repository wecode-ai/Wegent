import type { MessageCenterRecord } from '@/api/standInMessageCenter'

export type StandInDelegationCategory =
  | 'replied'
  | 'needs_user'
  | 'skipped'
  | 'exceptions'
  | 'in_progress'

export function standInDelegationCategory(record: MessageCenterRecord): StandInDelegationCategory {
  if (record.delivery === 'failed' || record.delivery === 'unknown') return 'exceptions'
  if (record.delivery === 'confirmed') {
    const { decision, receipt, reply } = record
    if (
      decision === 'reply' &&
      reply?.trim() &&
      receipt?.id.trim() &&
      (receipt.kind === 'channel_receipt' || receipt.kind === 'recipient_verified') &&
      (!receipt.verifiedAt || Number.isFinite(Date.parse(receipt.verifiedAt)))
    ) {
      return 'replied'
    }
    return 'exceptions'
  }
  if (record.delivery === 'submitted') return 'in_progress'
  if (record.takenOver || record.decision === 'needs_user') return 'needs_user'
  if (record.decision === 'skip') return 'skipped'
  return 'in_progress'
}
