import assert from 'node:assert/strict'
import test from 'node:test'
import { createProvider, normalizeMessages } from './provider.js'
const conversation = (id, direct, sender) => ({
  openConversationId: id,
  singleChat: direct,
  messages: [
    {
      senderOpenDingTalkId: sender,
      content: 'Review this',
      openMessageId: `${id}:${sender}`,
      createTime: '2026-10-23 12:00:00',
    },
  ],
})

test('DingTalk collection preserves the host read classification without provider-specific retries', async () => {
  for (const code of [
    'connection_cli_request_unavailable',
    'connector_auth_required',
    'connection_cli_failed',
    'dingtalk_response_invalid',
    'forbidden',
  ]) {
    const failure = Object.assign(new Error('Read failed'), {
      code,
      ...(code === 'connection_cli_request_unavailable'
        ? { retryAfterMs: 30000, providerCode: 'request_failed' }
        : {}),
    })
    const ctx = {
      cli: {
        callTool: async () => {
          throw failure
        },
      },
    }
    const provider = createProvider()
    await assert.rejects(
      provider.collect(ctx, {
        source: {
          id: 'group',
          profile: 'account',
          kind: 'group',
          enabledAfter: '2026-10-01T00:00:00Z',
        },
        checkpoint: {},
      }),
      error => {
        assert.equal(error, failure)
        return true
      }
    )
  }
})

test('preserves group and sender boundaries and excludes automated self replies', () => {
  const response = {
    result: {
      conversationMessagesList: [
        conversation('selected', false, 'alice'),
        conversation('other', false, 'alice'),
        conversation('selected', false, 'me'),
        conversation('dm-a', true, 'alice'),
        conversation('dm-b', true, 'bob'),
      ],
    },
  }
  const group = normalizeMessages({ kind: 'group', id: 'selected' }, response, 'me')
  assert.equal(group.length, 1)
  assert.equal(group[0].conversationId, 'selected')
  const direct = normalizeMessages({ kind: 'direct', id: 'alice' }, response, 'me')
  assert.equal(direct.length, 1)
  assert.equal(direct[0].conversationId, 'dm-a')
  const manual = conversation('selected', false, 'me')
  manual.messages[0].sendType = 'user'
  const automated = structuredClone(manual)
  automated.messages[0].messageAiSendFlag = 'DWS'
  assert.equal(
    normalizeMessages(
      { kind: 'group', id: 'selected' },
      { result: { conversationMessagesList: [manual, automated] } },
      'me'
    ).length,
    1
  )
})

test('accepts successful empty pages and rejects incomplete provider responses', () => {
  assert.deepEqual(
    normalizeMessages(
      { kind: 'group', id: 'selected' },
      { success: true, result: { hasMore: false, nextCursor: '0' } },
      'me'
    ),
    []
  )
  for (const response of [
    { success: false },
    { success: true, result: { hasMore: true, nextCursor: 'next' } },
    {
      result: {
        conversationMessagesList: [
          {
            openConversationId: 'selected',
            singleChat: false,
            messages: [{ senderOpenDingTalkId: 'alice' }],
          },
        ],
      },
    },
  ]) {
    assert.throws(
      () => normalizeMessages({ kind: 'group', id: 'selected' }, response, 'me'),
      error => error.code === 'dingtalk_response_invalid'
    )
  }
})

test('keeps the collection window while paging and never advances a stalled cursor', async () => {
  let stalled = false
  const calls = []
  const ctx = {
    cli: {
      async callTool(alias, input) {
        assert.equal(alias, 'dingtalk')
        calls.push(input)
        if (input.tool === 'listProfiles')
          return { profiles: [{ profile: 'corp:user', userName: 'Alice', userId: 'me' }] }
        if (input.tool === 'searchUsers')
          return { result: [{ userId: 'me', openDingTalkId: 'own' }] }
        return {
          result: {
            conversationMessagesList: [conversation('selected', false, 'alice')],
            hasMore: true,
            nextCursor: stalled ? '2' : '3',
          },
        }
      },
    },
  }
  const provider = createProvider()
  const source = {
    kind: 'group',
    id: 'selected',
    profile: 'corp:user',
    enabledAfter: '2026-10-01T00:00:00Z',
  }
  const checkpoint = { after: '2026-10-24T00:00:00Z', until: '2026-10-25T00:00:00Z', cursor: '2' }
  const page = await provider.collect(ctx, { source, checkpoint })
  assert.deepEqual(page.nextCheckpoint, { ...checkpoint, cursor: '3' })
  assert.deepEqual(calls.at(-1), {
    tool: 'listMentions',
    arguments: {
      group: 'selected',
      start: checkpoint.after,
      end: checkpoint.until,
      limit: '100',
      cursor: '2',
      profile: 'corp:user',
    },
  })
  stalled = true
  await assert.rejects(provider.collect(ctx, { source, checkpoint }), /cursor did not advance/)
})

