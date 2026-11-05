import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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

test('resource discovery returns the exact native login target only after an authentication failure', async () => {
  for (const platform of ['github', 'gitlab']) {
    const target = {
      pluginKey: platform,
      connectorSlug: 'exact-native-slug',
      ...(platform === 'gitlab' ? { instance: 'https://git.company.example' } : {}),
    }
    const calls = []
    const result = await createProvider(platform).listResources(
      {
        git: {
          read: async () => {
            throw Object.assign(new Error('Native login required'), {
              code: 'connector_auth_required',
            })
          },
          authTarget: async input => {
            calls.push(input)
            return { ...target, localAuth: { ignored: true } }
          },
        },
      },
      { kind: 'personal', query: JSON.stringify({ instance: 'https://git.company.example' }) }
    )
    assert.deepEqual(result, {
      items: [],
      hasMore: false,
      availability: { status: 'auth_required', authTarget: target },
    })
    assert.deepEqual(calls, [{ instance: 'https://git.company.example' }])
  }
})

test('permission and network failures never become resource login requests', async () => {
  for (const code of ['git_permission_denied', 'git_cli_failed', 'git_not_found']) {
    let authCalls = 0
    await assert.rejects(
      createProvider('gitlab').listResources(
        {
          git: {
            read: async () => {
              throw Object.assign(new Error('Read failed'), { code })
            },
            authTarget: async () => {
              ++authCalls
            },
          },
        },
        { kind: 'personal', query: JSON.stringify({ instance: 'https://git.company.example' }) }
      ),
      { code }
    )
    assert.equal(authCalls, 0)
  }
})
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
  assert.equal(polled.events[0].objectId, delivered.objectId)
  assert.equal(polled.events[0].version, delivered.version)
  const edited = normalizeWebhook('github', source, {
    id: 'edited',
    eventType: 'issue_comment',
    receivedAt: comment.updated_at,
    payload: { issue: { number: 9 }, comment: { ...comment, body: 'human edit' } },
  })
  assert.notEqual(edited.id, delivered.id)
  assert.equal(edited.objectId, delivered.objectId)
  assert.notEqual(edited.version, delivered.version)
})

test('the same PR receives distinct check versions without depending on webhook delivery identity', () => {
  const payload = {
    action: 'completed',
    check_run: {
      id: 77,
      name: 'tests',
      status: 'completed',
      conclusion: 'success',
      head_sha: 'head',
      pull_requests: [{ number: 9 }],
    },
  }
  const delivery = {
    id: 'first-delivery',
    eventType: 'check_run',
    receivedAt: '2026-02-01T00:00:00Z',
    payload,
  }
  const first = normalizeWebhook('github', source, delivery)
  const repeated = normalizeWebhook('github', source, {
    ...delivery,
    id: 'redelivery',
    receivedAt: '2026-02-02T00:00:00Z',
  })
  assert.notEqual(first.id, repeated.id)
  assert.equal(first.objectId, repeated.objectId)
  assert.equal(first.version, repeated.version)
  const failed = normalizeWebhook('github', source, {
    ...delivery,
    payload: { ...payload, check_run: { ...payload.check_run, conclusion: 'failure' } },
  })
  assert.equal(first.topicId, failed.topicId)
  assert.equal(first.objectId, failed.objectId)
  assert.notEqual(first.version, failed.version)
  const otherCheck = normalizeWebhook('github', source, {
    ...delivery,
    payload: { ...payload, check_run: { ...payload.check_run, id: 78 } },
  })
  assert.notEqual(first.objectId, otherCheck.objectId)
  const reordered = normalizeWebhook('github', source, {
    ...delivery,
    payload: {
      check_run: {
        pull_requests: [{ number: 9 }],
        head_sha: 'head',
        conclusion: 'success',
        status: 'completed',
        name: 'tests',
        id: 77,
      },
      action: 'completed',
    },
  })
  assert.equal(first.version, reordered.version)
})

