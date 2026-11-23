import assert from 'node:assert/strict'
import test from 'node:test'
import { createProvider } from './provider.js'
import { bindGitProvider } from './runtime-bridge.js'
import { ConnectionRegistry, parseConnections } from '../plugin-runtime/connections.js'
import { readFile } from 'node:fs/promises'

const OLD = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
function fixture(platform, respond = () => [], transport = 'cli') {
  const profile = JSON.stringify([
    platform === 'github' ? 'https://github.com' : 'https://git.company.example',
    '7',
  ])
  const source = {
    providerId: '@wegent/dsh-connection-git/' + platform,
    profile,
    kind: 'repository',
    id: '42',
    name: 'org/project',
    transport,
    ...(transport === 'webhook' ? { subscriptionId: 'sub', generation: 'one' } : {}),
    enabledAfter: '2026-01-01T00:00:00Z',
  }
  const calls = []
  const state = { head: HEAD, repoId: 42, replyProfile: profile }
  const provider = bindGitProvider(
    source.providerId,
    createProvider(platform),
    async (method, input) => {
      assert.equal(method, 'runtime.connections.git.read')
      calls.push(input)
      const data =
        input.operation === 'repository'
          ? {
              id: state.repoId,
              [platform === 'github' ? 'full_name' : 'path_with_namespace']: source.name,
            }
          : input.operation === 'object'
            ? {
                id: 99,
                number: 17,
                iid: 17,
                title: 'Current object',
                head: { sha: state.head },
                diff_refs: { head_sha: state.head },
              }
            : respond(input, state)
      return { profile: state.replyProfile, data }
    }
  )
  return {
    provider,
    source,
    calls,
    state,
    ctx: { providerId: source.providerId, signal: new AbortController().signal },
  }
}
const query = (view, extra = {}) => ({ entityKind: 'change_request', number: 17, view, ...extra })

