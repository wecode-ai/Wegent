import assert from 'node:assert/strict'
import test from 'node:test'
import { satisfies } from 'semver'
import { createProvider } from './provider.js'
import { ConnectionRegistry } from '../plugin-runtime/connections.js'

const identity = { accountId: 'owner', organizationId: 'org', openId: 'owner-open' }
const direct = {
  kind: 'direct',
  id: 'peer-open',
  profile: 'org:owner',
  policy: { autonomousReply: true },
}
const group = { ...direct, kind: 'group', id: 'dialog' }
const iso = value => new Date(value).toISOString()

function message(id, sender, at, fields = {}) {
  return {
    openMessageId: id,
    senderOpenDingTalkId: sender,
    createTime: iso(at),
    msgType: 'text',
    content: id,
    sendType: 'user',
    ...fields,
  }
}

function fixture(source, input, options = {}) {
  const calls = []
  const conversation = rows => ({
    openConversationId: 'dialog',
    singleChat: source.kind === 'direct',
    messages: rows,
  })
  let currentProfile = 'org:owner'
  const responses = {
    describe: () => ({ pluginKey: 'dingtalk', connectorSlug: 'dingtalk' }),
    authStatus: () => ({ authenticated: true }),
    listProfiles: () => ({
      currentProfile,
      profiles: [{ profile: 'org:owner', corpId: 'org', userId: 'owner', userName: 'Owner' }],
    }),
    searchUsers: () => ({ result: [{ userId: 'owner', openDingTalkId: 'owner-open' }] }),
    listConversation: () => ({
      contractVersion: 'im.message-list.v1',
      paginationKnown: true,
      hasMore: false,
      failedCount: 0,
      messages: input.map(row => ({
        messageId: row.openMessageId,
        senderId: row.senderOpenDingTalkId,
        conversationId: 'dialog',
        text: row.content,
        createTime: row.createTime,
      })),
      ...options.native,
    }),
    listMentions: () => ({
      result: { hasMore: false, conversationMessagesList: [conversation(options.mentions ?? [])] },
    }),
    searchMessages: () => ({
      result: { hasMore: false, conversationMessagesList: [conversation(options.search ?? input)] },
    }),
  }
  responses.listDirectConversation = responses.listConversation
  return {
    calls,
    switchAccount: () => (currentProfile = 'org:other'),
    ctx: {
      cli: {
        describe: responses.describe,
        async callTool(dependency, request) {
          assert.equal(dependency, 'dingtalk')
          calls.push(request)
          return responses[request.tool]()
        },
      },
    },
  }
}

test('current canonical profile binds exact replies and a switched account stops reads', async () => {
  const now = Date.now()
  const f = fixture(direct, [message('trigger', 'peer-open', now - 1000)])
  const provider = createProvider()
  assert.deepEqual((await provider.check(f.ctx)).identity, identity)
  assert.deepEqual((await provider.validate(f.ctx, direct)).identity, identity)
  f.switchAccount()
  await assert.rejects(
    provider.inspectConversation(f.ctx, {
      source: { ...direct, replyIdentity: identity },
      conversationId: 'dialog',
      start: iso(now - 3000),
      end: iso(now),
      limit: 50,
    }),
    { code: 'dingtalk_identity_changed' }
  )
  assert.equal(
    f.calls.some(call => call.tool === 'listDirectConversation'),
    false
  )
})

test('current exact direct history verifies owner, DWS replies and media attribution', async () => {
  const now = Date.now()
  const f = fixture(direct, [
    message('media', 'peer-open', now - 1000, { msgType: 'image' }),
    message('assistant', 'owner-open', now - 2000, { messageAiSendFlag: 'DWS' }),
    message('owner', 'owner-open', now - 3000),
    message('trigger', 'peer-open', now - 4000),
  ])
  const result = await createProvider().inspectConversation(f.ctx, {
    source: direct,
    conversationId: 'dialog',
    start: iso(now - 5000),
    end: iso(now),
    limit: 50,
  })
  assert.equal(result.complete, true)
  assert.deepEqual(
    result.events.map(({ id, author, text }) => [id, author, text]),
    [
      ['trigger', 'other', 'trigger'],
      ['owner', 'owner', 'owner'],
      ['assistant', 'assistant', 'assistant'],
      ['media', 'other', null],
    ]
  )
  assert.equal(
    f.calls.find(call => call.tool === 'listDirectConversation').arguments.peer,
    direct.id
  )
  assert.equal(
    f.calls.find(call => call.tool === 'searchMessages').arguments.conversationIds,
    'dialog'
  )
})

