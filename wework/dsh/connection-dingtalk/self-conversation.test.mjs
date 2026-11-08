import assert from 'node:assert/strict'
import test from 'node:test'
import { createProvider, normalizeMessages } from './provider.js'

const source = { kind: 'direct', id: 'own', profile: 'account' }
const checkpoint = { after: '2026-11-01T00:00:00Z', until: '2026-11-02T00:00:00Z', cursor: '0' }
const message = (id, fields = {}) => ({
  openMessageId: id,
  senderOpenDingTalkId: 'own',
  sendType: 'user',
  content: '我现在都有啥任务',
  createTime: '2026-11-01T12:00:00Z',
  ...fields,
})
const response = {
  result: {
    conversationMessagesList: [
      {
        openConversationId: 'self-chat',
        singleChat: true,
        messages: [
          message('manual'),
          message('ai', { messageAiSendFlag: 'DWS' }),
          message('unknown', { sendType: undefined }),
          message('automated', { sendType: 'robot' }),
          message('null-marker', { messageAiSendFlag: null }),
          message('empty-marker', { messageAiSendFlag: '' }),
          message('foreign', { senderOpenDingTalkId: 'other' }),
        ],
      },
      {
        openConversationId: 'other-chat',
        singleChat: true,
        messages: [message('outgoing-to-other')],
      },
      { openConversationId: 'group', singleChat: false, messages: [message('group')] },
    ],
    hasMore: false,
    nextCursor: '0',
  },
}

function fixture(overrides = {}) {
  const calls = []
  const page = {
    contractVersion: 'im.message-list.v1',
    messages: [{ conversationId: 'self-chat' }],
    paginationKnown: true,
    hasMore: false,
    failedCount: 0,
    ...overrides,
  }
  const ctx = {
    cli: {
      async callTool(alias, input) {
        assert.equal(alias, 'dingtalk')
        calls.push(input)
        switch (input.tool) {
          case 'listProfiles':
            return { profiles: [{ profile: 'account', userName: 'Me', userId: 'me' }] }
          case 'searchUsers':
            return { result: [{ userId: 'me', openDingTalkId: 'own' }] }
          case 'listDirectConversation':
            return page
          case 'searchMessages':
            return response
          default:
            assert.fail(`Unexpected operation: ${input.tool}`)
        }
      },
    },
  }
  return { ctx, calls }
}

test('collects manual self-chat commands without AI replies or outgoing messages to others', async () => {
  const { ctx, calls } = fixture()
  const result = await createProvider().collect(ctx, { source, checkpoint })
  assert.deepEqual(
    result.events.map(event => event.id),
    ['manual']
  )
  assert.equal(result.events[0].text, '我现在都有啥任务')
  assert.equal(result.events[0].conversationId, 'self-chat')
  assert.deepEqual(calls[2], {
    tool: 'listDirectConversation',
    arguments: { peer: 'own', profile: 'account', time: checkpoint.until, limit: '1' },
  })
  assert.equal(calls[3].arguments.senderIds, 'own')
  assert.equal(calls[3].arguments.profile, 'account')
  assert.deepEqual(result.nextCheckpoint, { after: checkpoint.until, cursor: '0' })
})

test('self messages require an explicit self source and a verified conversation identity', () => {
  assert.deepEqual(normalizeMessages(source, response, 'own'), [])
  assert.deepEqual(normalizeMessages(source, response, 'own', 'unrelated'), [])
  const all = normalizeMessages({ ...source, scope: 'all', id: '*' }, response, 'own', 'self-chat')
  assert.deepEqual(
    all.map(event => event.id),
    ['foreign']
  )
  const other = normalizeMessages({ ...source, id: 'other' }, response, 'own', 'self-chat')
  assert.deepEqual(
    other.map(event => event.id),
    ['foreign']
  )
})

test('invalid self-chat resolution fails before searching or advancing the checkpoint', async () => {
  for (const overrides of [
    { partial: true },
    { failedCount: 1 },
    { paginationKnown: false },
    { contractVersion: 'unknown' },
    { messages: [{}] },
    { messages: [], hasMore: true },
  ]) {
    const { ctx, calls } = fixture(overrides)
    await assert.rejects(createProvider().collect(ctx, { source, checkpoint }), {
      code: 'dingtalk_response_invalid',
    })
    assert.equal(
      calls.some(call => call.tool === 'searchMessages'),
      false
    )
  }
})

test('an empty self-chat has no events and does not search other conversations', async () => {
  const { ctx, calls } = fixture({ messages: [] })
  const result = await createProvider().collect(ctx, { source, checkpoint })
  assert.deepEqual(result.events, [])
  assert.deepEqual(result.nextCheckpoint, { after: checkpoint.until, cursor: '0' })
  assert.equal(
    calls.some(call => call.tool === 'searchMessages'),
    false
  )
})
