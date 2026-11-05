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

test('DingTalk collection retries only definite transport failures, not rejected or invalid reads', async () => {
  for (const code of [
    'connection_cli_timeout',
    'ECONNRESET',
    'ETIMEDOUT',
    'connector_auth_required',
    'connection_cli_failed',
    'dingtalk_response_invalid',
    'forbidden',
  ]) {
    const ctx = {
      cli: {
        callTool: async () => {
          throw Object.assign(new Error('Read failed'), { code })
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
        assert.equal(
          error.retryAfterMs,
          ['connection_cli_timeout', 'ECONNRESET', 'ETIMEDOUT'].includes(code) ? 30000 : undefined
        )
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

function readFixture(messages, pagination = {}) {
  const calls = []
  const ctx = {
    cli: {
      async callTool(alias, input) {
        assert.equal(alias, 'dingtalk')
        calls.push(structuredClone(input))
        if (input.tool === 'listProfiles')
          return { profiles: [{ profile: 'corp:user', userName: 'Me', userId: 'me' }] }
        if (input.tool === 'searchUsers')
          return { result: [{ userId: 'me', openDingTalkId: 'own' }] }
        assert.ok(['listMentions', 'searchMessages'].includes(input.tool))
        return {
          result: {
            conversationMessagesList: messages,
            hasMore: false,
            nextCursor: '0',
            ...pagination,
          },
        }
      },
    },
  }
  return { ctx, calls }
}

const readSource = (kind = 'group') => ({
  providerId: '@wegent/dsh-connection-dingtalk/dingtalk',
  kind,
  id: kind === 'group' ? 'selected' : 'alice',
  profile: 'corp:user',
  enabledAfter: '2026-10-01T00:00:00Z',
})

test('source reads use only the selected account and group or sender without collecting', async () => {
  for (const kind of ['group', 'direct']) {
    const direct = kind === 'direct'
    const messages = [
      conversation('selected', false, 'alice'),
      conversation('other', false, 'bob'),
      conversation('selected', false, 'own'),
      conversation('dm-a', true, 'alice'),
      conversation('dm-b', true, 'bob'),
    ]
    const { ctx, calls } = readFixture(messages)
    const source = Object.freeze(readSource(kind))
    const since = new Date(Date.now() - 3600000).toISOString()
    const result = await createProvider().readSource(ctx, { source, since, limit: 2 })
    assert.equal(result.items.length, 1)
    assert.equal(result.items[0].senderId, 'alice')
    assert.equal(result.items[0].conversationId, direct ? 'dm-a' : 'selected')
    assert.equal(result.readOnly, true)
    assert.equal(result.hasMore, true)
    assert.equal(result.readPhase, 'mentions')
    assert.equal(typeof result.nextCursor, 'string')
    assert.equal(result.range.since, since)
    assert.ok(Date.parse(result.range.until) >= Date.parse(since))
    assert.equal(result.nextCheckpoint, undefined)
    assert.deepEqual(calls.at(-1), {
      tool: direct ? 'searchMessages' : 'listMentions',
      arguments: {
        start: since,
        end: result.range.until,
        cursor: '0',
        limit: '2',
        profile: 'corp:user',
        ...(direct ? { senderIds: 'alice' } : { group: 'selected' }),
      },
    })
    assert.deepEqual(
      calls.map(call => call.tool),
      ['listProfiles', 'searchUsers', direct ? 'searchMessages' : 'listMentions']
    )
  }
})

test('source reads bound results and text and expose incomplete results', async () => {
  const first = conversation('selected', false, 'alice')
  first.messages[0].content = 'x'.repeat(20001)
  const { ctx } = readFixture([first, conversation('selected', false, 'bob')])
  const result = await createProvider().readSource(ctx, { source: readSource(), limit: 1 })
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].text.length, 20000)
  assert.equal(result.items[0].truncated, true)
  assert.equal(result.hasMore, true)
  const paged = readFixture([conversation('selected', false, 'alice')], {
    hasMore: true,
    nextCursor: 'next',
  })
  assert.equal(
    (await createProvider().readSource(paged.ctx, { source: readSource() })).hasMore,
    true
  )
})

test('invalid or wildcard read scopes and unbounded ranges fail before any CLI operation', async () => {
  const { ctx, calls } = readFixture([])
  const source = readSource()
  for (const input of [
    { source: { ...source, providerId: 'other' } },
    { source: { ...source, scope: 'all', id: '*' } },
    { source: { ...source, id: '*' } },
    { source: { ...source, id: 'selected,other' } },
    { source: { ...source, kind: 'other' } },
    { source: { ...source, profile: '' } },
    { source, since: '' },
    { source, since: null },
    { source, since: 0 },
    { source, since: new Date(Date.now() - 8 * 86400000).toISOString() },
    { source, since: new Date(Date.now() + 86400000).toISOString() },
    ...[0, 21, 1.5, '2', null].map(limit => ({ source, limit })),
  ]) {
    await assert.rejects(createProvider().readSource(ctx, input), {
      code: 'dingtalk_response_invalid',
    })
  }
  assert.equal(calls.length, 0)
})

test('source reads do not advance a collection checkpoint, including failed reads', async () => {
  const source = readSource()
  const checkpoint = Object.freeze({
    after: source.enabledAfter,
    until: '2026-10-25T00:00:00Z',
    cursor: '2',
  })
  const { ctx, calls } = readFixture([conversation('selected', false, 'alice')], {
    hasMore: true,
    nextCursor: '3',
  })
  const provider = createProvider()
  const before = await provider.collect(ctx, { source, checkpoint })
  await provider.readSource(ctx, { source, limit: 1, checkpoint })
  assert.equal(calls.at(-1).arguments.cursor, '0')
  const after = await provider.collect(ctx, { source, checkpoint })
  assert.equal(calls.at(-1).arguments.cursor, '2')
  assert.deepEqual(after, before)
  for (const code of [
    'connector_auth_required',
    'connection_cli_failed',
    'forbidden',
    'ECONNRESET',
  ]) {
    const failure = Object.assign(new Error('Business read failed'), { code })
    const blocked = {
      cli: {
        callTool: async () => {
          throw failure
        },
      },
    }
    await assert.rejects(
      provider.readSource(blocked, { source, checkpoint }),
      error => error === failure
    )
    assert.deepEqual(checkpoint, {
      after: source.enabledAfter,
      until: '2026-10-25T00:00:00Z',
      cursor: '2',
    })
  }
})

test('source reads reject invalid message or pagination results and accept an empty page', async () => {
  const empty = readFixture([])
  assert.deepEqual(
    (await createProvider().readSource(empty.ctx, { source: readSource() })).items,
    []
  )
  for (const patch of [
    { hasMore: undefined },
    { hasMore: true, nextCursor: '0' },
    { hasMore: true, nextCursor: '' },
  ]) {
    const fixture = readFixture([], patch)
    await assert.rejects(createProvider().readSource(fixture.ctx, { source: readSource() }), {
      code: 'dingtalk_response_invalid',
    })
  }
  const invalid = conversation('selected', false, 'alice')
  invalid.messages[0].createTime = 'not-a-date'
  const fixture = readFixture([invalid])
  await assert.rejects(createProvider().readSource(fixture.ctx, { source: readSource() }), {
    code: 'dingtalk_response_invalid',
  })
})

test('source read cursors finish mention pages then the same conversation including own replies', async () => {
  const calls = []
  const source = readSource()
  const first = conversation('selected', false, 'alice')
  const followup = conversation('selected', false, 'own')
  followup.messages[0].content = 'I have handled this question.'
  followup.messages[0].quotedMessage = { openMessageId: 'selected:alice', content: 'Review this' }
  const ctx = {
    cli: {
      async callTool(_alias, input) {
        calls.push(structuredClone(input))
        if (input.tool === 'listProfiles')
          return { profiles: [{ profile: 'corp:user', userName: 'Me', userId: 'me' }] }
        if (input.tool === 'searchUsers')
          return { result: [{ userId: 'me', openDingTalkId: 'own' }] }
        if (input.tool === 'listMentions')
          return { result: { conversationMessagesList: [first], hasMore: false, nextCursor: '0' } }
        assert.equal(input.tool, 'searchMessages')
        assert.equal(input.arguments.conversationIds, source.id)
        assert.equal(input.arguments.senderIds, undefined)
        return {
          result: {
            conversationMessagesList: [
              input.arguments.cursor === '0' ? first : followup,
              conversation('other', false, 'own'),
            ],
            hasMore: input.arguments.cursor === '0',
            nextCursor: input.arguments.cursor === '0' ? 'next' : '0',
          },
        }
      },
    },
  }
  const provider = createProvider()
  const firstPage = await provider.readSource(ctx, { source, limit: 1 })
  assert.equal(firstPage.contextComplete, false)
  const context = await provider.readSource(ctx, { source, cursor: firstPage.nextCursor })
  assert.equal(context.readPhase, 'conversation')
  assert.equal(context.items.length, 1)
  assert.equal(context.hasMore, true)
  const last = await provider.readSource(ctx, { source, cursor: context.nextCursor })
  assert.equal(last.hasMore, false)
  assert.equal(last.contextComplete, true)
  assert.equal(last.nextCursor, undefined)
  assert.equal(last.items[0].senderId, 'own')
  assert.equal(last.items[0].isOwn, true)
  assert.match(last.items[0].text, /handled/)
  assert.match(last.items[0].quotedMessage.text, /selected:alice/)
  assert.ok(last.items.every(item => item.conversationId === source.id))
  assert.deepEqual(last.range, firstPage.range)
  assert.ok(
    calls
      .filter(call => call.tool === 'searchMessages')
      .every(
        call =>
          call.arguments.start === firstPage.range.since &&
          call.arguments.end === firstPage.range.until
      )
  )
})

test('source read cursors retain overflow from a provider page without dropping messages', async () => {
  const { ctx } = readFixture([
    conversation('selected', false, 'alice'),
    conversation('selected', false, 'bob'),
  ])
  const provider = createProvider()
  const source = readSource()
  let page = await provider.readSource(ctx, { source, limit: 1 })
  const phases = [page.readPhase]
  const ids = [page.items[0].id]
  for (let count = 0; page.hasMore && count < 5; count++) {
    page = await provider.readSource(ctx, { source, cursor: page.nextCursor })
    phases.push(page.readPhase)
    ids.push(...page.items.map(item => item.id))
  }
  assert.equal(page.hasMore, false)
  assert.deepEqual(phases, ['mentions', 'mentions', 'conversation', 'conversation'])
  assert.deepEqual(ids, ['selected:alice', 'selected:bob', 'selected:alice', 'selected:bob'])
})

test('read cursors reject changed sources, windows, limits, tampering and another provider instance before CLI access', async () => {
  const { ctx, calls } = readFixture([conversation('selected', false, 'alice')])
  const provider = createProvider()
  const source = readSource()
  const first = await provider.readSource(ctx, { source, limit: 2 })
  const before = calls.length
  for (const input of [
    { source: { ...source, id: 'other' }, cursor: first.nextCursor },
    { source: { ...source, profile: 'another-account' }, cursor: first.nextCursor },
    { source, cursor: `${first.nextCursor}x` },
    { source, cursor: first.nextCursor, since: new Date(Date.now() - 3600000).toISOString() },
    { source, cursor: first.nextCursor, limit: 3 },
  ])
    await assert.rejects(provider.readSource(ctx, input), { code: 'source_read_cursor_invalid' })
  await assert.rejects(createProvider().readSource(ctx, { source, cursor: first.nextCursor }), {
    code: 'source_read_cursor_invalid',
  })
  assert.equal(calls.length, before)
})