test('searches resources through declared generic CLI operations and preserves pagination', async () => {
  const calls = []
  const ctx = {
    cli: {
      async callTool(alias, input) {
        assert.equal(alias, 'dingtalk')
        calls.push(input)
        if (input.tool === 'listProfiles') return { currentProfile: 'corp:user' }
        if (input.tool === 'searchGroups')
          return {
            result: {
              groups: [{ openConversationId: 'group-1', title: 'Team' }],
              hasMore: true,
              nextCursor: 'next',
            },
          }
        if (input.tool === 'searchUsers')
          return { result: [{ openDingTalkId: 'user-1', name: 'Alice' }] }
        assert.fail(`Unexpected operation: ${input.tool}`)
      },
    },
  }
  const provider = createProvider()
  const groups = await provider.listResources(ctx, { kind: 'group', query: 'Team', cursor: '2' })
  assert.equal(groups.items[0].id, 'group-1')
  assert.equal(groups.nextCursor, 'next')
  assert.deepEqual(calls.at(-1), {
    tool: 'searchGroups',
    arguments: { query: 'Team', profile: 'corp:user', cursor: '2' },
  })
  const users = await provider.listResources(ctx, { kind: 'direct', query: 'Alice' })
  assert.equal(users.items[0].id, 'user-1')
  assert.deepEqual(calls.at(-1), {
    tool: 'searchUsers',
    arguments: { query: 'Alice', profile: 'corp:user' },
  })
})

test('collects direct messages with sender filtering through the generic CLI bridge', async () => {
  const calls = []
  const ctx = {
    cli: {
      async callTool(alias, input) {
        assert.equal(alias, 'dingtalk')
        calls.push(input)
        if (input.tool === 'listProfiles')
          return { profiles: [{ profile: 'corp:user', userName: 'Me', userId: 'me' }] }
        if (input.tool === 'searchUsers')
          return { result: [{ userId: 'me', openDingTalkId: 'own' }] }
        return {
          result: {
            conversationMessagesList: [
              conversation('dm-a', true, 'alice'),
              conversation('dm-b', true, 'bob'),
            ],
            hasMore: false,
            nextCursor: '0',
          },
        }
      },
    },
  }
  const source = {
    kind: 'direct',
    id: 'alice',
    profile: 'corp:user',
    enabledAfter: '2026-10-01T00:00:00Z',
  }
  const page = await createProvider().collect(ctx, {
    source,
    checkpoint: { after: source.enabledAfter, until: '2026-10-25T00:00:00Z', cursor: '0' },
  })
  assert.equal(page.events.length, 1)
  assert.equal(page.events[0].senderId, 'alice')
  assert.equal(calls.at(-1).tool, 'searchMessages')
  assert.equal(calls.at(-1).arguments.senderIds, 'alice')
  assert.deepEqual(page.nextCheckpoint, { after: '2026-10-25T00:00:00Z', cursor: '0' })
})

