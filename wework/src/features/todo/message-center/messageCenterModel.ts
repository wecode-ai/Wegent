import type { MessageCenterRecord } from '@/api/standInMessageCenter'

export type MessageCenterCategory =
  | 'replied'
  | 'needs_user'
  | 'skipped'
  | 'exceptions'
  | 'in_progress'

function messageCategory(record: MessageCenterRecord): MessageCenterCategory {
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

export function classifyMessageCenterRecords(
  records: readonly MessageCenterRecord[]
): Record<MessageCenterCategory, MessageCenterRecord[]> {
  const categories: Record<MessageCenterCategory, MessageCenterRecord[]> = {
    replied: [],
    needs_user: [],
    skipped: [],
    exceptions: [],
    in_progress: [],
  }
  const sorted = [...records].sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
  const seen = new Set<string>()
  for (const record of sorted) {
    if (seen.has(record.id)) continue
    seen.add(record.id)
    categories[messageCategory(record)].push(record)
  }
  return categories
}

export function isToday(value: string | undefined, now = new Date()): boolean {
  const date = new Date(value ?? '')
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  )
}

export function safeDingTalkUrl(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.username || url.password) return null
    if (
      url.protocol === 'https:' &&
      (url.hostname === 'dingtalk.com' || url.hostname.endsWith('.dingtalk.com'))
    ) {
      return url.href
    }
  } catch {
    return null
  }
  return null
}