test('GitLab pipeline transitions carry one stable object identity and distinct source versions', () => {
  const gl = { ...source, profile: JSON.stringify(['https://gitlab.example', '7']) }
  const delivery = {
    id: 'one',
    eventType: 'Pipeline Hook',
    receivedAt: '2026-02-01T00:00:00Z',
    payload: {
      object_kind: 'pipeline',
      object_attributes: { id: 41, sha: 'head', status: 'running' },
    },
  }
  const running = normalizeWebhook('gitlab', gl, delivery)
  const failed = normalizeWebhook('gitlab', gl, {
    ...delivery,
    id: 'two',
    payload: {
      ...delivery.payload,
      object_attributes: { ...delivery.payload.object_attributes, status: 'failed' },
    },
  })
  assert.equal(running.objectId, failed.objectId)
  assert.notEqual(running.version, failed.version)
  const retry = normalizeWebhook('gitlab', gl, {
    ...delivery,
    id: 'duplicate',
    receivedAt: '2026-02-02T00:00:00Z',
  })
  assert.equal(running.version, retry.version)
})

test('GitLab Pipeline Hook and the MR pipeline list share a business version despite different response shapes', async () => {
  // GitLab documents Pipeline Hook attributes separately from the four-field MR pipeline list.
  // https://docs.gitlab.com/user/project/integrations/webhook_events/#pipeline-events
  // https://docs.gitlab.com/api/merge_requests/#list-merge-request-pipelines
  const gl = { ...source, profile: JSON.stringify(['https://gitlab.example', '7']) }
  const attributes = {
    id: 77,
    iid: 3,
    sha: 'head',
    ref: 'main',
    status: 'success',
    detailed_status: 'passed',
    stages: ['build', 'test'],
    created_at: '2026-02-01T00:00:00Z',
    finished_at: '2026-02-01T00:01:00Z',
    duration: 60,
    url: 'https://gitlab.example/org/repo/-/pipelines/77',
  }
  const delivered = normalizeWebhook('gitlab', gl, {
    id: 'pipeline-delivery',
    eventType: 'Pipeline Hook',
    receivedAt: '2026-02-01T00:01:00Z',
    payload: {
      object_kind: 'pipeline',
      object_attributes: attributes,
      merge_request: { id: 900, iid: 9, title: 'Parent MR' },
    },
  })
  const target = {
    url: 'https://gitlab.example/org/repo/-/merge_requests/9',
    repository: 'org/repo',
    number: 9,
    entityKind: 'change_request',
    sha: 'head',
  }
  const checkpoint = {
    after: personal.enabledAfter,
    until: '2026-03-01T00:00:00Z',
    stream: 3,
    page: 1,
    seen: {},
    trackStep: 2,
    tracked: { [target.url]: target },
  }
  const provider = createProvider('gitlab')
  const collect = status =>
    provider.collect(
      { git: { read: async () => ({ data: [{ id: 77, sha: 'head', ref: 'main', status }] }) } },
      { source: { ...personal, profile: gl.profile }, checkpoint }
    )
  const polled = (await collect('success')).events[0]
  assert.equal(delivered.topicId, target.url)
  assert.equal(delivered.objectId, polled.objectId)
  assert.equal(delivered.version, polled.version)
  const failed = (await collect('failed')).events[0]
  assert.equal(failed.objectId, delivered.objectId)
  assert.notEqual(failed.version, delivered.version)
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

test('personal collection preserves existing raw checkpoint digests while object versions ignore key order', async () => {
  const provider = createProvider('github')
  const row = {
    id: 10,
    updated_at: '2026-02-01T00:00:00Z',
    subject: { title: 'Review', type: 'PullRequest' },
  }
  const digest = createHash('sha256').update(JSON.stringify(row)).digest('hex')
  const checkpoint = {
    after: personal.enabledAfter,
    until: '2026-03-01T00:00:00Z',
    stream: 0,
    page: 1,
    seen: {},
    tracked: {},
  }
  const collect = (item, state) =>
    provider.collect(
      { git: { read: async () => ({ data: [item] }) } },
      { source: personal, checkpoint: state }
    )
  const first = (await collect(row, checkpoint)).events[0]
  assert.equal(first.id, `github:notifications:10:${digest}`)
  assert.equal(
    (
      await collect(row, {
        ...checkpoint,
        seen: { 'notifications:10': { digest, at: row.updated_at } },
      })
    ).events.length,
    0
  )
  const reordered = {
    subject: { type: 'PullRequest', title: 'Review' },
    updated_at: row.updated_at,
    id: 10,
  }
  const repeated = (await collect(reordered, checkpoint)).events[0]
  assert.notEqual(first.id, repeated.id)
  assert.equal(first.objectId, repeated.objectId)
  assert.equal(first.version, repeated.version)
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

test('idle repository collection uses cloud polling without repeated platform identity reads', async () => {
  let reads = 0
  const ctx = {
    git: {
      read: async () => {
        reads++
        return { data: { id: 42 } }
      },
      inbox: async () => ({ items: [], hasMore: false, gapBefore: 0 }),
    },
  }
  const provider = createProvider('github')
  let checkpoint = (await provider.collect(ctx, { source, checkpoint: { sequence: 0 } }))
    .nextCheckpoint
  assert.equal(reads, 1)
  checkpoint.nextCheckAt = 0
  checkpoint = (await provider.collect(ctx, { source, checkpoint })).nextCheckpoint
  assert.equal(reads, 1)
  checkpoint.nextCheckAt = 0
  checkpoint.identityCheckedAt = Date.now() - 3600001
  await provider.collect(ctx, { source, checkpoint })
  assert.equal(reads, 2)
  checkpoint.nextCheckAt = 0
  await assert.rejects(
    provider.collect(
      { git: { ...ctx.git, read: async () => ({ data: { id: 99 } }) } },
      { source, checkpoint }
    ),
    /Repository identity changed/
  )
})

test('inaccessible tracked targets advance while transient failures retain the checkpoint', async () => {
  const target = {
    url: 'https://github.com/org/repo/issues/9',
    repository: 'org/repo',
    number: 9,
    entityKind: 'issue',
  }
  const checkpoint = {
    after: personal.enabledAfter,
    until: '2026-03-01T00:00:00Z',
    stream: 3,
    page: 2,
    trackStep: 0,
    tracked: { [target.url]: target },
  }
  const provider = createProvider('github')
  for (const code of ['git_not_found', 'git_permission_denied']) {
    const ctx = {
      git: {
        read: async () => {
          throw Object.assign(new Error('gone'), { code })
        },
      },
    }
    const result = await provider.collect(ctx, { source: personal, checkpoint })
    assert.equal(result.nextCheckpoint.trackIndex, 1)
    assert.equal(result.nextCheckpoint.trackStep, 0)
    assert.equal(result.nextCheckpoint.page, 1)
    assert.equal(result.nextCheckpoint.tracked[target.url].finished, true)
    const finished = await provider.collect(ctx, {
      source: personal,
      checkpoint: result.nextCheckpoint,
    })
    assert.equal(finished.nextCheckpoint.stream, 0)
    assert.deepEqual(finished.nextCheckpoint.tracked, {})
  }
  for (const code of [
    'git_rate_limited',
    'git_cli_timeout',
    'connector_auth_required',
    'git_cli_failed',
  ])
    await assert.rejects(
      provider.collect(
        {
          git: {
            read: async () => {
              throw Object.assign(new Error('retry'), { code })
            },
          },
        },
        { source: personal, checkpoint }
      ),
      { code }
    )
  assert.equal(checkpoint.page, 2)
  assert.equal(checkpoint.tracked[target.url].finished, undefined)
})

test('denied CI details do not unsubscribe an otherwise accessible pull request', async () => {
  const target = {
    url: 'https://github.com/org/repo/pull/9',
    repository: 'org/repo',
    number: 9,
    entityKind: 'change_request',
    sha: 'a'.repeat(40),
  }
  const checkpoint = {
    after: personal.enabledAfter,
    until: '2026-03-01T00:00:00Z',
    stream: 3,
    page: 2,
    trackStep: 2,
    tracked: { [target.url]: target },
  }
  const provider = createProvider('github')
  for (const code of ['git_not_found', 'git_permission_denied']) {
    const result = await provider.collect(
      {
        git: {
          read: async () => {
            throw Object.assign(new Error('CI not available'), { code })
          },
        },
      },
      { source: personal, checkpoint }
    )
    assert.equal(result.nextCheckpoint.trackStep, 3)
    assert.equal(result.nextCheckpoint.page, 1)
    assert.equal(result.nextCheckpoint.tracked[target.url].finished, undefined)
    const calls = []
    const reviews = await provider.collect(
      {
        git: {
          read: async input => {
            calls.push(input)
            return { data: [] }
          },
        },
      },
      { source: personal, checkpoint: result.nextCheckpoint }
    )
    assert.equal(calls[0].path, 'pulls/9/reviews')
    const finished = await provider.collect(
      {},
      { source: personal, checkpoint: reviews.nextCheckpoint }
    )
    assert.equal(finished.nextCheckpoint.stream, 0)
    assert.deepEqual(finished.nextCheckpoint.tracked[target.url], target)
  }
})

test('GitLab canonical comments normalize equivalent legacy and ISO timestamp formats', () => {
  const gl = { ...source, profile: JSON.stringify(['https://gitlab.example', '7']) }
  const normalize = updated_at =>
    normalizeWebhook('gitlab', gl, {
      id: 'delivery',
      eventType: 'Note Hook',
      receivedAt: '2026-02-01T00:00:00Z',
      payload: {
        object_kind: 'note',
        issue: { iid: 9 },
        object_attributes: { id: 11, note: 'same reply', updated_at },
      },
    }).id
  assert.equal(normalize('2026-02-01 00:00:00 UTC'), normalize('2026-02-01T00:00:00.000Z'))
  assert.equal(
    normalize('2026-02-01T00:00:00Z'),
    'git-canonical:30bddc52cd52d15c6015b7dae9db9c383e6795bfd2c02a85d4512bf4798d08a2'
  )
  assert.equal(normalize('2026-02-01T01:00:00+01:00'), normalize('2026-02-01T00:00:00Z'))
  assert.notEqual(normalize('2026-02-01T00:00:00.001Z'), normalize('2026-02-01 00:00:00 UTC'))
})

for (const platform of ['github', 'gitlab']) {
  test(`${platform} CLI repository collection needs no cloud and resumes without duplicate events`, async () => {
    const cliSource = {
      ...source,
      transport: 'cli',
      profile: JSON.stringify([`https://${platform}.com`, '7']),
    }
    delete cliSource.subscriptionId
    delete cliSource.generation
    const at = new Date(Date.now() - 1000).toISOString()
    const row =
      platform === 'github'
        ? {
            id: 'event-1',
            type: 'FutureEvent',
            created_at: at,
            actor: { id: 7, login: 'alice' },
            repo: { id: 42, name: 'org/repo' },
            payload: { future_field: true },
          }
        : {
            id: 1,
            action_name: 'future action',
            created_at: at,
            project_id: 42,
            author: { id: 7, username: 'alice' },
            future_field: true,
          }
    const calls = []
    const ctx = {
      git: {
        inbox: () => assert.fail('CLI sources must never use the cloud inbox'),
        read: async input => {
          calls.push(input.operation)
          return {
            data: input.operation === 'repository' ? { id: 42 } : [row],
            pollIntervalSeconds: 120,
          }
        },
      },
    }
    const provider = createProvider(platform)
    await provider.validate(ctx, cliSource)
    const checkpoint = {
      ...(await provider.initialize(ctx, cliSource)),
      openChanges: { complete: true },
    }
    assert.equal(checkpoint.partition, undefined)
    const first = await provider.collect(ctx, { source: cliSource, checkpoint })
    assert.equal(first.events.length, 1)
    assert.deepEqual(first.events[0].external.payload, row)
    assert.equal(first.events[0].external.repositoryPath, 'org/repo')
    assert.equal(first.events[0].external.repositoryId, '42')
    assert.equal(first.events[0].senderId, '7')
    const finished = await provider.collect(ctx, {
      source: cliSource,
      checkpoint: first.nextCheckpoint,
    })
    assert.equal(finished.hasMore, false)
    assert.ok(finished.nextCheckpoint.nextCheckAt >= Date.now() + 119000)
    const idle = await provider.collect(ctx, {
      source: cliSource,
      checkpoint: finished.nextCheckpoint,
    })
    assert.equal(idle.events.length, 0)
    assert.deepEqual(calls, ['repository', 'repository_events'])
    const resumed = await provider.collect(ctx, {
      source: cliSource,
      checkpoint: { ...finished.nextCheckpoint, nextCheckAt: 0 },
    })
    assert.equal(resumed.events.length, 0)
  })
}

test('CLI repository pages retain distinct events and reject a changed repository before reading its events', async () => {
  const cliSource = { ...source, transport: 'cli' }
  const at = new Date().toISOString()
  const provider = createProvider('github')
  const ctx = {
    git: {
      read: async input => ({
        data:
          input.operation === 'repository'
            ? { id: 42 }
            : input.page === 1
              ? Array.from({ length: 100 }, (_, id) => ({
                  id,
                  type: 'FutureEvent',
                  created_at: at,
                  payload: {},
                }))
              : [{ id: 100, type: 'FutureEvent', created_at: at, payload: {} }],
      }),
    },
  }
  const first = await provider.collect(ctx, {
    source: cliSource,
    checkpoint: { ...(await provider.initialize(ctx, cliSource)), openChanges: { complete: true } },
  })
  assert.equal(first.events.length, 100)
  assert.equal(first.nextCheckpoint.activityPage, 2)
  const second = await provider.collect(ctx, {
    source: cliSource,
    checkpoint: first.nextCheckpoint,
  })
  assert.equal(second.events.length, 1)
  assert.equal(second.nextCheckpoint.activityComplete, true)
  await assert.rejects(
    provider.collect(
      {
        git: {
          read: async input => {
            assert.equal(input.operation, 'repository')
            return { data: { id: 99 } }
          },
        },
      },
      { source: cliSource, checkpoint: {} }
    ),
    /Repository identity changed/
  )
})

test('CLI personal scope collects authored and received activity plus personal work without a cloud subscription', async () => {
  const at = new Date().toISOString()
  const row = {
    id: 'push',
    type: 'PushEvent',
    created_at: at,
    repo: { id: 42, name: 'org/repo' },
    payload: { head: 'sha' },
  }
  const cliSource = { ...personal, transport: 'cli' }
  const calls = []
  const ctx = {
    git: {
      read: async input => {
        calls.push(input.operation)
        return {
          data: ['activity', 'received_activity'].includes(input.operation)
            ? [row]
            : input.operation === 'notifications'
              ? []
              : { items: [] },
        }
      },
    },
  }
  const provider = createProvider('github')
  let checkpoint = {
    ...(await provider.initialize(ctx, cliSource)),
    openChanges: { complete: true },
  }
  const events = []
  for (let i = 0; i < 10; i++) {
    const result = await provider.collect(ctx, { source: cliSource, checkpoint })
    events.push(...result.events)
    checkpoint = result.nextCheckpoint
    if (!result.hasMore) break
  }
  assert.deepEqual(calls, ['activity', 'received_activity', 'notifications', 'assigned', 'reviews'])
  assert.equal(events.length, 1)
  assert.equal(events[0].external.eventType, 'PushEvent')
  assert.equal(checkpoint.activityComplete, false)
  assert.ok(checkpoint.nextCheckAt > Date.now())
})

test('CLI collection errors leave the durable checkpoint unchanged', async () => {
  const checkpoint = { seen: {}, activityPage: 2 }
  const before = structuredClone(checkpoint)
  await assert.rejects(
    createProvider('github').collect(
      {
        git: {
          read: async () => {
            throw new Error('device offline')
          },
        },
      },
      { source: { ...source, transport: 'cli' }, checkpoint }
    ),
    /device offline/
  )
  assert.deepEqual(checkpoint, before)
})

test('a full GitHub window reports unseen backlog but still accepts a previously collected last page', async () => {
  const rows = Array.from({ length: 100 }, (_, id) => ({
    id,
    type: 'FutureEvent',
    created_at: new Date().toISOString(),
    payload: {},
  }))
  const ctx = { git: { read: async () => ({ data: rows }) } }
  const provider = createProvider('github')
  const cliSource = { ...source, transport: 'cli' }
  await assert.rejects(
    provider.collect(ctx, {
      source: cliSource,
      checkpoint: { activityPage: 3, openChanges: { complete: true } },
    }),
    { code: 'git_backlog_limit' }
  )
  const repeated = await provider.collect(ctx, {
    source: cliSource,
    checkpoint: {
      openChanges: { complete: true },
      activityPage: 3,
      seen: Object.fromEntries(rows.map(row => [`activity:${row.id}`, { at: row.created_at }])),
    },
  })
  assert.equal(repeated.events.length, 0)
  assert.equal(repeated.nextCheckpoint.activityComplete, true)
})

for (const scope of ['personal', 'repository']) {
  for (const kind of ['Issue', 'MergeRequest']) {
    test(`GitLab ${scope} activity discovers and tracks ${kind} without a supplied URL`, async () => {
      const at = new Date().toISOString()
      const cliSource = {
        ...personal,
        kind: scope,
        id: scope === 'repository' ? '42' : 'personal',
        name: scope === 'repository' ? 'group/repo' : 'alice',
        profile: JSON.stringify(['https://gitlab.com', '7']),
        transport: 'cli',
      }
      const row = {
        id: 91,
        project_id: 42,
        target_type: kind,
        target_id: 301,
        target_iid: 3,
        target_title: 'Work',
        action_name: 'opened',
        created_at: at,
        author: { id: 7 },
      }
      const calls = []
      const ctx = {
        git: {
          read: async input => {
            calls.push(input)
            if (input.operation === 'repository')
              return { data: { id: 42, path_with_namespace: 'group/repo' } }
            if (['activity', 'repository_events'].includes(input.operation)) return { data: [row] }
            if (input.operation === 'object')
              return { data: { id: 301, iid: 3, state: 'opened', updated_at: at } }
            if (input.operation === 'comments')
              return {
                data: [
                  { id: 77, body: 'Follow-up', created_at: at, updated_at: at, author: { id: 8 } },
                ],
              }
            return { data: [] }
          },
        },
      }
      const provider = createProvider('gitlab')
      let checkpoint = {
        ...(await provider.initialize(ctx, cliSource)),
        openChanges: { complete: true },
      }
      const events = []
      for (let i = 0; i < 15; i++) {
        const result = await provider.collect(ctx, { source: cliSource, checkpoint })
        events.push(...result.events)
        checkpoint = result.nextCheckpoint
        if (!result.hasMore) break
      }
      const url = `https://gitlab.com/group/repo/-/${kind === 'Issue' ? 'issues' : 'merge_requests'}/3`
      assert.equal(events[0].external.url, url)
      assert.equal(events[0].external.repositoryPath, 'group/repo')
      assert.ok(events.some(event => event.external.eventType === 'tracked.comments'))
      assert.ok(
        calls.some(
          input =>
            input.operation === 'comments' &&
            input.repository === 'group/repo' &&
            input.number === 3
        )
      )
      if (scope === 'personal')
        assert.ok(
          calls.some(input => input.operation === 'repository' && input.repository === '42')
        )
      if (kind === 'MergeRequest')
        assert.ok(
          calls.some(
            input => input.operation === 'api' && input.path === 'merge_requests/3/approvals'
          )
        )
    })
  }
}

test('activity deduplication survives the generic thirty-day checkpoint cleanup', async () => {
  const at = new Date(Date.now() - 31 * 86400000).toISOString()
  const cliSource = {
    ...source,
    profile: JSON.stringify(['https://gitlab.com', '7']),
    transport: 'cli',
  }
  const row = { id: 'old-activity', created_at: at, project_id: 42, action_name: 'future action' }
  const ctx = {
    git: { read: async input => ({ data: input.operation === 'repository' ? { id: 42 } : [row] }) },
  }
  const provider = createProvider('gitlab')
  const first = await provider.collect(ctx, {
    source: cliSource,
    checkpoint: { ...(await provider.initialize(ctx, cliSource)), openChanges: { complete: true } },
  })
  assert.equal(first.events.length, 1)
  const completed = await provider.collect(ctx, {
    source: cliSource,
    checkpoint: first.nextCheckpoint,
  })
  const next = await provider.collect(ctx, {
    source: cliSource,
    checkpoint: { ...completed.nextCheckpoint, nextCheckAt: 0 },
  })
  assert.equal(next.events.length, 0)
})
