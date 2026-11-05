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
