import { describe, expect, it, vi } from 'vitest'
import type { PersonalStandInSettings } from '@/api/personalStandIn'
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
  evidenceIds: ['source-event'],
  evidence: [
    {
      messageId: 'source-event',
      senderId: 'seed-sender',
      at: '2025-12-31T23:59:00Z',
      excerpt: 'The original evidence text',
    },
  ],
}
const laterMessage = {
  ...message,
  id: 'later-source-event',
  recordId: 'later-message',
  senderId: 'later-sender',
  text: 'A later thread message',
  at: '2026-01-01T00:02:00Z',
  delegationResult: {
    ...decision,
    recordId: 'later-message',
    action: 'needs_user' as const,
    status: 'complete' as const,
    text: undefined,
    channelTaskId: undefined,
    attemptId: undefined,
    submittedAt: undefined,
    deliveryReason: undefined,
    reason: 'This needs the account owner.',
    evidenceIds: [],
  },
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
  latestMessage: laterMessage,
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
      model: { runtime: 'codex' as const, provider: 'fixture', model_id: 'fixture' },
      connections: [source, staleSource],
      delegation: {
        ...account,
        version: 7,
        authorized: true,
        paused: true,
        templates: { document: true, schedule: false, process: true },
      },
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
            messageCount: 1,
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
      workMessages: vi.fn(async (_userId: number, _deviceId: string, workId: string) => ({
        messages: workId === 'grouped-work' ? [message, laterMessage] : [],
      })),
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
        canTakeOver: true,
        canVerify: true,
        delivery: 'unknown',
        evidence: [
          {
            label: 'seed-sender · 2025-12-31T23:59:00Z',
            excerpt: 'The original evidence text',
          },
        ],
        reason: decision.deliveryReason,
      },
      {
        id: 'later-message',
        message: laterMessage.text,
        delivery: 'none',
        canTakeOver: true,
        reason: 'This needs the account owner.',
      },
      { id: 'skipped-message', decision: 'skip', delivery: 'none' },
    ])
    expect(api.workMessages).toHaveBeenCalledWith(42, 'local', 'grouped-work')
    const expected = { identityId: snapshot.identity!.id, policyVersion: 7 }

    await center.apply(scope, expected, { type: 'takeOver', recordId: message.recordId })
    expect(api.takeOverWork).toHaveBeenCalledExactlyOnceWith(42, 'local', 'grouped-work')
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

  it('distinguishes missing readiness support from a missing delegation binding', async () => {
    const { api, settings } = executor()
    const { connectionReadiness, ...olderApi } = api
    await expect(createDingTalkMessageCenterApi(olderApi).read(scope)).resolves.toMatchObject({
      status: 'unavailable',
      capabilities: ['refresh'],
    })
    api.personalGet.mockResolvedValueOnce({
      ...settings,
      primary: { ...settings.primary, delegation: { ...settings.primary.delegation, profile: '' } },
    })
    await expect(createDingTalkMessageCenterApi(api).read(scope)).resolves.toMatchObject({
      status: 'disconnected',
      capabilities: ['refresh'],
    })
    expect(connectionReadiness).not.toHaveBeenCalled()
    expect(api.inbox).not.toHaveBeenCalled()
  })

  it('recognizes a saved receive scope without exposing delegation records', async () => {
    const { api, settings } = executor()
    const center = createDingTalkMessageCenterApi({
      ...api,
      personalGet: async () => ({
        ...settings,
        primary: {
          ...settings.primary,
          delegation: undefined,
          dingTalkConnectionMode: 'confirmed',
        },
      }),
    })

    await expect(center.read(scope)).resolves.toMatchObject({
      status: 'configured',
      identity: null,
      records: [],
      capabilities: ['refresh'],
    })
    expect(api.inbox).not.toHaveBeenCalled()
  })

  it('uses the versioned settings save for resume and pause and preserves the saved scope', async () => {
    const { api, settings: fixture } = executor()
    const settings = { ...fixture, primary: { ...fixture.primary, connections: [source] } }
    let persisted = settings
    api.personalGet.mockImplementation(async () => persisted)
    type Draft = typeof settings & {
      primary: { delegation: { action: 'resume' | 'pause' } }
    }
    const personalSave = vi.fn(async (_userId: number, draft: PersonalStandInSettings) => {
      const { action, ...delegation } = (draft as Draft).primary.delegation
      persisted = {
        ...persisted,
        version: persisted.version + 1,
        primary: {
          ...persisted.primary,
          delegation: {
            ...delegation,
            version: delegation.version + 1,
            paused: action === 'pause',
          },
        },
      }
      return persisted
    })
    const center = createDingTalkMessageCenterApi({ ...api, personalSave })
    const paused = await center.read(scope)
    expect(paused.capabilities).toContain('resume')
    expect(paused.capabilities).not.toContain('pause')

    const expected = { identityId: paused.identity!.id, policyVersion: 7 }
    const resumed = await center.apply(scope, expected, { type: 'resume' })
    expect(resumed).toMatchObject({ status: 'active', policyVersion: 8 })
    expect(resumed.capabilities).toContain('pause')
    expect(personalSave).toHaveBeenCalledExactlyOnceWith(
      scope.userId,
      {
        ...settings,
        primary: {
          ...settings.primary,
          delegation: { ...settings.primary.delegation, action: 'resume' },
        },
      },
      scope.deviceId
    )
    await expect(center.apply(scope, expected, { type: 'pause' })).rejects.toThrow('changed')
    expect(personalSave).toHaveBeenCalledTimes(1)

    const pausedAgain = await center.apply(
      scope,
      { ...expected, policyVersion: 8 },
      { type: 'pause' }
    )
    expect(pausedAgain).toMatchObject({ status: 'paused', policyVersion: 9 })
    expect(pausedAgain.capabilities).toContain('resume')
    expect(personalSave).toHaveBeenLastCalledWith(
      scope.userId,
      expect.objectContaining({
        version: settings.version + 1,
        primary: expect.objectContaining({
          delegation: expect.objectContaining({ ...account, action: 'pause' }),
        }),
      }),
      scope.deviceId
    )
  })

  it('hides resume without a live scoped source and rejects settings changed during verification', async () => {
    const { api, settings } = executor()
    const personalSave = vi.fn()
    const center = createDingTalkMessageCenterApi({ ...api, personalSave })
    const snapshot = await center.read(scope)
    api.personalGet
      .mockResolvedValueOnce(settings)
      .mockResolvedValueOnce({ ...settings, version: settings.version + 1 })
    await expect(
      center.apply(
        scope,
        { identityId: snapshot.identity!.id, policyVersion: 7 },
        { type: 'resume' }
      )
    ).rejects.toThrow('no longer available')
    expect(personalSave).not.toHaveBeenCalled()

    api.personalGet.mockResolvedValue({
      ...settings,
      primary: { ...settings.primary, connections: [staleSource] },
    })
    expect((await center.read(scope)).capabilities).not.toContain('resume')
  })

  it('keeps readable records and exposes a sync gap when one work detail fails', async () => {
    const { api } = executor()
    const readable = {
      ...grouped,
      id: 'readable-work',
      messageCount: 1,
      latestMessage: message,
    }
    const broken = {
      ...grouped,
      id: 'broken-work',
      delegationResult: { ...decision, recordId: 'broken-message' },
    }
    api.inbox.mockResolvedValueOnce({ items: [readable, broken], sourceErrors: [] })
    api.workMessages.mockImplementation(async (_userId, _deviceId, workId) => {
      if (workId === 'broken-work') throw new Error('Detail read failed')
      return { messages: [] }
    })

    const snapshot = await createDingTalkMessageCenterApi(api).read(scope)

    expect(snapshot.records).toHaveLength(1)
    expect(snapshot.records[0]).toMatchObject({ id: message.recordId, delivery: 'unknown' })
    expect(snapshot.syncGap).toBe('1 DingTalk work detail could not be synchronized.')
  })

  it('projects failed work and technical failures as exceptions, not business handoffs', async () => {
    const { api } = executor()
    const failedMessage = {
      ...message,
      id: 'failed-source',
      recordId: 'failed-message',
      text: 'This input failed before a decision was made.',
    }
    const technicalMessage = {
      ...message,
      id: 'technical-source',
      recordId: 'technical-message',
      text: 'This reply could not be prepared.',
    }
    const technicalResult = {
      ...decision,
      recordId: technicalMessage.recordId,
      action: 'needs_user' as const,
      status: 'failed' as const,
      reason: 'The reply transport is unavailable.',
      reasonCode: 'channel_prepare_failed',
      text: undefined,
      channelTaskId: undefined,
      attemptId: undefined,
      submittedAt: undefined,
      deliveryReason: undefined,
    }
    api.inbox.mockResolvedValueOnce({
      items: [
        {
          ...grouped,
          id: 'failed-work',
          status: 'failed' as const,
          messageCount: 1,
          latestMessage: failedMessage,
          delegationResult: undefined,
          error: 'The executor stopped before producing a decision.',
        },
        {
          ...grouped,
          id: 'technical-work',
          messageCount: 1,
          latestMessage: technicalMessage,
          delegationResult: technicalResult,
        },
      ],
      sourceErrors: [],
    })

    const snapshot = await createDingTalkMessageCenterApi(api).read(scope)

    expect(snapshot.records).toMatchObject([
      {
        id: failedMessage.recordId,
        decision: null,
        delivery: 'failed',
        progress: 'complete',
        reason: 'The executor stopped before producing a decision.',
      },
      {
        id: technicalMessage.recordId,
        decision: 'needs_user',
        delivery: 'failed',
        reason: 'The reply transport is unavailable.',
      },
    ])
  })

  it('shows one latest pending record for a grouped work without per-message outcomes', async () => {
    const { api } = executor()
    const older = { ...message, id: 'older-source', recordId: 'older-pending' }
    const newer = {
      ...message,
      id: 'newer-source',
      recordId: 'newer-pending',
      text: 'The newest pending message',
      at: '2026-01-01T00:03:00Z',
    }
    api.inbox.mockResolvedValueOnce({
      items: [
        {
          ...grouped,
          id: 'pending-work',
          status: 'pending' as const,
          latestMessage: newer,
          delegationResult: undefined,
        },
      ],
      sourceErrors: [],
    })
    api.workMessages.mockResolvedValueOnce({ messages: [older, newer] })

    const snapshot = await createDingTalkMessageCenterApi(api).read(scope)

    expect(snapshot.records).toHaveLength(1)
    expect(snapshot.records[0]).toMatchObject({
      id: newer.recordId,
      message: newer.text,
      progress: 'queued',
      delivery: 'none',
    })
  })

  it('requires a Codex runtime and exposes component failures separately', async () => {
    const { api, settings } = executor()
    api.inbox.mockResolvedValue({ items: [], sourceErrors: [] })
    api.personalGet.mockResolvedValue({
      ...settings,
      primary: {
        ...settings.primary,
        model: { ...settings.primary.model, runtime: 'chat' } as typeof settings.primary.model,
        delegation: { ...settings.primary.delegation, paused: false },
      },
    })
    await expect(createDingTalkMessageCenterApi(api).read(scope)).resolves.toMatchObject({
      status: 'model_unavailable',
    })

    const component = executor()
    component.api.connectionReadiness.mockResolvedValueOnce({
      status: 'error',
      code: 'connection_cli_unavailable',
    })
    await expect(createDingTalkMessageCenterApi(component.api).read(scope)).resolves.toMatchObject({
      status: 'component_unavailable',
      capabilities: ['refresh'],
    })
    expect(component.api.inbox).not.toHaveBeenCalled()
  })
})