test('auth and business failures never advance checkpoints or trigger a fallback', async () => {
  const source = {
    kind: 'group',
    id: 'selected',
    profile: 'corp:user',
    enabledAfter: '2026-10-01T00:00:00Z',
  }
  const checkpoint = { after: source.enabledAfter, cursor: '0' }
  for (const code of ['need_login', 'NETWORK_ERROR', 'FORBIDDEN']) {
    let calls = 0
    const ctx = {
      cli: {
        async describe() {
          return { pluginKey: 'dingtalk', connectorSlug: 'dingtalk-local' }
        },
        async callTool() {
          calls++
          return { success: false, error: { code } }
        },
      },
    }
    const provider = createProvider()
    const status = await provider.check(ctx)
    assert.equal(status.status, code === 'need_login' ? 'auth_required' : 'error')
    await assert.rejects(provider.collect(ctx, { source, checkpoint }), {
      code: code === 'need_login' ? 'connector_auth_required' : 'dingtalk_response_invalid',
    })
    assert.deepEqual(checkpoint, { after: source.enabledAfter, cursor: '0' })
    assert.equal(calls, 2)
  }
})

test('discovers authorization identity from the exact installed dependency', async () => {
  const target = { pluginKey: 'dingtalk', connectorSlug: 'dingtalk-local' }
  const status = await createProvider().check({
    cli: {
      describe: async () => target,
      callTool: async () => ({ currentProfile: '' }),
    },
  })
  assert.equal(status.status, 'auth_required')
  assert.deepEqual(status.authTarget, target)
})

test('all-resource scopes retain the account and separate group and direct resources', async () => {
  for (const kind of ['group', 'direct']) {
    const calls = []
    const ctx = {
      cli: {
        async callTool(_alias, input) {
          calls.push(input)
          if (input.tool === 'listProfiles')
            return {
              currentProfile: 'corp:user',
              profiles: [{ profile: 'corp:user', userName: 'Me', userId: 'me' }],
            }
          if (input.tool === 'searchUsers')
            return { result: [{ userId: 'me', openDingTalkId: 'own' }] }
          return {
            result: {
              conversationMessagesList: [
                conversation('group-a', false, 'alice'),
                conversation('group-b', false, 'bob'),
                conversation('dm-a', true, 'alice'),
                conversation('dm-b', true, 'bob'),
                conversation('dm-self', true, 'own'),
              ],
              hasMore: false,
              nextCursor: '0',
            },
          }
        },
      },
    }
    const provider = createProvider()
    const page = await provider.listResources(ctx, { kind, scope: 'all' })
    const source = { ...page.items[0], enabledAfter: '2026-10-01T00:00:00Z' }
    assert.equal(source.scope, 'all')
    assert.equal(source.profile, 'corp:user')
    const result = await provider.collect(ctx, { source, checkpoint: null })
    assert.equal(result.events.length, 2)
    assert.deepEqual(
      result.events.map(event => event.resource.id),
      kind === 'group' ? ['group-a', 'group-b'] : ['alice', 'bob']
    )
    assert.ok(result.events.every(event => event.resource.kind === kind))
    assert.equal(calls.at(-1).arguments.profile, 'corp:user')
    assert.equal(calls.at(-1).arguments.group, undefined)
    assert.equal(calls.at(-1).arguments.senderIds, undefined)
    await assert.rejects(
      provider.validate(ctx, { ...source, scope: undefined }),
      /Invalid resource scope/
    )
  }
})

const readSource = (kind = 'group') => ({
  providerId: '@wegent/dsh-connection-dingtalk/dingtalk',
  kind,
  id: kind === 'group' ? 'selected' : 'alice',
  profile: 'corp:user',
  enabledAfter: '2026-10-01T00:00:00Z',
})
const nativeMessage = (id = 'message', patch = {}) => ({
  messageId: id,
  conversationId: 'selected',
  text: 'Please review',
  senderId: 'alice',
  sender: 'Alice',
  createTime: new Date(Date.now() - 60000).toISOString(),
  ...patch,
})
function readFixture(pages = [{ messages: [] }]) {
  const calls = []
  let index = 0
  const ctx = {
    cli: {
      async callTool(alias, input) {
        assert.equal(alias, 'dingtalk')
        calls.push(structuredClone(input))
        if (input.tool === 'listProfiles')
          return { profiles: [{ profile: 'corp:user', userName: 'Me', userId: 'me' }] }
        if (input.tool === 'searchUsers')
          return { result: [{ userId: 'me', openDingTalkId: 'own' }] }
        assert.ok(['listConversation', 'listDirectConversation'].includes(input.tool))
        return {
          contractVersion: 'im.message-list.v1',
          paginationKnown: true,
          hasMore: false,
          complete: true,
          failedCount: 0,
          failures: [],
          ...pages[index++],
        }
      },
    },
  }
  return { ctx, calls }
}

