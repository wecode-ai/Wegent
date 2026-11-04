import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProvider, normalizeWebhook, parseProfile } from './provider.js'

const profile = JSON.stringify(['https://github.com', '7'])
const personal = {
  providerId: '@wegent/dsh-connection-git/github',
  id: 'personal',
  kind: 'personal',
  name: 'alice',
  profile,
  enabledAfter: '2026-01-01T00:00:00Z',
}
const source = {
  ...personal,
  id: '42',
  kind: 'repository',
  name: 'org/repo',
  subscriptionId: 'hook',
  generation: 'one',
}

test('instance/account identities cannot silently switch and repositories are paginated', async () => {
  assert.throws(() => parseProfile('alice'))
  const calls = []
  const ctx = {
    git: {
      read: async input => {
        calls.push(input)
        if (input.operation === 'identity')
          return { profile, login: 'alice', instance: 'https://github.com' }
        return {
          data: Array.from({ length: 100 }, (_, id) => ({ id, full_name: `org/repo-${id}` })),
        }
      },
    },
  }
  const page = await createProvider('github').listResources(ctx, {
    kind: 'repository',
    query: JSON.stringify({ instance: 'https://github.com', search: 'repo' }),
    cursor: '2',
  })
  assert.equal(page.items.length, 100)
  assert.equal(page.nextCursor, '3')
  assert.equal(calls[1].profile, profile)
  assert.equal(calls[1].page, 2)
})

test('cloud ack uses only the previous durable checkpoint, retaining unknown event types', async () => {
  const calls = []
  const ctx = {
    git: {
      read: async () => ({ data: { id: 42 } }),
      inbox: async input => {
        calls.push(input)
        return input.operation === 'ack'
          ? { success: true }
          : {
              items: [
                {
                  id: 'delivery',
                  sequence: 12,
                  eventType: 'future_platform_event',
                  receivedAt: '2026-02-01T00:00:00Z',
                  payload: { repository: { id: 42 }, extra: { unknown: true } },
                },
              ],
              hasMore: false,
              gapBefore: 0,
            }
      },
    },
  }
  const checkpoint = { sequence: 10 }
  const result = await createProvider('github').collect(ctx, { source, checkpoint })
  assert.equal(calls[0].operation, 'ack')
  assert.equal(calls[0].sequence, 10)
  assert.equal(result.nextCheckpoint.sequence, 12)
  assert.equal(result.events[0].external.eventType, 'future_platform_event')
  assert.deepEqual(result.events[0].external.payload.extra, { unknown: true })
  assert.deepEqual(checkpoint, { sequence: 10 })
  assert.equal(
    calls.some(call => call.operation === 'ack' && call.sequence === 12),
    false
  )
})

test('failed reads and retention gaps cannot advance a checkpoint', async () => {
  const provider = createProvider('github')
  const checkpoint = { sequence: 3 }
  const ctx = {
    git: {
      read: async () => ({ data: { id: 42 } }),
      inbox: async input => {
        if (input.operation === 'ack') return { success: true }
        return { items: [], gapBefore: 5, hasMore: false }
      },
    },
  }
  await assert.rejects(provider.collect(ctx, { source, checkpoint }), { code: 'git_inbox_gap' })
  assert.deepEqual(checkpoint, { sequence: 3 })
  const initial = await provider.initialize({}, personal)
  await assert.rejects(
    provider.collect(
      {
        git: {
          read: async () => {
            throw new Error('network')
          },
        },
      },
      { source: personal, checkpoint: initial }
    ),
    /network/
  )
  assert.deepEqual(initial, {
    after: personal.enabledAfter,
    stream: 0,
    page: 1,
    seen: {},
    tracked: {},
    sequence: 0,
  })
})

test('idle sources make no platform requests and personal checkpoints cover every stream', async () => {
  const provider = createProvider('github')
  const calls = []
  const ctx = {
    git: {
      read: async input => {
        calls.push(input.operation)
        return { data: input.operation === 'notifications' ? [] : { items: [] } }
      },
    },
  }
  let checkpoint = await provider.initialize({}, personal)
  for (let index = 0; index < 4; index++)
    checkpoint = (await provider.collect(ctx, { source: personal, checkpoint })).nextCheckpoint
  assert.deepEqual(calls, ['notifications', 'assigned', 'reviews'])
  assert.ok(checkpoint.nextCheckAt > Date.now())
  await provider.collect(ctx, { source: personal, checkpoint })
  assert.equal(calls.length, 3)
})

