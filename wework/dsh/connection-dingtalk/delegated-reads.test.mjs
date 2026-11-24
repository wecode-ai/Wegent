import assert from 'node:assert/strict'
import test from 'node:test'
import { ConnectionRegistry } from '../plugin-runtime/connections.js'
import { createProvider } from './provider.js'

const providerId = '@wegent/dsh-connection-dingtalk/dingtalk'
const profile = 'account'
const enabledAfter = '2026-11-24T00:00:00Z'
const at = '2026-11-24T00:10:00+00:00'
const clock = '2026-11-24T00:11:00Z'

function message(id, createTime = at, fields = {}) {
  return {
    openMessageId: id,
    senderOpenDingTalkId: 'peer',
    createTime,
    content: 'Where is the release guide?',
    sendType: 'user',
    ...fields,
  }
}

function conversation(openConversationId, messages, singleChat = false) {
  return { openConversationId, singleChat, messages }
}

function searchResult(...conversationMessagesList) {
  return { result: { conversationMessagesList, hasMore: false, nextCursor: '0' } }
}

function fixture() {
  const calls = []
  const state = {
    userId: 'owner',
    orgId: 'organization',
    mentions: searchResult(conversation('group', [message('ask')])),
    search: searchResult(
      conversation('group', [
        message('evidence', '2026-11-24T00:08:00Z', {
          content: 'Release guide: https://example.org/guide',
        }),
        message('ask'),
      ]),
      conversation('other', [message('out-of-scope')])
    ),
  }
  const ctx = {
    cli: {
      describe: async () => ({ pluginKey: 'dingtalk', connectorSlug: 'local' }),
      async callTool(_alias, input) {
        calls.push(input)
        if (input.tool === 'authStatus') return { authenticated: true }
        if (input.tool === 'listProfiles')
          return {
            currentProfile: profile,
            profiles: [
              {
                profile,
                userId: state.userId,
                userName: 'Owner',
                orgId: state.orgId,
                orgName: 'Team',
              },
            ],
          }
        if (input.tool === 'searchUsers')
          return { result: [{ userId: state.userId, openDingTalkId: 'self', name: 'Owner' }] }
        if (input.tool === 'listDirectConversation')
          return {
            contractVersion: 'im.message-list.v1',
            messages: [{ conversationId: 'direct' }],
            paginationKnown: true,
            hasMore: false,
            failedCount: 0,
          }
        if (input.tool === 'listMentions') return state.mentions
        if (input.tool === 'searchMessages') return state.search
        assert.fail(`Unexpected DingTalk operation ${input.tool}`)
      },
    },
  }
  return { ctx, calls, state }
}

async function register(ctx) {
  const registry = new ConnectionRegistry({
    inventory: async () => [
      {
        marketplaceId: 'wework',
        pluginId: 'dingtalk@wework',
        installed: true,
        enabled: true,
        version: '0.3.4',
      },
    ],
    satisfies: () => true,
    context: () => ctx,
  })
  const dispose = await registry.register(
    { effect() {} },
    new URL('./package.json', import.meta.url),
    { dingtalk: createProvider() }
  )
  const [{ availability }] = await registry.catalog()
  assert.equal(availability.profile, profile)
  assert.equal(availability.organizationName, 'Team')
  assert.match(availability.accountId, /^[a-f0-9]{64}$/)
  return {
    registry,
    dispose,
    source: {
      providerId,
      profile,
      accountId: availability.accountId,
      kind: 'group',
      id: 'group',
      enabledAfter,
      delegated: true,
    },
  }
}

test('a delegated group only collects mentions and rereads the exact original and same-group evidence', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(clock) })
  const { ctx, calls, state } = fixture()
  const { registry, dispose, source } = await register(ctx)
  try {
    const poll = await registry.call(providerId, 'collect', { source })
    assert.deepEqual(
      poll.events.map(row => row.id),
      ['ask']
    )
    assert.equal(poll.events[0].at, '2026-11-24T00:10:00.000Z')
    assert.equal(poll.events[0].textMessage, true)
    assert.equal(
      calls.some(row => row.tool === 'searchMessages'),
      false
    )

    const query = {
      delegatedMessage: { id: 'ask', at: poll.events[0].at, conversationId: 'group' },
    }
    const snapshot = await registry.call(providerId, 'readSource', { source, query })
    assert.deepEqual(snapshot.target, poll.events[0])
    assert.deepEqual(
      snapshot.messages.map(row => row.id),
      ['evidence']
    )
    assert.equal(snapshot.ownerIntervened, false)
    assert.equal(
      calls.find(row => row.tool === 'searchMessages').arguments.conversationIds,
      'group'
    )

    state.search.result.conversationMessagesList[0].messages.push(
      message('owner-reply', '2026-11-24T00:10:30Z', {
        senderOpenDingTalkId: 'self',
        quotedMessage: { openMessageId: 'ask' },
      })
    )
    assert.equal(
      (await registry.call(providerId, 'readSource', { source, query })).ownerIntervened,
      true
    )

    state.mentions = searchResult(conversation('group', []))
    const historyReads = calls.filter(row => row.tool === 'searchMessages').length
    await assert.rejects(registry.call(providerId, 'readSource', { source, query }), {
      code: 'dingtalk_response_invalid',
    })
    assert.equal(calls.filter(row => row.tool === 'searchMessages').length, historyReads)
  } finally {
    dispose()
  }
})

test('delegated collection rejects a broader group or changed account before reading messages', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(clock) })
  const { ctx, calls, state } = fixture()
  const { registry, dispose, source } = await register(ctx)
  try {
    calls.length = 0
    await assert.rejects(
      registry.call(providerId, 'collect', {
        source: { ...source, collectionKey: 'all-messages' },
      }),
      { code: 'dingtalk_response_invalid' }
    )
    assert.deepEqual(calls, [])

    state.orgId = 'new-organization'
    await assert.rejects(registry.call(providerId, 'collect', { source }), {
      code: 'dingtalk_account_changed',
    })
    assert.deepEqual(
      calls.map(row => row.tool),
      ['listProfiles']
    )
  } finally {
    dispose()
  }
})

test('delegated private intake binds native direct conversation and ignores other chats', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(clock) })
  const { ctx, calls, state } = fixture()
  const { registry, dispose, source } = await register(ctx)
  try {
    state.search = searchResult(
      conversation(
        'direct',
        [message('correct'), message('mine', at, { senderOpenDingTalkId: 'self' })],
        true
      ),
      conversation('other-direct', [message('wrong')], true),
      conversation('group', [message('wrong-group')])
    )
    const result = await registry.call(providerId, 'collect', {
      source: { ...source, kind: 'direct', id: 'peer' },
    })
    assert.deepEqual(
      result.events.map(row => row.id),
      ['correct']
    )
    const native = calls.find(row => row.tool === 'listDirectConversation')
    assert.equal(native.arguments.peer, 'peer')
    const search = calls.find(row => row.tool === 'searchMessages')
    assert.equal(search.arguments.conversationIds, 'direct')
    assert.equal(search.arguments.senderIds, 'peer')
  } finally {
    dispose()
  }
})
