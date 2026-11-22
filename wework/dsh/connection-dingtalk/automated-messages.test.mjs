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

test('attributed history reads both sides of the exact peer without promoting automated or unknown senders to demonstrations', async () => {
  const end = Date.now() - 1000
  const start = end - 60000
  const iso = value => new Date(value).toISOString()
  const source = {
    providerId: '@wegent/dsh-connection-dingtalk/dingtalk',
    profile: 'account',
    kind: 'direct',
    id: 'peer',
  }
  const query = { since: iso(start), trainingUntil: iso(end), limit: 10 }
  let pages = 0
  const ctx = {
    cli: {
      async callTool(_alias, input) {
        switch (input.tool) {
          case 'listProfiles':
            return { profiles: [{ profile: 'account', userName: 'Me', userId: 'me' }] }
          case 'searchUsers':
            return { result: [{ userId: 'me', openDingTalkId: 'own' }] }
          case 'listDirectConversation':
            assert.equal(input.arguments.peer, 'peer')
            return {
              contractVersion: 'im.message-list.v1',
              messages: [{ conversationId: 'chat' }],
              hasMore: false,
              paginationKnown: true,
              failedCount: 0,
            }
          case 'searchMessages': {
            assert.equal(input.arguments.conversationIds, 'chat')
            assert.equal(input.arguments.senderIds, undefined)
            const rows = [
              message('peer', { senderOpenDingTalkId: 'peer', sendType: 'user' }),
              message('owner', { senderOpenDingTalkId: 'own', sendType: 'user' }),
              message('ai', {
                senderOpenDingTalkId: 'own',
                sendType: 'user',
                messageAiSendFlag: 'DWS',
              }),
              message('bot', { senderOpenDingTalkId: 'peer', sendType: 'robot' }),
              message('legacy', { senderOpenDingTalkId: 'own' }),
            ].map(row => ({ ...row, createTime: iso(start + 10) }))
            const result = page(rows)
            pages++
            if (pages === 1) {
              result.result.hasMore = true
              result.result.nextCursor = 'page-two'
            } else {
              assert.equal(input.arguments.cursor, 'page-two')
              result.result.conversationMessagesList[0].openConversationId = 'unrelated'
            }
            return result
          }
          default:
            assert.fail('History issued a non-read operation: ' + input.tool)
        }
      },
    },
  }
  const provider = createProvider()
  const first = await provider.readSource(ctx, { source, query })
  assert.equal(first.reviewCoverage, 'complete')
  assert.ok(first.items.every(row => row.isSelfConversation === false))
  assert.deepEqual(
    first.items.map(row => row.author),
    ['participant', 'owner', 'accountAutomation', 'unknown', 'unknown']
  )
  assert.deepEqual(
    first.items.map(row => row.participantId),
    ['peer', undefined, undefined, undefined, undefined]
  )
  await assert.rejects(
    provider.readSource(ctx, {
      source,
      query: { ...query, trainingUntil: iso(end - 500) },
      cursor: first.nextCursor,
    }),
    { code: 'source_read_cursor_invalid' }
  )
  await assert.rejects(provider.readSource(ctx, { source, query, cursor: first.nextCursor }), {
    code: 'dingtalk_response_invalid',
  })
})

test('a mentions-only training grant uses only the native scoped mention read', async () => {
  const source = {
    providerId: '@wegent/dsh-connection-dingtalk/dingtalk',
    kind: 'group',
    id: 'chat',
    profile: 'account',
  }
  const end = Date.now() - 1000
  const ctx = {
    cli: {
      async callTool(_alias, { tool, arguments: args }) {
        if (tool === 'listProfiles')
          return { profiles: [{ profile: 'account', userName: 'Me', userId: 'me' }] }
        if (tool === 'searchUsers') return { result: [{ userId: 'me', openDingTalkId: 'own' }] }
        assert.equal(tool, 'listMentions')
        assert.equal(args.group, 'chat')
        return page(
          [
            message('mention', {
              sendType: 'user',
              createTime: new Date(end - 1000).toISOString(),
            }),
          ],
          false
        )
      },
    },
  }
  const answer = await createProvider().readSource(ctx, {
    source,
    query: {
      since: new Date(end - 60000).toISOString(),
      trainingUntil: new Date(end).toISOString(),
    },
  })
  assert.deepEqual(
    answer.items.map(row => row.id),
    ['mention']
  )
  assert.equal(answer.items[0].isSelfConversation, false)
  assert.equal(answer.reviewCoverage, 'partial')
})
