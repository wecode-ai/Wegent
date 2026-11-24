import { describe, expect, it } from 'vitest'
import type { MessageCenterRecord } from '@/api/standInMessageCenter'
import { classifyMessageCenterRecords, safeDingTalkUrl } from './messageCenterModel'

const receivedAt = '2026-11-24T07:00:00Z'
const verifiedReceipt: NonNullable<MessageCenterRecord['receipt']> = {
  id: 'channel-message-id',
  kind: 'channel_receipt',
  verifiedAt: '2026-11-24T07:01:00Z',
}

function record(id: string, facts: Partial<MessageCenterRecord> = {}): MessageCenterRecord {
  return {
    id,
    title: 'Where is the document?',
    sourceId: 'team',
    sourceName: 'Team group',
    sender: 'Alice',
    message: 'Please share the meeting notes.',
    at: receivedAt,
    decision: 'reply',
    progress: 'complete',
    delivery: 'none',
    takenOver: false,
    policyVersion: 3,
    deviceName: 'This computer',
    ...facts,
  }
}

describe('message center classification', () => {
  it('counts only effective answers with verified channel or recipient evidence', () => {
    const delivered = record('delivered', {
      delivery: 'confirmed',
      reply: 'The document is in the pinned group message.',
      receipt: verifiedReceipt,
      takenOver: true,
    })
    const recipientVerified = record('recipient-verified', {
      delivery: 'confirmed',
      reply: 'The meeting is at noon.',
      receipt: { ...verifiedReceipt, kind: 'recipient_verified' },
    })
    const missingReceipt = record('missing-receipt', {
      delivery: 'confirmed',
      reply: 'The meeting is at noon.',
    })
    const invalidReceipt = record('invalid-receipt', {
      ...delivered,
      id: 'invalid-receipt',
      receipt: { ...verifiedReceipt, verifiedAt: 'unverified' },
    })
    const transportAccepted = record('transport-accepted', {
      ...delivered,
      id: 'transport-accepted',
      receipt: {
        ...verifiedReceipt,
        kind: 'transport_accepted' as typeof verifiedReceipt.kind,
      },
    })
    const noReply = record('no-reply', { ...delivered, id: 'no-reply', reply: ' ' })
    const accepted = record('accepted', { delivery: 'submitted', reply: 'Please see the notes.' })
    const draft = record('draft', { progress: 'ready_to_send', reply: 'Please see the notes.' })

    const views = classifyMessageCenterRecords([
      missingReceipt,
      delivered,
      accepted,
      recipientVerified,
      draft,
      invalidReceipt,
      transportAccepted,
      noReply,
    ])

    expect(views.replied).toEqual([delivered, recipientVerified])
    expect(views.exceptions).toEqual([missingReceipt, invalidReceipt, transportAccepted, noReply])
    expect(views.in_progress).toEqual([accepted, draft])
  })

  it('retains takeover and delivery uncertainty together and deduplicates across views', () => {
    const exception = record('item', {
      at: '2026-11-24T07:10:00Z',
      decision: 'needs_user',
      delivery: 'unknown',
      takenOver: true,
    })
    const oldSnapshot = record('item', { decision: 'needs_user' })
    const handover = record('user-action', { takenOver: true, progress: 'generating' })
    const skipped = record('skip', { decision: 'skip' })

    const views = classifyMessageCenterRecords([oldSnapshot, handover, exception, skipped])

    expect(views).toEqual({
      replied: [],
      needs_user: [handover],
      skipped: [skipped],
      exceptions: [exception],
      in_progress: [],
    })
    expect(views.exceptions[0].takenOver).toBe(true)
  })
})

describe('DingTalk conversation links', () => {
  it('opens existing provider links and rejects lookalike domains and unsafe schemes', () => {
    expect(safeDingTalkUrl('https://im.dingtalk.com/thread/123')).toBe(
      'https://im.dingtalk.com/thread/123'
    )
    expect(safeDingTalkUrl(undefined)).toBeNull()
    expect(safeDingTalkUrl('dingtalk://dingtalkclient/action/open')).toBeNull()
    expect(safeDingTalkUrl('https://dingtalk.com.example.invalid/thread/123')).toBeNull()
    expect(safeDingTalkUrl('https://other-user@dingtalk.com/thread/123')).toBeNull()
    expect(safeDingTalkUrl('javascript:alert(1)')).toBeNull()
  })
})
