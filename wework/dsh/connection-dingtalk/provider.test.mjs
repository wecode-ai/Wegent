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
