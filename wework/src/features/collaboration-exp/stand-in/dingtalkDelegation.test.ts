import { STAND_IN_DINGTALK_PROVIDER, type StandInSourceConnection } from '@/api/personalStandIn'
import { describe, expect, it } from 'vitest'
import { defaultDingTalkDelegation, dingTalkDelegationModel } from './dingtalkDelegation'

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
    expect(dingTalkDelegationModel(saved, { ...saved, connections: [legacy] }, account).canEnable)
      .toBe(false)
    const selection = dingTalkDelegationModel(saved, { ...saved, connections: [chat] }, account)
    expect(selection.canEnable).toBe(true)
    expect(selection.submission().connections).toEqual([])
    expect(selection.submission(true)).toMatchObject({
      enabled: true,
      delegation: { action: 'enable', templates: { document: true, schedule: true, process: true } },
      connections: [{ id: chat.id, policy: { automatic: true, askBeforeAct: false } }],
    })
  })

  it('keeps a paused delegation while saving changes to sources and one category', () => {
    const previous = {
      ...saved,
      connections: [chat],
      delegation: { ...defaultDingTalkDelegation, ...account, version: 2, authorized: true, paused: true },
    }
    const draft = {
      ...previous,
      connections: [{ ...chat, id: 'new-team' }],
      delegation: {
        ...previous.delegation,
        templates: { ...previous.delegation.templates, document: false },
      },
    }
    const change = dingTalkDelegationModel(previous, draft, account)
    expect(change).toMatchObject({ authorized: true, widens: true, narrows: true })
    expect(change.submission().delegation).toMatchObject({
      paused: true,
      templates: { document: false, schedule: true, process: true },
    })
  })

  it('requires a new grant when the active account changes under the same profile', () => {
    const other = { ...account, accountId: 'other' }
    const previous = {
      ...saved,
      connections: [chat],
      delegation: { ...defaultDingTalkDelegation, ...account, version: 3, authorized: true },
    }
    expect(dingTalkDelegationModel(previous, previous, other))
      .toMatchObject({ authorized: false, reconfirm: true, canEnable: false })
    const replacement = { ...previous, connections: [{ ...chat, accountId: other.accountId }] }
    const change = dingTalkDelegationModel(previous, replacement, other)
    expect(change.submission().connections).toEqual([chat])
    expect(change.submission(true).connections?.map(row => row.accountId)).toEqual(['other'])
  })
})