test('group inspection renews mentions and history forbids broad autonomous scopes', async () => {
  const now = Date.now()
  const mention = message('mentioned', 'peer-open', now - 2000)
  const f = fixture(group, [message('unmentioned', 'someone', now - 1000), mention], {
    mentions: [mention],
  })
  const provider = createProvider()
  const input = { source: group, start: iso(now - 3000), end: iso(now) }
  const result = await provider.inspectConversation(f.ctx, input)
  assert.deepEqual(
    result.events.map(event => [event.id, event.mentionedSelf]),
    [
      ['mentioned', true],
      ['unmentioned', false],
    ]
  )
  await assert.rejects(
    provider.validate(f.ctx, { ...group, collectionKey: 'all-messages' }),
    /exact direct conversation/
  )
  await assert.rejects(
    provider.validate(f.ctx, { ...group, id: '*', scope: 'all' }),
    /exact direct conversation/
  )
})

test('recovery fixes a window and counts owner events before selecting latest fifty messages', async () => {
  const now = Date.now()
  const events = Array.from({ length: 51 }, (_, index) =>
    message(String(index), index === 10 ? 'owner-open' : 'peer-open', now - (index + 1) * 1000)
  )
  const f = fixture(direct, events, { native: { hasMore: true } })
  const after = iso(now - 31 * 60_000)
  const page = await createProvider().collect(f.ctx, {
    source: { ...direct, enabledAfter: after, replyIdentity: identity },
    checkpoint: { after, cursor: '0', identity },
  })
  assert.equal(page.gap.code, 'event_limit')
  assert.equal(page.nextCheckpoint.after, page.recovery.end)
  assert.equal(Date.parse(page.recovery.end) - Date.parse(page.recovery.start), 30 * 60_000)
  assert.deepEqual(
    page.events.map(event => Number(event.id)),
    Array.from({ length: 50 }, (_, index) => 49 - index).filter(index => index !== 10)
  )
})

test('missing pagination or missing source attribution is an explicit gap', async () => {
  const now = Date.now()
  for (const [options, code] of [
    [{ native: { paginationKnown: false } }, 'history_coverage_unverified'],
    [{ search: [] }, 'history_attribution_unverified'],
  ]) {
    const f = fixture(direct, [message('trigger', 'peer-open', now - 1000)], options)
    const result = await createProvider().inspectConversation(f.ctx, {
      source: direct,
      conversationId: 'dialog',
      start: iso(now - 2000),
      end: iso(now),
    })
    assert.equal(result.complete, false)
    assert.equal(result.gap.code, code)
    assert.deepEqual(result.events, [])
  }
})

test('the registered reply inspection rejects cross-provider resources and publishes verified account identity', async () => {
  const now = Date.now()
  const f = fixture(direct, [message('trigger', 'peer-open', now - 1000)])
  const registry = new ConnectionRegistry({
    inventory: async () => [
      {
        marketplaceId: 'wegent',
        pluginId: 'dingtalk@wegent',
        installed: true,
        enabled: true,
        version: '0.2.4',
      },
    ],
    context: context => ({ ...context, ...f.ctx }),
    satisfies,
  })
  await registry.register({ effect() {} }, new URL('./package.json', import.meta.url), {
    dingtalk: createProvider(),
  })
  try {
    const [provider] = await registry.catalog()
    assert.deepEqual(provider.availability.identity, identity)
    const window = { start: iso(now - 2000), end: iso(now), conversationId: 'dialog' }
    await assert.rejects(
      registry.call(provider.id, 'inspectConversation', {
        ...window,
        source: { ...direct, providerId: 'another' },
      }),
      /Source belongs to another provider/
    )
    assert.equal(
      f.calls.some(call => call.tool === 'listDirectConversation'),
      false
    )
    const result = await registry.call(provider.id, 'inspectConversation', {
      ...window,
      source: { ...direct, providerId: provider.id },
    })
    assert.equal(result.complete, true)
    assert.equal(result.events[0].id, 'trigger')
  } finally {
    registry.dispose()
  }
})
