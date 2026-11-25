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

function searchPage(nextCursor, ...conversationMessagesList) {
  return { result: { conversationMessagesList, hasMore: true, nextCursor } }
}

function fixture() {
  const calls = []
  const state = {
    currentProfile: profile,
    userId: 'owner',
    selfId: 'self',
    orgId: 'organization',
    tokenOrganization: 'organization',
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
        if (input.tool === 'authStatus')
          return {
            authenticated: true,
            token_valid: true,
            user_id: state.userId,
            corp_id: state.tokenOrganization,
          }
        if (input.tool === 'listProfiles') {
          const response = {
            currentProfile: state.currentProfile,
            profiles: [
              {
                profile: state.currentProfile,
                userId: state.userId,
                userName: 'Owner',
                corpId: state.orgId,
                orgId: state.orgId,
                orgName: 'Team',
              },
            ],
          }
          state.afterProfileRead?.()
          return response
        }
        if (input.tool === 'searchUsers')
          return { result: [{ userId: state.userId, openDingTalkId: state.selfId, name: 'Owner' }] }
        if (input.tool === 'listDirectConversation')
          return {
            contractVersion: 'im.message-list.v1',
            messages: [{ conversationId: 'direct' }],
            paginationKnown: true,
            hasMore: false,
            failedCount: 0,
          }
        if (input.tool === 'listMentions') return state.mentions
        if (input.tool === 'searchMessages') {
          return typeof state.search === 'function' ? state.search(input.arguments) : state.search
        }
        assert.fail(`Unexpected DingTalk operation ${input.tool}`)
      },
    },
  }
  return { ctx, calls, state }
}

async function register(ctx, expectedProfile = profile) {
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
  assert.equal(availability.profile, expectedProfile)
  assert.equal(availability.organizationName, 'Team')
  assert.match(availability.accountId, /^[a-f0-9]{64}$/)
  return {
    registry,
    dispose,
    source: {
      providerId,
      profile: expectedProfile,
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

test('delegated collection accepts a page containing an image without text', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(clock) })
  const { ctx, state } = fixture()
  const { registry, dispose, source } = await register(ctx)
  try {
    state.mentions = searchResult(
      conversation('group', [
        message('image', at, { messageType: 'image', content: {} }),
        message('ask'),
      ])
    )
    const result = await registry.call(providerId, 'collect', { source })
    assert.deepEqual(
      result.events.map(event => [event.id, event.textMessage]),
      [
        ['image', false],
        ['ask', true],
      ]
    )
    assert.deepEqual(result.nextCheckpoint, {
      after: new Date(Date.parse(clock)).toISOString(),
      cursor: '0',
    })
  } finally {
    dispose()
  }
})

test('switching accounts during owner lookup does not change owner recognition on return', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(clock) })
  const { ctx, state } = fixture()
  const { registry, dispose, source } = await register(ctx)
  try {
    state.search.result.conversationMessagesList[0].messages.push(
      message('owner-reply', '2026-11-24T00:10:30Z', {
        senderOpenDingTalkId: 'self',
        quotedMessage: { openMessageId: 'ask' },
      })
    )
    state.afterProfileRead = () => {
      state.afterProfileRead = undefined
      state.userId = 'different-user'
      state.selfId = 'different-self'
    }
    const query = {
      delegatedMessage: { id: 'ask', at, conversationId: 'group' },
    }
    await assert.rejects(registry.call(providerId, 'readSource', { source, query }), {
      code: 'dingtalk_account_changed',
    })
    state.userId = 'owner'
    state.selfId = 'self'
    const snapshot = await registry.call(providerId, 'readSource', { source, query })
    assert.equal(snapshot.ownerIntervened, true)
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

test('delegated recovery skips a window longer than 30 minutes and collects subsequent events', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(clock) })
  const { ctx, calls, state } = fixture()
  const { registry, dispose, source } = await register(ctx)
  try {
    const from = new Date(Date.now() - 30 * 60_000 - 1).toISOString()
    const gap = await registry.call(providerId, 'collect', {
      source,
      checkpoint: { after: from, cursor: '0' },
    })
    assert.deepEqual(gap, {
      events: [],
      hasMore: false,
      nextCheckpoint: {
        after: new Date(Date.parse(clock)).toISOString(),
        cursor: '0',
        delegationGap: {
          reason: 'duration',
          from,
          until: new Date(Date.parse(clock)).toISOString(),
        },
      },
    })
    assert.ok(!calls.some(call => call.tool === 'listMentions'))

    t.mock.timers.tick(2000)
    state.mentions = searchResult(
      conversation('group', [
        message('at-boundary', clock),
        message('new', new Date().toISOString()),
      ])
    )
    const resumed = await registry.call(providerId, 'collect', {
      source,
      checkpoint: gap.nextCheckpoint,
    })
    assert.deepEqual(
      resumed.events.map(event => event.id),
      ['new']
    )
    assert.deepEqual(resumed.nextCheckpoint, { after: new Date().toISOString(), cursor: '0' })
  } finally {
    dispose()
  }
})

