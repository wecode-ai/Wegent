import { describe, expect, it, vi } from 'vitest'
import { createDingTalkMessageCenterApi } from './dingTalkMessageCenterApi'

const scope = { userId: 42, deviceId: 'local' }
const account = { profile: 'profile', accountId: 'account', organizationId: 'organization' }
const source = {
  ...account,
  providerId: '@wegent/dsh-connection-dingtalk/dingtalk',
  kind: 'group',
  id: 'channel',
  name: 'Channel',
  delegated: true,
  policy: { automatic: true, askBeforeAct: false },
}
const at = '2026-01-01T00:00:00Z'
const message = {
  id: 'source-event',
  recordId: 'earlier-message',
  senderId: 'sender',
  text: 'The message that was handled',
  at,
  source,
}
const decision = {
  recordId: message.recordId,
  action: 'reply' as const,
  status: 'unknown' as const,
  text: 'A reply',
  channelTaskId: 'channel-task',
  attemptId: 'attempt',
  submittedAt: '2026-01-01T00:00:01Z',
  deliveryReason: 'The channel has not confirmed delivery',
}
const grouped = {
  id: 'grouped-work',
  taskId: 'task',
  roleId: '@primary',
  title: 'Thread',
  status: 'sent' as const,
  source,
  updatedAt: at,
  messageCount: 2,
  latestMessage: { ...message, recordId: 'later-message', text: 'A later thread message' },
  delegationResult: decision,
}
const staleSource = { ...source, organizationId: 'previous-organization' }

function executor() {
  const settings = {
    userId: scope.userId,
    executionDeviceId: scope.deviceId,
    version: 19,
    roles: [],
    primary: {
      prompt: '',
      preferences: '',
      enabled: true,
      connections: [source, staleSource],
      delegation: { ...account, version: 7, authorized: true, paused: true },
    },
  }
  return {
    settings,
    api: {
      personalGet: vi.fn(async () => settings),
      connectionReadiness: vi.fn(async () => ({
        status: 'ready',
        identity: { ...account, accountName: 'Account', organizationName: 'Organization' },
      })),
      inbox: vi.fn(async () => ({
        items: [
          grouped,
          { ...grouped, id: 'stale-work', source: staleSource },
          {
            ...grouped,
            id: 'skipped-work',
            latestMessage: { ...message, recordId: 'skipped-message' },
            delegationResult: {
              ...decision,
              recordId: 'skipped-message',
              action: 'skip' as const,
            },
          },
        ],
        sourceErrors: [
          { source, error: { code: 'dingtalk_delegation_gap', message: 'Gap' } },
          {
            source: staleSource,
            error: { code: 'dingtalk_delegation_gap', message: 'Previous organization gap' },
          },
        ],
      })),
      workMessages: vi.fn(async () => ({ messages: [message] })),
      takeOverWork: vi.fn(async () => {}),
      verifyWorkDelivery: vi.fn(async () => {}),
    },
  }
}

describe('DingTalk message center host projection', () => {
  it('keeps only the current organization and uses the exact source message of a grouped result', async () => {
    const { api } = executor()
    const center = createDingTalkMessageCenterApi(api)
    const snapshot = await center.read(scope)

    expect(snapshot.sources.map(row => row.conversationId)).toEqual(['channel'])
    expect(snapshot.policyVersion).toBe(7)
    expect(snapshot.status).toBe('paused')
    expect(snapshot.syncGap).toBe('Gap')
    expect(snapshot.records).toMatchObject([
      {
        id: 'earlier-message',
        message: message.text,
        canTakeOver: false,
        canVerify: true,
        delivery: 'unknown',
        reason: decision.deliveryReason,
      },
      { id: 'skipped-message', decision: 'skip', delivery: 'none' },
    ])
    expect(api.workMessages).toHaveBeenCalledExactlyOnceWith(42, 'local', 'grouped-work')
    const expected = { identityId: snapshot.identity!.id, policyVersion: 7 }

    await expect(
      center.apply(scope, expected, { type: 'takeOver', recordId: message.recordId })
    ).rejects.toThrow('unavailable')
    expect(api.takeOverWork).not.toHaveBeenCalled()
    await center.apply(scope, expected, { type: 'verifyDelivery', recordId: message.recordId })
    expect(api.verifyWorkDelivery).toHaveBeenCalledExactlyOnceWith(
      42,
      'local',
      'grouped-work',
      'earlier-message'
    )
  })

  it('conceals history when readiness shows a different organization', async () => {
    const { api } = executor()
    const center = createDingTalkMessageCenterApi(api)
    api.connectionReadiness.mockResolvedValueOnce({
      status: 'ready',
      identity: {
        ...account,
        accountName: 'Account',
        organizationId: 'new-organization',
        organizationName: 'New organization',
      },
    })

    const snapshot = await center.read(scope)

    expect(snapshot.identity).toBeNull()
    expect(snapshot.records).toEqual([])
    expect(api.inbox).not.toHaveBeenCalled()
  })
})