test('review windows read only the authorized native discussion and bind continuations to its selection', async () => {
  const at = '2020-09-12T12:00:00Z'
  const query = { since: '2020-09-12T11:00:00Z', trainingUntil: '2020-09-12T13:00:00Z', limit: 10 }
  for (const platform of ['github', 'gitlab']) {
    const f = fixture(platform)
    const source = { ...f.source, monitoredObjects: [{ entityKind: 'issue', number: 17 }] }
    const calls = []
    let deleted = false
    let confidential = false
    const provider = bindGitProvider(
      source.providerId,
      createProvider(platform),
      async (method, input) => {
        assert.equal(method, 'runtime.connections.git.read')
        assert.equal(input.profile, source.profile)
        calls.push(input)
        const by = id => ({ id, type: 'User', username: 'user' + id })
        const post = (id, author) => ({
          id,
          body: 'Reply ' + id,
          user: by(author),
          author: by(author),
          created_at: at,
          updated_at: at,
        })
        const data =
          input.operation === 'repository'
            ? { id: 42, full_name: source.name, path_with_namespace: source.name }
            : input.operation === 'object'
              ? {
                  number: 17,
                  iid: 17,
                  title: 'Question',
                  confidential,
                  user: by(12),
                  author: by(12),
                  created_at: at,
                  updated_at: at,
                }
              : [
                  ...(deleted ? [] : [post(34, 7)]),
                  post(42, 12),
                  { ...post(43, 7), updated_at: '2020-09-12T12:10:00Z' },
                  { ...post(44, 7), updated_at: query.trainingUntil },
                  ...(platform === 'gitlab'
                    ? [
                        { ...post(45, 12), internal: true },
                        { ...post(46, 12), confidential: true },
                      ]
                    : []),
                ]
        if (!Array.isArray(data)) return { profile: source.profile, data }
        const params = new URLSearchParams(input.path.split('?')[1])
        const page = Number(params.get('page'))
        const count = Number(params.get('per_page'))
        return { profile: source.profile, data: data.slice((page - 1) * count, page * count) }
      }
    )
    const first = await provider.readSource(f.ctx, { source, query })
    assert.equal(first.items[0].author, 'participant')
    assert.equal(first.reviewUseCollectedEvents, undefined)
    const before = calls.length
    await assert.rejects(
      provider.readSource(f.ctx, {
        source: { ...source, monitoredObjects: [{ entityKind: 'issue', number: 18 }] },
        query,
        cursor: first.nextCursor,
      }),
      { code: 'source_read_cursor_invalid' }
    )
    assert.equal(calls.length, before)
    const next = await provider.readSource(f.ctx, { source, query, cursor: first.nextCursor })
    assert.equal(next.hasMore, false)
    assert.equal(next.reviewCoverage, 'partial')
    assert.equal(next.reviewUseCollectedEvents, undefined)
    assert.match(next.items[0].id, /^git-canonical:/)
    assert.deepEqual(
      next.items.map(row => row.author),
      ['authenticatedAccount', 'participant', 'unknown']
    )
    assert.equal(next.items[0].topicId, first.items[0].topicId)
    assert.equal(next.items[2].at, '2020-09-12T12:10:00.000Z')
    assert.match(calls.at(-1).path, /^issues\/17\/(comments|notes)\?/)
    for (const status of [
      { branch: 'releases' },
      { observeCurrentStatus: true },
      {
        monitoredObjects: [
          { entityKind: platform === 'github' ? 'workflow_run' : 'pipeline', number: 19 },
        ],
      },
    ]) {
      const before = calls.length
      const statusPage = await provider.readSource(f.ctx, {
        source: { ...source, ...status },
        query,
      })
      assert.deepEqual(statusPage, {
        items: [],
        hasMore: false,
        readOnly: true,
        reviewCoverage: 'partial',
        reviewUseCollectedEvents: true,
      })
      assert.deepEqual(
        calls.slice(before).map(call => call.operation),
        ['repository']
      )
    }
    const empty = await f.provider.readSource(f.ctx, { source: f.source, query })
    assert.deepEqual(empty.items, [])
    assert.equal(empty.reviewUseCollectedEvents, undefined)
    const single = { ...query, limit: 1 }
    const start = await provider.readSource(f.ctx, { source, query: single })
    const firstNote = await provider.readSource(f.ctx, { source, cursor: start.nextCursor })
    assert.equal(firstNote.items[0].text, 'Reply 34')
    deleted = true
    await assert.rejects(provider.readSource(f.ctx, { source, cursor: firstNote.nextCursor }), {
      code: 'source_read_cursor_invalid',
    })
    const restart = await provider.readSource(f.ctx, { source, query: single })
    const nowFirst = await provider.readSource(f.ctx, { source, cursor: restart.nextCursor })
    assert.equal(nowFirst.items[0].text, 'Reply 42')
    if (platform === 'gitlab') {
      confidential = true
      const count = calls.length
      const hidden = await provider.readSource(f.ctx, { source, cursor: nowFirst.nextCursor })
      assert.deepEqual(hidden.items, [])
      assert.equal(hidden.hasMore, false)
      assert.deepEqual(
        calls.slice(count).map(call => call.operation),
        ['repository', 'object']
      )
    }
  }
})

