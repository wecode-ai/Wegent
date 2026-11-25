import { STAND_IN_DINGTALK_PROVIDER, type StandInSourceConnection } from '@/api/personalStandIn'
import { describe, expect, it } from 'vitest'
import {
  defaultDingTalkDelegation,
  delegationResultLabel,
  delegationTemplates,
  dingTalkDelegationModel,
} from './dingtalkDelegation'

const account = { status: 'ready', profile: 'profile', accountId: 'owner' }
const chat: StandInSourceConnection = {
  ...account,
  providerId: STAND_IN_DINGTALK_PROVIDER,
  kind: 'group',
  id: 'team',
  name: 'Team',
  policy: { automatic: false, askBeforeAct: true },
}
const saved = { enabled: false, prompt: '', preferences: '' }

describe('DingTalk delegation settings', () => {
  it('requires exact verified selections and separate enable intent', () => {
    const legacy = { ...chat, collectionKey: 'all-messages' }
    expect(
      dingTalkDelegationModel(saved, { ...saved, connections: [legacy] }, account).canEnable
    ).toBe(false)
    const selection = dingTalkDelegationModel(saved, { ...saved, connections: [chat] }, account)
    expect(selection.canEnable).toBe(true)
    expect(selection.submission().connections).toEqual([])
    expect(selection.submission(true)).toMatchObject({
      enabled: true,
      delegation: {
        action: 'enable',
        templates: { document: true, schedule: true, process: true },
      },
      connections: [{ id: chat.id, policy: { automatic: true, askBeforeAct: false } }],
    })
  })

  it.each(delegationTemplates)(
    'keeps a paused delegation while editing sources and disabling only %s',
    category => {
      const previous = {
        ...saved,
        connections: [chat],
        delegation: {
          ...defaultDingTalkDelegation,
          ...account,
          version: 2,
          authorized: true,
          paused: true,
        },
      }
      const draft = {
        ...previous,
        connections: [{ ...chat, id: 'new-team' }],
        delegation: {
          ...previous.delegation,
          templates: { ...previous.delegation.templates, [category]: false },
        },
      }
      const change = dingTalkDelegationModel(previous, draft, account)
      expect(change).toMatchObject({ authorized: true, widens: true, narrows: true })
      expect(change.submission().delegation).toMatchObject({
        paused: true,
        templates: Object.fromEntries(delegationTemplates.map(name => [name, name !== category])),
      })
    }
  )

  it('requires a new grant when the active account changes under the same profile', () => {
    const other = { ...account, accountId: 'other' }
    const previous = {
      ...saved,
      connections: [chat],
      delegation: { ...defaultDingTalkDelegation, ...account, version: 3, authorized: true },
    }
    expect(dingTalkDelegationModel(previous, previous, other)).toMatchObject({
      authorized: false,
      reconfirm: true,
      canEnable: false,
    })
    const replacement = { ...previous, connections: [{ ...chat, accountId: other.accountId }] }
    const change = dingTalkDelegationModel(previous, replacement, other)
    expect(change.submission().connections).toEqual([chat])
    expect(change.submission(true).connections?.map(row => row.accountId)).toEqual(['other'])
  })
})

describe('DingTalk delegation results', () => {
  it.each([
    ['reply', 'submitting', 'standIn.dingtalk_delegation.result_submitting'],
    ['reply', 'sent', 'standIn.dingtalk_delegation.result_unknown'],
    ['reply', 'unknown', 'standIn.dingtalk_delegation.result_unknown'],
    ['reply', 'failed', 'standIn.dingtalk_delegation.result_failed'],
    ['needs_user', 'complete', 'standIn.dingtalk_delegation.result_needs_user'],
    ['skip', 'complete', undefined],
  ] as const)('shows the result for %s / %s', (action, status, label) => {
    expect(delegationResultLabel({ action, status, reason: 'Provider result' })).toBe(label)
  })

  it('reports a confirmed delivery only with a receipt', () => {
    expect(
      delegationResultLabel({
        action: 'reply',
        status: 'sent',
        reason: 'Provider result',
        receiptId: 'channel-receipt',
      })
    ).toBe('standIn.dingtalk_delegation.result_sent')
  })

  it('identifies owner intervention from executor evidence and the legacy stored reason', () => {
    const previous = {
      action: 'skip',
      status: 'complete',
      reason: 'The account owner already responded.',
    } as const
    const label = 'standIn.dingtalk_delegation.result_owner_intervened'
    expect(delegationResultLabel(previous)).toBe(label)
    expect(
      delegationResultLabel({
        ...previous,
        reason: 'Owner activity',
        reasonCode: 'owner_intervened',
      })
    ).toBe(label)
    expect(delegationResultLabel({ ...previous, reasonCode: 'model_skipped' })).toBeUndefined()
  })
})