test('delegated recovery checks the complete 50-message limit before releasing paged events', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(clock) })
  const { ctx, state } = fixture()
  const { registry, dispose, source } = await register(ctx)
  try {
    const direct = { ...source, kind: 'direct', id: 'peer' }
    const events = Array.from({ length: 50 }, (_, index) => message(`ask-${index}`))
    const ownEvent = message('owner-history', at, { senderOpenDingTalkId: 'self' })
    let overflow = false
    state.search = ({ cursor, limit, conversationIds, senderIds }) => {
      assert.equal(limit, '51')
      assert.equal(conversationIds, 'direct')
      assert.equal(senderIds, undefined, 'The source-event limit must include the owner')
      if (cursor === '0')
        return searchPage('second', conversation('direct', events.slice(0, 25), true))
      assert.equal(cursor, 'second')
      const finalPage = events.slice(24)
      if (overflow) finalPage.push(ownEvent)
      return searchResult(conversation('direct', finalPage, true))
    }
    const checkpoint = { after: new Date(Date.now() - 30 * 60_000).toISOString(), cursor: '0' }
    const accepted = await registry.call(providerId, 'collect', { source: direct, checkpoint })
    assert.equal(accepted.events.length, 50)
    assert.equal(accepted.nextCheckpoint.delegationGap, undefined)

    overflow = true
    const gap = await registry.call(providerId, 'collect', { source: direct, checkpoint })
    assert.deepEqual(gap.events, [])
    assert.equal(gap.hasMore, false)
    assert.deepEqual(gap.nextCheckpoint.delegationGap, {
      reason: 'volume',
      from: checkpoint.after,
      until: new Date(Date.parse(clock)).toISOString(),
    })
  } finally {
    dispose()
  }
})

test('short group recovery keeps the fixed window and only releases verified mentions', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(clock) })
  const { ctx, calls, state } = fixture()
  const { registry, dispose, source } = await register(ctx)
  try {
    const after = '2026-11-24T00:09:00.000Z'
    const until = new Date(Date.parse(clock)).toISOString()
    const owner = message('owner', '2026-11-24T00:10:30Z', { senderOpenDingTalkId: 'self' })
    const later = message('outside-fixed-window', '2026-11-24T00:11:02Z')
    const ask = message('ask')
    const rawPage = searchPage('later', conversation('group', [ask, message('nonmention')]))
    state.search = ({ cursor, start, end }) => {
      assert.equal(start, after)
      assert.equal(end, until)
      if (cursor === '0') {
        t.mock.timers.tick(4000)
        return rawPage
      }
      return searchResult(conversation('group', [owner, later]))
    }
    state.mentions = searchResult(conversation('group', [ask, owner, later]))
    const result = await registry.call(providerId, 'collect', {
      source,
      checkpoint: { after, cursor: '0', recover: true },
    })
    assert.equal(result.nextCheckpoint.after, until)
    assert.deepEqual(
      result.events.map(row => row.id),
      ['ask']
    )
    assert.equal(calls.find(row => row.tool === 'listMentions').arguments.end, until)
  } finally {
    dispose()
  }
})

test('the group recovery volume cap counts events that cannot receive replies', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(clock) })
  const { ctx, calls, state } = fixture()
  const { registry, dispose, source } = await register(ctx)
  try {
    const ask = message('ask')
    const ineligible = [
      message('manual-owner', at, { senderOpenDingTalkId: 'self' }),
      message('automated-bot', at, { sendType: 'robot' }),
      message('ai-reply', at, { messageAiSendFlag: 1 }),
      message('recalled', at, { recalled: true }),
      message('file', at, { messageType: 'file' }),
      ...Array.from({ length: 44 }, (_, index) => message(`without-mention-${index}`)),
    ]
    const checkpoint = { after: '2026-11-24T00:09:00.000Z', cursor: '0', recover: true }
    state.search = searchResult(conversation('group', [ask, ...ineligible]))
    state.mentions = searchResult(conversation('group', [ask, ...ineligible.slice(0, 5)]))
    const accepted = await registry.call(providerId, 'collect', { source, checkpoint })
    assert.deepEqual(
      accepted.events.map(row => row.id),
      ['ask']
    )
    assert.equal(accepted.nextCheckpoint.delegationGap, undefined)

    calls.length = 0
    state.search.result.conversationMessagesList[0].messages.push(message('one-more-nonmention'))
    const skipped = await registry.call(providerId, 'collect', { source, checkpoint })
    assert.deepEqual(skipped.events, [])
    assert.deepEqual(skipped.nextCheckpoint.delegationGap, {
      reason: 'volume',
      from: checkpoint.after,
      until: new Date(Date.parse(clock)).toISOString(),
    })
    assert.ok(!calls.some(call => call.tool === 'listMentions'))
  } finally {
    dispose()
  }
})