test('personal Git review stays in its authenticated activity feed without opening referenced repositories', async () => {
  const f = fixture('github', () => [
    {
      id: 'event',
      repo: { name: 'other/repo' },
      created_at: '2020-09-12T12:00:00Z',
      payload: {
        action: 'created',
        issue: { number: 1 },
        comment: {
          id: 23,
          user: { id: 7, type: 'User' },
          created_at: '2020-09-12T12:00:00Z',
          body: 'A comment',
        },
      },
    },
  ])
  const source = { ...f.source, id: 'personal', kind: 'personal', name: 'Selected account' }
  const query = { since: '2020-09-12T11:00:00Z', trainingUntil: '2020-09-12T13:00:00Z', limit: 20 }
  const view = await f.provider.readSource(f.ctx, { source, query })
  assert.equal(view.items[0].text, 'A comment')
  assert.equal(view.items[0].author, 'authenticatedAccount')
  assert.equal(view.reviewCoverage, 'partial')
  assert.deepEqual(
    f.calls.map(call => call.operation),
    ['activity']
  )
  assert.match(view.items[0].topicId, /other\/repo\/issues\/1$/)
  const events = [1, 2].map(id => ({
    id,
    repo: { name: 'other/repo' },
    created_at: '2020-09-12T12:00:00Z',
    payload: {
      action: 'created',
      issue: { number: 1 },
      comment: { id, body: 'Reply ' + id, created_at: '2020-09-12T12:00:00Z' },
    },
  }))
  const changing = fixture('github', () => events)
  const first = await changing.provider.readSource(changing.ctx, {
    source,
    query: { ...query, limit: 1 },
  })
  assert.equal(first.items[0].text, 'Reply 1')
  events.shift()
  await assert.rejects(
    changing.provider.readSource(changing.ctx, { source, cursor: first.nextCursor }),
    {
      code: 'source_read_cursor_invalid',
    }
  )

  const gl = fixture('gitlab', () => [
    {
      project_id: 4,
      author: { id: 12, username: 'colleague' },
      note: {
        id: 33,
        noteable_id: 9,
        noteable_type: 'MergeRequest',
        author_id: 12,
        created_at: '2020-09-12T12:01:00Z',
        body: 'Discussion from the personal feed',
      },
    },
  ])
  const glSource = { ...gl.source, id: 'personal', kind: 'personal' }
  const glView = await gl.provider.readSource(gl.ctx, { source: glSource, query })
  assert.equal(glView.items[0].author, 'participant')
  assert.deepEqual(JSON.parse(glView.items[0].topicId), [
    'https://git.company.example',
    'project',
    4,
    'MergeRequest',
    9,
  ])
  assert.deepEqual(
    gl.calls.map(call => call.operation),
    ['activity']
  )

  const legacy = fixture('github', () => ({
    items: [
      {
        html_url: 'https://github.com/org/project/issues/23',
        number: 23,
        title: 'Assigned issue',
        user: { id: 12, type: 'User' },
        created_at: '2020-09-12T12:01:00Z',
      },
    ],
  }))
  const olderSource = { ...source, transport: undefined }
  const older = await legacy.provider.readSource(legacy.ctx, { source: olderSource, query })
  assert.equal(older.items[0].text, 'Assigned issue')
  assert.equal(older.items[0].author, 'participant')
  assert.deepEqual(
    legacy.calls.map(call => call.operation),
    ['assigned']
  )
})