test('source history directly queries only the exact group or direct peer through the SDK', async () => {
  for (const kind of ['group', 'direct']) {
    const source = Object.freeze(readSource(kind))
    const fixture = readFixture([{ messages: [nativeMessage()] }])
    const result = await createProvider().readSource(fixture.ctx, { source, query: { limit: 2 } })
    assert.equal(result.items.length, 1)
    assert.equal(result.contextComplete, true)
    assert.equal(result.readOnly, true)
    assert.equal(result.nextCheckpoint, undefined)
    assert.deepEqual(fixture.calls.at(-1), {
      tool: kind === 'group' ? 'listConversation' : 'listDirectConversation',
      arguments: {
        [kind === 'group' ? 'group' : 'peer']: source.id,
        profile: source.profile,
        time: result.range.until,
        limit: '2',
      },
    })
    assert.deepEqual(
      fixture.calls.map(call => call.tool),
      [
        'listProfiles',
        'searchUsers',
        kind === 'group' ? 'listConversation' : 'listDirectConversation',
      ]
    )
  }
})

test('native history distinguishes self-chat from own messages to other people or groups', async () => {
  for (const [kind, peer, sender, selfChat] of [
    ['direct', 'own', 'own', true],
    ['direct', 'alice', 'own', false],
    ['direct', 'alice', 'alice', false],
    ['group', 'selected', 'own', false],
  ]) {
    const source = { ...readSource(kind), id: peer, name: 'Same display name' }
    const fixture = readFixture([
      { messages: [nativeMessage('message', { senderId: sender, sender: source.name })] },
    ])
    const result = await createProvider().readSource(fixture.ctx, { source, query: { limit: 2 } })
    assert.equal(result.items[0].isOwn, sender === 'own')
    assert.equal(result.items[0].isSelfConversation, selfChat)
  }
})

test('SDK native continuation preserves precision and same-timestamp messages without rescanning', async () => {
  const source = readSource()
  const time = new Date(Date.now() - 60000).toISOString().replace('Z', '123456Z')
  const stamp = new Date(Date.now() - 120000).toISOString()
  const fixture = readFixture([
    {
      messages: [nativeMessage('one', { createTime: stamp })],
      hasMore: true,
      complete: false,
      nextPage: { time, nextCursor: '123456789', direction: 'older' },
    },
    {
      messages: [
        nativeMessage('two', {
          createTime: stamp,
          senderId: 'own',
          text: 'Handled',
          quotedMessage: { messageId: 'one', text: 'Please review' },
        }),
      ],
    },
  ])
  const provider = createProvider()
  const first = await provider.readSource(fixture.ctx, { source, query: { limit: 1 } })
  const second = await provider.readSource(fixture.ctx, { source, cursor: first.nextCursor })
  assert.equal(fixture.calls.at(-1).arguments.time, time)
  assert.deepEqual(second.range, first.range)
  assert.equal(second.items[0].id, 'two')
  assert.equal(second.items[0].isOwn, true)
  assert.match(second.items[0].quotedMessage.text, /Please review/)
  assert.equal(second.hasMore, false)
  assert.equal(fixture.calls.filter(call => call.tool === 'listConversation').length, 2)
})

test('native history is bounded to its fixed window and page text budget', async () => {
  const since = new Date(Date.now() - 3600000).toISOString()
  const fixture = readFixture([
    {
      messages: [
        nativeMessage('new', { text: 'x'.repeat(20001) }),
        nativeMessage('old', { createTime: new Date(Date.now() - 7200000).toISOString() }),
      ],
      hasMore: true,
      nextPage: { time: new Date(Date.now() - 7200000).toISOString() },
    },
  ])
  const result = await createProvider().readSource(fixture.ctx, {
    source: readSource(),
    query: { since, limit: 2 },
  })
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].text.length, 12000)
  assert.equal(result.items[0].truncated, true)
  assert.equal(result.hasMore, false)
  assert.equal(result.range.since, since)
})

