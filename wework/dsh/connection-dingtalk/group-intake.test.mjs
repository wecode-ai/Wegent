import assert from 'node:assert/strict'
import test from 'node:test'
import { satisfies } from 'semver'
import { ConnectionRegistry } from '../plugin-runtime/connections.js'
import { connectionTools } from '../plugin-runtime/connection-tools.js'
import { createProvider } from './provider.js'

const source = {
  providerId: '@wegent/dsh-connection-dingtalk/dingtalk',
  profile: 'account',
  kind: 'group',
  id: 'feedback',
  collectionKey: 'all-messages',
  enabledAfter: '2026-11-13T00:00:00Z',
}
const message = (id, sender = 'other', patch = {}) => ({
  openMessageId: id,
  senderOpenDingTalkId: sender,
  content: 'A question without a mention',
  createTime: '2026-11-13T00:01:00Z',
  ...patch,
})
const conversation = (id, messages, singleChat = false) => ({
  openConversationId: id,
  singleChat,
  messages,
})
function fixture() {
  const calls = []
  const state = { hasMore: true, nextCursor: 'next', failure: null }
  const ctx = {
    cli: {
      async callTool(_alias, input) {
        calls.push(input)
        if (input.tool === 'listProfiles')
          return { profiles: [{ profile: 'account', userName: 'Me', userId: 'me' }] }
        if (input.tool === 'searchUsers')
          return { result: [{ userId: 'me', openDingTalkId: 'own' }] }
        if (state.failure) throw state.failure
        return {
          result: {
            hasMore: state.hasMore,
            nextCursor: state.nextCursor,
            conversationMessagesList: [
              conversation('feedback', [
                message('question'),
                message('manual', 'own', { sendType: 'user' }),
                message('automated', 'own', { sendType: 'user', messageAiSendFlag: 'DWS' }),
                message('notification', 'wegent-bot', { sendType: 'robot' }),
                message('other-ai', 'other', { sendType: 'user', messageAiSendFlag: 'DWS' }),
              ]),
              conversation('unselected', [message('foreign')]),
              conversation('feedback', [message('direct')], true),
            ],
          },
        }
      },
    },
  }
  return { calls, state, ctx }
}

test('all-message intake searches only the selected group with the existing window and cursor', async () => {
  const { calls, state, ctx } = fixture()
  const provider = createProvider()
  const checkpoint = { after: source.enabledAfter, until: '2026-11-13T00:02:00Z', cursor: '0' }
  const first = await provider.collect(ctx, { source, checkpoint })
  assert.deepEqual(
    first.events.map(row => row.id),
    ['question', 'manual']
  )
  assert.deepEqual(calls.at(-1), {
    tool: 'searchMessages',
    arguments: {
      conversationIds: 'feedback',
      profile: 'account',
      limit: '100',
      start: checkpoint.after,
      end: checkpoint.until,
      cursor: '0',
    },
  })
  assert.deepEqual(first.nextCheckpoint, { ...checkpoint, cursor: 'next' })
  state.hasMore = false
  const last = await provider.collect(ctx, { source, checkpoint: first.nextCheckpoint })
  assert.equal(calls.at(-1).arguments.cursor, 'next')
  assert.equal(calls.at(-1).arguments.end, checkpoint.until)
  assert.deepEqual(last.nextCheckpoint, { after: checkpoint.until, cursor: '0' })
  state.failure = Object.assign(new Error('Read failed'), { code: 'forbidden' })
  await assert.rejects(provider.collect(ctx, { source, checkpoint }), state.failure)
  assert.equal(checkpoint.cursor, '0')
})

test('default and all-group subscriptions continue to request mentions only', async () => {
  for (const patch of [{}, { id: '*', scope: 'all' }]) {
    const { ctx, calls } = fixture()
    const { collectionKey: _key, ...mentions } = source
    await createProvider().collect(ctx, { source: { ...mentions, ...patch }, checkpoint: null })
    assert.equal(calls.at(-1).tool, 'listMentions')
    assert.equal(calls.at(-1).arguments.conversationIds, undefined)
    assert.equal(calls.at(-1).arguments.group, patch.scope ? undefined : 'feedback')
  }
})

test('all-message mode rejects wildcard, direct and multiple-group scopes before any CLI read', async () => {
  for (const patch of [
    { id: '*', scope: 'all' },
    { kind: 'direct' },
    { id: 'first,second' },
    { id: 'first\nsecond' },
    { collectionKey: 'unknown' },
  ]) {
    const { ctx, calls } = fixture()
    const invalid = { ...source, ...patch }
    const provider = createProvider()
    await assert.rejects(provider.validate(ctx, invalid), { code: 'dingtalk_response_invalid' })
    await assert.rejects(provider.collect(ctx, { source: invalid, checkpoint: null }), {
      code: 'dingtalk_response_invalid',
    })
    assert.equal(calls.length, 0)
  }
})

test('protocol integration collects unmentioned messages through the real registry and declared CLI bridge', async () => {
  const { ctx, calls, state } = fixture()
  state.hasMore = false
  const inventory = async () => [
    {
      marketplaceId: 'wework',
      pluginId: 'dingtalk@wework',
      name: 'dingtalk',
      installed: true,
      enabled: true,
      version: '0.3.4',
    },
  ]
  const registry = new ConnectionRegistry({
    inventory,
    satisfies,
    context: value =>
      connectionTools(
        value,
        { inventory },
        async (_method, params) => ctx.cli.callTool('dingtalk', params),
        satisfies
      ),
  })
  const dispose = await registry.register(
    { effect() {} },
    new URL('./package.json', import.meta.url),
    { dingtalk: createProvider() }
  )
  try {
    const result = await registry.call(source.providerId, 'collect', { source })
    assert.deepEqual(
      result.events.map(row => row.id),
      ['question', 'manual']
    )
    assert.equal(result.hasMore, false)
    assert.equal(calls.at(-1).arguments.conversationIds, 'feedback')
    assert.equal(calls.at(-1).arguments.start, source.enabledAfter)
    const before = calls.length
    await assert.rejects(
      registry.call(source.providerId, 'collect', { source: { ...source, id: '*', scope: 'all' } }),
      { code: 'dingtalk_response_invalid' }
    )
    assert.equal(calls.length, before)
  } finally {
    dispose()
  }
})
