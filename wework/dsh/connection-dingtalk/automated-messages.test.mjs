import assert from 'node:assert/strict'
import test from 'node:test'
import { createProvider, normalizeMessages } from './provider.js'

const message = (id, fields = {}) => ({
  openMessageId: id,
  senderOpenDingTalkId: 'wegent-bot',
  content: '你的任务有新的 AI 回复',
  createTime: '2026-11-01T12:00:00Z',
  ...fields,
})

function page(messages, direct = true) {
  return {
    result: {
      conversationMessagesList: [{ openConversationId: 'chat', singleChat: direct, messages }],
      hasMore: false,
      nextCursor: '0',
    },
  }
}

test('robot notifications and AI-marked messages never become incoming work regardless of sender', () => {
  for (const source of [
    { kind: 'direct', id: '*', scope: 'all' },
    { kind: 'direct', id: 'wegent-bot' },
    { kind: 'group', id: 'chat' },
    { kind: 'group', id: '*', scope: 'all' },
  ]) {
    for (const sender of ['own', 'wegent-bot']) {
      const messages = [
        message('notification', { senderOpenDingTalkId: sender, sendType: 'robot' }),
        ...['DWS', null, ''].map(messageAiSendFlag =>
          message('ai', {
            senderOpenDingTalkId: sender,
            sendType: 'user',
            messageAiSendFlag,
          })
        ),
      ]
      assert.deepEqual(
        normalizeMessages(source, page(messages, source.kind === 'direct'), 'own'),
        [],
        JSON.stringify({ source, sender })
      )
    }
  }
})

test('human requests and forwarded notification text remain actionable', () => {
  const messages = [
    message('manual', { sendType: 'user' }),
    message('legacy'),
    message('quoted', {
      sendType: 'user',
      content: '这条通知是什么意思？',
      quotedMessage: { openMessageId: 'notification' },
    }),
  ]
  for (const kind of ['direct', 'group']) {
    const events = normalizeMessages(
      { kind, id: '*', scope: 'all' },
      page(messages, kind === 'direct'),
      'own'
    )
    assert.deepEqual(
      events.map(event => event.id),
      ['manual', 'legacy', 'quoted']
    )
    assert.equal(events[2].quotedMessageId, 'notification')
  }
})

test('notification-only collection advances its checkpoint and still accepts the next human request', async () => {
  const source = {
    kind: 'direct',
    id: '*',
    scope: 'all',
    profile: 'account',
    enabledAfter: '2026-11-01T00:00:00Z',
  }
  let messages = [
    message('reply', { sendType: 'robot' }),
    message('cancelled', { sendType: 'robot', content: '你的任务已取消' }),
  ]
  const starts = []
  const ctx = {
    cli: {
      async callTool(_alias, input) {
        switch (input.tool) {
          case 'listProfiles':
            return { profiles: [{ profile: 'account', userName: 'Me', userId: 'me' }] }
          case 'searchUsers':
            return { result: [{ userId: 'me', openDingTalkId: 'own' }] }
          case 'searchMessages':
            starts.push(input.arguments.start)
            return page(messages)
          default:
            assert.fail(`Unexpected operation: ${input.tool}`)
        }
      },
    },
  }
  const provider = createProvider()
  const until = '2026-11-02T00:00:00Z'
  const result = await provider.collect(ctx, {
    source,
    checkpoint: { after: source.enabledAfter, until, cursor: '0' },
  })
  assert.deepEqual(result.events, [])
  assert.deepEqual(result.nextCheckpoint, { after: until, cursor: '0' })

  messages = [
    message('human', {
      sendType: 'user',
      content: '请继续分析群聊',
      createTime: '2026-11-02T12:00:00Z',
    }),
  ]
  const next = await provider.collect(ctx, { source, checkpoint: result.nextCheckpoint })
  assert.deepEqual(
    next.events.map(event => event.id),
    ['human']
  )
  assert.deepEqual(starts, [source.enabledAfter, until])
})
