import { describe, expect, it } from 'vitest'
import type { MessageCenterRecord } from '@/api/standInMessageCenter'
import { standInDelegationCategory } from './standInDelegationRecords'

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

describe('stand-in delegation records', () => {
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

    expect([delivered, recipientVerified].map(standInDelegationCategory)).toEqual([
      'replied',
      'replied',
    ])
    expect(
      [missingReceipt, invalidReceipt, transportAccepted, noReply].map(standInDelegationCategory)
    ).toEqual(['exceptions', 'exceptions', 'exceptions', 'exceptions'])
    expect([accepted, draft].map(standInDelegationCategory)).toEqual(['in_progress', 'in_progress'])
  })

  it('prioritizes delivery uncertainty over takeover', () => {
    const exception = record('item', {
      at: '2026-11-24T07:10:00Z',
      decision: 'needs_user',
      delivery: 'unknown',
      takenOver: true,
    })
    const handover = record('user-action', { takenOver: true, progress: 'generating' })
    const skipped = record('skip', { decision: 'skip' })

    expect(standInDelegationCategory(exception)).toBe('exceptions')
    expect(standInDelegationCategory(handover)).toBe('needs_user')
    expect(standInDelegationCategory(skipped)).toBe('skipped')
  })

  it('recognizes a valid receipt without a timestamp', () => {
    const delivered = record('verified-without-date', {
      delivery: 'confirmed',
      reply: 'See the pinned document.',
      receipt: { id: 'reply-id', kind: 'channel_receipt' },
    })
    expect(standInDelegationCategory(delivered)).toBe('replied')
  })

  it('keeps technical failures and failed work in exceptions instead of business handoffs', () => {
    const technical = record('technical', {
      decision: 'needs_user',
      delivery: 'failed',
      reason: 'The reply transport is unavailable.',
    })
    const failedWork = record('failed-work', {
      decision: null,
      progress: 'complete',
      delivery: 'failed',
      reason: 'The executor stopped before producing a decision.',
    })

    expect([technical, failedWork].map(standInDelegationCategory)).toEqual([
      'exceptions',
      'exceptions',
    ])
  })
})