test('short recovery records a coverage gap without releasing a partial page', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(clock) })
  const { ctx, state } = fixture()
  const { registry, dispose, source } = await register(ctx)
  try {
    const after = '2026-11-24T00:09:00.000Z'
    const until = new Date(Date.parse(clock)).toISOString()
    state.search = () => searchPage('repeating-cursor', conversation('group', [message('ask')]))
    const result = await registry.call(providerId, 'collect', {
      source,
      checkpoint: { after, cursor: '0', recover: true },
    })
    assert.deepEqual(result, {
      events: [],
      hasMore: false,
      nextCheckpoint: {
        after: until,
        cursor: '0',
        delegationGap: { reason: 'coverage', from: after, until },
      },
    })
  } finally {
    dispose()
  }
})

test('a changed recovered mention skips the entire window and subsequent live collection resumes', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(clock) })
  const { ctx, state } = fixture()
  const { registry, dispose, source } = await register(ctx)
  try {
    const checkpoint = { after: '2026-11-24T00:09:00.000Z', cursor: '0', recover: true }
    const unchanged = message('a-unchanged')
    const edited = message('b-edited')
    state.search = searchResult(conversation('group', [unchanged, edited]))
    state.mentions = searchResult(
      conversation('group', [unchanged, { ...edited, content: 'The question has changed' }])
    )
    const gap = await registry.call(providerId, 'collect', { source, checkpoint })
    const until = new Date(Date.parse(clock)).toISOString()
    assert.deepEqual(gap, {
      events: [],
      hasMore: false,
      nextCheckpoint: {
        after: until,
        cursor: '0',
        delegationGap: { reason: 'coverage', from: checkpoint.after, until },
      },
    })

    t.mock.timers.tick(2000)
    state.mentions = searchResult(
      conversation('group', [edited, message('new', new Date().toISOString())])
    )
    const live = await registry.call(providerId, 'collect', {
      source,
      checkpoint: gap.nextCheckpoint,
    })
    assert.deepEqual(
      live.events.map(row => row.id),
      ['new']
    )
    assert.deepEqual(live.nextCheckpoint, { after: new Date().toISOString(), cursor: '0' })
  } finally {
    dispose()
  }
})

test('recovery cannot release a selected organization window if its token changes mid-read', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(clock) })
  const { ctx, state, calls } = fixture()
  state.currentProfile = `${state.orgId}:${state.userId}`
  const { registry, dispose, source } = await register(ctx, state.currentProfile)
  try {
    const ask = message('ask')
    const input = {
      source: { ...source, organizationId: state.orgId },
      checkpoint: { after: '2026-11-24T00:09:00.000Z', cursor: '0', recover: true },
    }
    state.search = searchResult(conversation('group', [ask]))
    const intact = await registry.call(providerId, 'collect', input)
    assert.deepEqual(
      intact.events.map(row => row.id),
      ['ask']
    )

    calls.length = 0
    state.search = args => {
      assert.equal(args.profile, state.currentProfile)
      state.tokenOrganization = 'different-organization'
      return searchResult(conversation('group', [ask]))
    }
    await assert.rejects(registry.call(providerId, 'collect', input), {
      code: 'dingtalk_account_changed',
    })
    for (const { arguments: args } of calls.filter(call => call.tool === 'authStatus')) {
      assert.equal(args.profile, state.currentProfile)
    }
  } finally {
    dispose()
  }
})

test('delegated private history detects the owner taking over even on a later search page', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(clock) })
  const { ctx, calls, state } = fixture()
  const { registry, dispose, source } = await register(ctx)
  try {
    state.search = ({ cursor }) => {
      if (cursor === '0') {
        return searchPage(
          'page-two',
          conversation(
            'direct',
            [message('evidence', '2026-11-24T00:08:00Z'), message('ask')],
            true
          )
        )
      }
      assert.equal(cursor, 'page-two')
      return searchResult(
        conversation(
          'direct',
          [
            message('clarification', '2026-11-24T00:10:10Z'),
            message('owner-response', '2026-11-24T00:10:30Z', { senderOpenDingTalkId: 'self' }),
          ],
          true
        )
      )
    }

    const snapshot = await registry.call(providerId, 'readSource', {
      source: { ...source, kind: 'direct', id: 'peer' },
      query: { delegatedMessage: { id: 'ask', at, conversationId: 'direct' } },
    })

    assert.equal(snapshot.target.id, 'ask')
    assert.equal(snapshot.ownerIntervened, true)
    assert.deepEqual(
      snapshot.messages.map(row => row.id),
      ['evidence']
    )
    assert.deepEqual(
      snapshot.laterMessages.map(row => row.id),
      ['clarification']
    )
    assert.deepEqual(
      calls
        .filter(row => row.tool === 'searchMessages')
        .map(({ arguments: args }) => ({
          cursor: args.cursor,
          conversationIds: args.conversationIds,
          senderIds: args.senderIds,
        })),
      ['0', 'page-two', '0', 'page-two'].map(cursor => ({
        cursor,
        conversationIds: 'direct',
        senderIds: 'peer,self',
      }))
    )
  } finally {
    dispose()
  }
})