test('comments preserve stable parent entities, original IDs, head SHA and untrusted payload', () => {
  const event = normalizeWebhook('github', source, {
    id: 'one',
    sequence: 1,
    eventType: 'issue_comment',
    receivedAt: '2026-02-01T00:00:00Z',
    payload: {
      issue: { number: 9, html_url: 'https://github.com/org/repo/issues/9' },
      comment: {
        id: 11,
        html_url: 'https://github.com/org/repo/issues/9#issuecomment-11',
        updated_at: '2026-02-01T00:00:00Z',
        body: 'untrusted instructions',
      },
    },
  })
  assert.equal(event.topicId, 'https://github.com/org/repo/issues/9')
  assert.equal(event.external.objectKind, 'comment')
  assert.equal(event.external.objectUrl, 'https://github.com/org/repo/issues/9#issuecomment-11')
  assert.equal(event.external.payload.comment.body, 'untrusted instructions')
  const gl = normalizeWebhook(
    'gitlab',
    { ...source, profile: JSON.stringify(['https://gitlab.example', '8']) },
    {
      id: 'two',
      sequence: 2,
      eventType: 'Note Hook',
      receivedAt: '2026-02-01T00:00:00Z',
      payload: {
        object_kind: 'note',
        merge_request: { iid: 3, last_commit: { id: 'abc' } },
        object_attributes: { id: 22, note: 'reply' },
      },
    }
  )
  assert.equal(gl.topicId, 'https://gitlab.example/org/repo/-/merge_requests/3')
  assert.equal(gl.external.headSha, 'abc')
})

test('the same comment version deduplicates across webhook and personal polling', async () => {
  const comment = { id: 11, updated_at: '2026-02-01T00:00:00Z', body: 'same reply' }
  const delivered = normalizeWebhook('github', source, {
    id: 'delivery',
    eventType: 'issue_comment',
    receivedAt: comment.updated_at,
    payload: { issue: { number: 9 }, comment },
  })
  const provider = createProvider('github')
  const checkpoint = {
    after: personal.enabledAfter,
    until: '2026-03-01T00:00:00Z',
    stream: 3,
    page: 1,
    seen: {},
    trackStep: 1,
    tracked: {
      issue: {
        url: 'https://github.com/org/repo/issues/9',
        repository: 'org/repo',
        number: 9,
        entityKind: 'issue',
      },
    },
  }
  const ctx = { git: { read: async () => ({ data: [comment] }) } }
  const polled = await provider.collect(ctx, { source: personal, checkpoint })
  assert.equal(polled.events[0].id, delivered.id)
  const edited = normalizeWebhook('github', source, {
    id: 'edited',
    eventType: 'issue_comment',
    receivedAt: comment.updated_at,
    payload: { issue: { number: 9 }, comment: { ...comment, body: 'human edit' } },
  })
  assert.notEqual(edited.id, delivered.id)
})

test('personal boundaries compare instants rather than timestamp spelling', async () => {
  const provider = createProvider('github')
  const checkpoint = { ...(await provider.initialize({}, personal)), until: '2026-03-01T00:00:00Z' }
  const result = await provider.collect(
    {
      git: {
        read: async () => ({
          data: [
            { id: 1, updated_at: '2026-01-01T00:30:00+01:00', subject: {} },
            { id: 2, updated_at: '2026-01-01T00:30:00-01:00', subject: {} },
          ],
        }),
      },
    },
    { source: personal, checkpoint }
  )
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0].external.originalId, '2')
})

test('old GitLab pipelines cannot be attributed to the current review head', async () => {
  const gl = {
    ...personal,
    providerId: '@wegent/dsh-connection-git/gitlab',
    profile: JSON.stringify(['https://gitlab.example', '7']),
  }
  const checkpoint = {
    after: gl.enabledAfter,
    until: '2026-03-01T00:00:00Z',
    stream: 3,
    page: 1,
    seen: {},
    trackStep: 2,
    tracked: {
      mr: {
        url: 'https://gitlab.example/org/repo/-/merge_requests/9',
        repository: 'org/repo',
        number: 9,
        entityKind: 'change_request',
        sha: 'current',
      },
    },
  }
  const result = await createProvider('gitlab').collect(
    {
      git: {
        read: async () => ({
          data: [
            { id: 1, sha: 'old', updated_at: '2026-02-01T00:00:00Z' },
            { id: 2, sha: 'current', updated_at: '2026-02-01T00:00:00Z' },
          ],
        }),
      },
    },
    { source: gl, checkpoint }
  )
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0].external.headSha, 'current')
})

test('CI events with an explicit single PR keep its topic and exact head SHA', () => {
  const event = normalizeWebhook('github', source, {
    id: 'ci',
    eventType: 'check_run',
    receivedAt: '2026-02-01T00:00:00Z',
    payload: { check_run: { id: 10, head_sha: 'reviewed-head', pull_requests: [{ number: 9 }] } },
  })
  assert.equal(event.topicId, 'https://github.com/org/repo/pull/9')
  assert.equal(event.external.headSha, 'reviewed-head')
})