test('invalid scopes and ranges fail before any CLI operation', async () => {
  const { ctx, calls } = readFixture()
  const source = readSource()
  for (const input of [
    { source: { ...source, providerId: 'other' } },
    { source: { ...source, scope: 'all', id: '*' } },
    { source: { ...source, id: '*' } },
    { source: { ...source, id: 'selected,other' } },
    { source: { ...source, kind: 'other' } },
    { source: { ...source, profile: '' } },
    { source, query: { since: '' } },
    { source, query: { since: null } },
    { source, query: { since: 0 } },
    { source, query: { since: new Date(Date.now() - 8 * 86400000).toISOString() } },
    { source, query: { since: new Date(Date.now() + 86400000).toISOString() } },
    ...[0, 21, 1.5, '2', null].map(limit => ({ source, query: { limit } })),
  ])
    await assert.rejects(createProvider().readSource(ctx, input), {
      code: 'dingtalk_response_invalid',
    })
  assert.equal(calls.length, 0)
})

test('invalid SDK pagination, foreign messages and incomplete responses fail without fallback', async () => {
  for (const patch of [
    { contractVersion: 'unknown' },
    { paginationKnown: false },
    { hasMore: undefined },
    { failedCount: 1 },
    { partial: true },
    { hasMore: true, nextPage: {} },
    { messages: [nativeMessage('bad', { createTime: 'invalid' })] },
    { messages: [nativeMessage('foreign', { conversationId: 'other' })] },
    { messages: Array.from({ length: 21 }, () => nativeMessage()) },
  ]) {
    const fixture = readFixture([{ messages: [], ...patch }])
    await assert.rejects(createProvider().readSource(fixture.ctx, { source: readSource() }), {
      code: 'dingtalk_response_invalid',
    })
    assert.equal(fixture.calls.filter(call => call.tool === 'listConversation').length, 1)
  }
  const fixture = readFixture()
  assert.deepEqual(
    (await createProvider().readSource(fixture.ctx, { source: readSource() })).items,
    []
  )
})

test('cursor rejects changed source, account, window, limit, tampering and process restart before CLI', async () => {
  const source = readSource()
  const fixture = readFixture([
    {
      messages: [nativeMessage()],
      hasMore: true,
      nextPage: { time: new Date(Date.now() - 60000).toISOString() },
    },
  ])
  const provider = createProvider()
  const first = await provider.readSource(fixture.ctx, { source, query: { limit: 2 } })
  const before = fixture.calls.length
  for (const input of [
    { source: { ...source, id: 'other' }, cursor: first.nextCursor },
    { source: { ...source, profile: 'another' }, cursor: first.nextCursor },
    { source, cursor: first.nextCursor + 'x' },
    {
      source,
      cursor: first.nextCursor,
      query: { since: new Date(Date.now() - 3600000).toISOString() },
    },
    { source, cursor: first.nextCursor, query: { limit: 3 } },
  ])
    await assert.rejects(provider.readSource(fixture.ctx, input), {
      code: 'source_read_cursor_invalid',
    })
  await assert.rejects(
    createProvider().readSource(fixture.ctx, { source, cursor: first.nextCursor }),
    { code: 'source_read_cursor_invalid' }
  )
  assert.equal(fixture.calls.length, before)
})

test('read operations preserve collection checkpoints and actual native errors', async () => {
  const source = readSource(),
    checkpoint = Object.freeze({ after: source.enabledAfter, cursor: '2' })
  const fixture = readFixture([{ messages: [nativeMessage()] }])
  await createProvider().readSource(fixture.ctx, { source, checkpoint })
  assert.deepEqual(checkpoint, { after: source.enabledAfter, cursor: '2' })
  for (const code of [
    'connector_auth_required',
    'connection_cli_failed',
    'forbidden',
    'ECONNRESET',
  ]) {
    const error = Object.assign(new Error('Business read failed'), { code })
    await assert.rejects(
      createProvider().readSource(
        {
          cli: {
            callTool: async () => {
              throw error
            },
          },
        },
        { source }
      ),
      value => value === error
    )
  }
})