for (const platform of ['github', 'gitlab']) {
  test(
    platform + ' repository reads use the existing native account route without writes',
    async () => {
      for (const transport of ['cli', 'webhook']) {
        const f = fixture(platform, () => [], transport)
        const result = await f.provider.readSource(f.ctx, {
          source: f.source,
          query: query('details'),
        })
        assert.equal(result.items[0].data.title, 'Current object')
        assert.equal(result.hasMore, false)
        assert.equal(result.readOnly, true)
        assert.equal(result.nextCheckpoint, undefined)
        assert.deepEqual(
          f.calls.map(x => x.operation),
          ['repository', 'object']
        )
        assert.ok(
          f.calls.every(
            x =>
              x.profile === f.source.profile &&
              x.repository === f.source.name &&
              x.accountId === '7' &&
              x.providerId === f.source.providerId
          )
        )
      }
    }
  )
  test(
    platform + ' pins check pages to fresh head and preserves raw-page continuation',
    async () => {
      const f = fixture(platform, input => {
        const rows =
          input.page === 1
            ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1, sha: OLD, head_sha: input.sha }))
            : input.page === 2
              ? [{ id: 101, sha: HEAD, head_sha: HEAD }]
              : []
        return platform === 'github' ? { check_runs: rows } : rows
      })
      const first = await f.provider.readSource(f.ctx, { source: f.source, query: query('checks') })
      assert.equal(first.commitSha, HEAD)
      assert.equal(first.hasMore, true)
      if (platform === 'gitlab') assert.equal(first.items.length, 0)
      f.state.head = 'c'.repeat(40)
      const last = await f.provider.readSource(f.ctx, {
        source: f.source,
        cursor: first.nextCursor,
      })
      assert.equal(last.items[0].data.id, 101)
      assert.equal(last.hasMore, false)
      assert.equal(last.commitSha, HEAD)
      const checks = f.calls.filter(x => x.operation === 'checks')
      assert.deepEqual(
        checks.map(x => [x.sha, x.page]),
        [
          [HEAD, 1],
          [HEAD, 2],
        ]
      )
      assert.equal(f.calls.filter(x => x.operation === 'object').length, 1)
      const fresh = await f.provider.readSource(f.ctx, { source: f.source, query: query('checks') })
      assert.equal(fresh.commitSha, 'c'.repeat(40))
      assert.equal(f.calls.filter(x => x.operation === 'object').length, 2)
    }
  )
  test(
    platform + ' explicit commit statuses, discussion and review views use fixed native GET paths',
    async () => {
      const f = fixture(platform, input =>
        platform === 'gitlab' && input.path?.endsWith('/approvals')
          ? { id: 99, approved_by: [] }
          : [{ id: 3, body: 'Evidence', sha: OLD }]
      )
      const statuses = await f.provider.readSource(f.ctx, {
        source: f.source,
        query: query('statuses', { sha: OLD }),
      })
      assert.equal(statuses.commitSha, OLD)
      assert.equal(
        f.calls.at(-1).path,
        (platform === 'github' ? 'commits/' : 'repository/commits/') +
          OLD +
          '/statuses?per_page=100&page=1'
      )
      assert.equal(f.calls.filter(x => x.operation === 'object').length, 0)
      await f.provider.readSource(f.ctx, { source: f.source, query: query('comments') })
      assert.equal(f.calls.at(-1).operation, 'comments')
      await f.provider.readSource(f.ctx, { source: f.source, query: query('reviews') })
      assert.equal(
        f.calls.at(-1).path,
        platform === 'github'
          ? 'pulls/17/reviews?per_page=100&page=1'
          : 'merge_requests/17/approvals'
      )
      const issue = await f.provider.readSource(f.ctx, {
        source: f.source,
        query: { entityKind: 'issue', number: 17, view: 'details' },
      })
      assert.equal(issue.items[0].data.id, 99)
    }
  )
  test(platform + ' exact hundred-row pages include a final empty native page', async () => {
    const f = fixture(platform, input =>
      input.page === 1 ? Array.from({ length: 100 }, (_, i) => ({ id: i })) : []
    )
    const first = await f.provider.readSource(f.ctx, { source: f.source, query: query('comments') })
    const last = await f.provider.readSource(f.ctx, { source: f.source, cursor: first.nextCursor })
    assert.equal(first.items.length, 100)
    assert.equal(last.hasMore, false)
    assert.deepEqual(last.items, [])
    assert.equal(f.calls.at(-1).page, 2)
  })
  test(
    platform + ' cursors reject cross-source/account/query/restart without native access',
    async () => {
      const f = fixture(platform, () => Array.from({ length: 100 }, (_, i) => ({ id: i })))
      const first = await f.provider.readSource(f.ctx, {
        source: f.source,
        query: query('comments'),
      })
      const before = f.calls.length
      for (const input of [
        { source: { ...f.source, id: 'different' }, cursor: first.nextCursor },
        {
          source: { ...f.source, profile: JSON.stringify(['https://other.example', '9']) },
          cursor: first.nextCursor,
        },
        { source: { ...f.source, name: 'other/repo' }, cursor: first.nextCursor },
        { source: f.source, cursor: first.nextCursor, query: query('comments', { number: 18 }) },
        { source: f.source, cursor: first.nextCursor + 'bad' },
      ])
        await assert.rejects(f.provider.readSource(f.ctx, input), {
          code: 'source_read_cursor_invalid',
        })
      assert.equal(f.calls.length, before)
      const fresh = fixture(platform)
      await assert.rejects(
        fresh.provider.readSource(fresh.ctx, { source: fresh.source, cursor: first.nextCursor }),
        { code: 'source_read_cursor_invalid' }
      )
    }
  )
  test(
    platform + ' expiration and native repository/account changes stay explicit failures',
    async t => {
      const f = fixture(platform, () => Array.from({ length: 100 }, (_, i) => ({ id: i })))
      const first = await f.provider.readSource(f.ctx, {
        source: f.source,
        query: query('comments'),
      })
      f.state.repoId = 43
      await assert.rejects(
        f.provider.readSource(f.ctx, { source: f.source, cursor: first.nextCursor }),
        /repository identity changed/
      )
      f.state.repoId = 42
      f.state.replyProfile = 'another account'
      await assert.rejects(
        f.provider.readSource(f.ctx, { source: f.source, cursor: first.nextCursor }),
        /account changed/
      )
      f.state.replyProfile = f.source.profile
      const now = Date.now()
      t.mock.method(Date, 'now', () => now + 31 * 60000)
      const before = f.calls.length
      await assert.rejects(
        f.provider.readSource(f.ctx, { source: f.source, cursor: first.nextCursor }),
        { code: 'source_read_cursor_invalid' }
      )
      assert.equal(f.calls.length, before)
    }
  )
}