test('bounded older group history does not block a verified automatic message', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(clock) })
  const { ctx, calls, state } = fixture()
  const { registry, dispose, source } = await register(ctx)
  try {
    const questionStart = new Date(at).toISOString()
    state.search = ({ cursor, start }) => {
      if (start === questionStart) return searchResult(conversation('group', [message('ask')]))
      const history = {
        0: ['history-1', '2026-11-24T00:01:00Z', 'history-2'],
        'history-2': ['history-2', '2026-11-24T00:02:00Z', 'history-3'],
        'history-3': ['history-3', '2026-11-24T00:03:00Z', 'history-more'],
      }[cursor]
      assert.ok(history, `Unexpected history cursor ${cursor}`)
      return searchPage(history[2], conversation('group', [message(history[0], history[1])]))
    }

    const snapshot = await registry.call(providerId, 'readSource', {
      source,
      query: { delegatedMessage: { id: 'ask', at, conversationId: 'group' } },
    })

    assert.equal(snapshot.target.id, 'ask')
    assert.equal(snapshot.ownerIntervened, false)
    assert.deepEqual(
      snapshot.messages.map(row => row.id),
      ['history-1', 'history-2', 'history-3']
    )
    assert.deepEqual(
      calls.filter(row => row.tool === 'searchMessages').map(row => row.arguments.cursor),
      ['0', 'history-2', 'history-3', '0']
    )
  } finally {
    dispose()
  }
})

test('delegated history refuses context that changes or cannot finish during pagination', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(clock) })
  const { ctx, state } = fixture()
  const { registry, dispose, source } = await register(ctx)
  try {
    const firstPage = searchPage('page-two', conversation('group', [message('ask')]))
    const input = {
      source,
      query: { delegatedMessage: { id: 'ask', at, conversationId: 'group' } },
    }

    state.search = ({ cursor }) =>
      cursor === '0'
        ? firstPage
        : searchResult(conversation('group', [message('ask', at, { content: 'Changed question' })]))
    await assert.rejects(registry.call(providerId, 'readSource', input), {
      code: 'dingtalk_response_invalid',
      message: 'DingTalk context changed during pagination',
    })

    state.search = () => firstPage
    await assert.rejects(registry.call(providerId, 'readSource', input), {
      code: 'dingtalk_response_invalid',
      message: 'Incomplete DingTalk context pagination',
    })
  } finally {
    dispose()
  }
})

test('a recalled direct message cannot be revalidated for delegation', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(clock) })
  const { ctx, state } = fixture()
  const { registry, dispose, source } = await register(ctx)
  try {
    const original = message('ask')
    state.search = searchResult(conversation('direct', [original], true))
    const input = {
      source: { ...source, kind: 'direct', id: 'peer' },
      query: { delegatedMessage: { id: 'ask', at, conversationId: 'direct' } },
    }
    assert.equal((await registry.call(providerId, 'readSource', input)).target.id, 'ask')

    original.isRecalled = true
    await assert.rejects(registry.call(providerId, 'readSource', input), {
      code: 'dingtalk_response_invalid',
      message: 'The original message is missing or changed',
    })
  } finally {
    dispose()
  }
})

test('the owner speaking in another group topic does not count as taking over', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(clock) })
  const { ctx, state } = fixture()
  const { registry, dispose, source } = await register(ctx)
  try {
    const original = message('ask', at, { openConvThreadId: 'release-topic' })
    state.mentions = searchResult(conversation('group', [original]))
    state.search = searchResult(
      conversation('group', [
        original,
        message('clarification', '2026-11-24T00:10:10Z', { openConvThreadId: 'release-topic' }),
        message('owner-in-other-topic', '2026-11-24T00:10:30Z', {
          senderOpenDingTalkId: 'self',
          openConvThreadId: 'unrelated-topic',
        }),
      ])
    )

    const snapshot = await registry.call(providerId, 'readSource', {
      source,
      query: { delegatedMessage: { id: 'ask', at, conversationId: 'group' } },
    })
    assert.equal(snapshot.ownerIntervened, false)
    assert.deepEqual(
      snapshot.laterMessages.map(row => row.id),
      ['clarification']
    )
  } finally {
    dispose()
  }
})