test('both provider manifests expose schemas through the unchanged connection registry', async t => {
  const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
  const parsed = parseConnections(manifest)
  for (const platform of ['github', 'gitlab']) {
    const f = fixture(platform, input =>
        input.operation === 'job_log' ? { jobId: String(input.jobId), text: '' } : []
      ),
      registry = new ConnectionRegistry({
        inventory: async () => [],
        satisfies: () => true,
        context: () => f.ctx,
      })
    const other = fixture(platform === 'github' ? 'gitlab' : 'github')
    await registry.register({ effect() {} }, new URL('./package.json', import.meta.url), {
      [platform]: f.provider,
      [platform === 'github' ? 'gitlab' : 'github']: other.provider,
    })
    t.after(() => registry.dispose())
    const capability = (await registry.catalog()).find(x => x.id === f.source.providerId).read
    assert.deepEqual(capability.inputSchema.required, ['entityKind', 'number', 'view'])
    assert.ok(capability.inputSchema.properties.view.enum.includes('statuses'))
    assert.ok(capability.inputSchema.properties.entityKind.enum.includes('job'))
    assert.ok(capability.inputSchema.properties.view.enum.includes('logs'))
    assert.equal(parsed.providers.find(x => x.id === platform).read.pagination, 'cursor')
    await registry.call(f.source.providerId, 'readSource', {
      source: f.source,
      query: query('details'),
    })
    const job = await registry.call(f.source.providerId, 'readSource', {
      source: f.source,
      query: { entityKind: 'job', number: 912, view: 'logs' },
    })
    assert.equal(job.items[0].data.jobId, '912')
    const coverage = await registry.call(f.source.providerId, 'collect', {
      source: f.source,
      checkpoint: {
        tracked: {},
        seen: {},
        openChanges: { page: 1, coverageStatus: 'limited', coverageRevision: 1 },
      },
    })
    assert.equal(coverage.events[0].eventType, 'git.monitoring_coverage')
    assert.equal(coverage.events[0].external.coverageStatus, 'complete')

    for (const bad of [
      query('checks', { sha: 'invalid' }),
      query('comments', { repository: 'other/repo' }),
      query('comments', { sha: HEAD }),
      { entityKind: 'issue', number: 17, view: 'checks' },
      { entityKind: 'issue', number: 0, view: 'details' },
      { entityKind: 'job', number: 1, view: 'details' },
      { entityKind: 'change_request', number: 17, view: 'logs' },
      { entityKind: 'job', number: 1, view: 'logs', sha: HEAD },
    ])
      await assert.rejects(
        registry.call(f.source.providerId, 'readSource', { source: f.source, query: bad }),
        { code: 'invalid_connection' }
      )
  }
})

test('invalid shapes, unsupported scope and native permission errors never fall back to shell', async () => {
  for (const patch of [{ kind: 'personal' }, { scope: 'all', id: '*' }, { providerId: 'other' }]) {
    const f = fixture('github')
    await assert.rejects(
      f.provider.readSource(f.ctx, { source: { ...f.source, ...patch }, query: query('details') }),
      { code: 'git_connection_invalid' }
    )
    assert.equal(f.calls.length, 0)
  }
  for (const data of [undefined, { unexpected: [] }, [null], [{ body: 'missing ID' }]]) {
    const f = fixture('github', () => data)
    await assert.rejects(
      f.provider.readSource(f.ctx, { source: f.source, query: query('comments') }),
      { code: 'git_connection_invalid' }
    )
  }
  const failure = Object.assign(new Error('Forbidden'), { code: 'git_permission_denied' })
  const f = fixture('github', () => {
    throw failure
  })
  await assert.rejects(
    f.provider.readSource(f.ctx, { source: f.source, query: query('comments') }),
    error => error === failure
  )
  assert.deepEqual(
    f.calls.map(x => x.operation),
    ['repository', 'comments']
  )
})

test('missing pipeline commit or foreign check-run commit cannot become a successful empty result', async () => {
  for (const platform of ['github', 'gitlab']) {
    const f = fixture(platform, () =>
      platform === 'github' ? { check_runs: [{ id: 1, head_sha: OLD }] } : [{ id: 1 }]
    )
    await assert.rejects(
      f.provider.readSource(f.ctx, { source: f.source, query: query('checks') }),
      { code: 'git_connection_invalid' }
    )
  }
})

for (const platform of ['github', 'gitlab']) {
  test(
    platform + ' exposes selected CI job logs through the exact native repository account',
    async () => {
      const f = fixture(platform, input => {
        assert.deepEqual(
          { operation: input.operation, jobId: input.jobId },
          { operation: 'job_log', jobId: 912 }
        )
        return { jobId: '912', text: 'Actual native CI log' }
      })
      const result = await f.provider.readSource(f.ctx, {
        source: f.source,
        query: { entityKind: 'job', number: 912, view: 'logs' },
      })
      assert.deepEqual(
        f.calls.map(call => call.operation),
        ['repository', 'job_log']
      )
      assert.ok(
        f.calls.every(
          call => call.repository === f.source.name && call.profile === f.source.profile
        )
      )
      assert.equal(result.items[0].data.text, 'Actual native CI log')
      assert.equal(result.items[0].data.jobId, '912')
      assert.equal(result.hasMore, false)
      assert.equal(result.nextCursor, undefined)
      assert.equal(result.nextCheckpoint, undefined)
      assert.equal(result.readOnly, true)
      assert.ok(result.items[0].id.includes('912'))
      f.state.repoId = 43
      const before = f.calls.length
      await assert.rejects(
        f.provider.readSource(f.ctx, {
          source: f.source,
          query: { entityKind: 'job', number: 912, view: 'logs' },
        }),
        /repository identity changed/
      )
      assert.equal(f.calls.length, before + 1)
    }
  )

  test(
    platform + ' rejects mismatched logs and preserves native failures without another route',
    async () => {
      for (const reply of [
        { jobId: '913', text: 'Foreign job' },
        { jobId: '912' },
        { jobId: 912, text: 'Wrong shape' },
      ]) {
        const f = fixture(platform, () => reply)
        await assert.rejects(
          f.provider.readSource(f.ctx, {
            source: f.source,
            query: { entityKind: 'job', number: 912, view: 'logs' },
          }),
          /does not match the requested job/
        )
      }
      const failure = Object.assign(new Error('CI log read timed out'), {
        code: 'git_connection_invalid',
      })
      const f = fixture(platform, () => {
        throw failure
      })
      await assert.rejects(
        f.provider.readSource(f.ctx, {
          source: f.source,
          query: { entityKind: 'job', number: 912, view: 'logs' },
        }),
        error => error === failure
      )
      assert.deepEqual(
        f.calls.map(call => call.operation),
        ['repository', 'job_log']
      )
    }
  )
}
