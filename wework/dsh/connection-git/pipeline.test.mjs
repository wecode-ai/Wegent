import assert from 'node:assert/strict'
import test from 'node:test'
import { createProvider } from './provider.js'

function fixture() {
  const instance = 'https://git.company.example'
  const profile = JSON.stringify([instance, '7'])
  const repository = 'group/sub/project'
  const calls = []
  const run = {
    id: 123,
    project_id: 42,
    web_url: `${instance}/${repository}/-/pipelines/123`,
    sha: 'a'.repeat(40),
    status: 'running',
  }
  let error
  const ctx = {
    git: {
      read: async input => {
        calls.push(input)
        if (input.operation === 'identity') return { profile, login: 'alice', instance }
        assert.equal(input.profile, profile)
        assert.equal(input.repository, repository)
        if (input.operation === 'repository')
          return { profile, data: { id: 42, path_with_namespace: repository } }
        assert.equal(input.operation, 'api')
        assert.equal(input.path, 'pipelines/123')
        if (error) throw Object.assign(new Error(error), { code: error })
        return { profile, data: structuredClone(run) }
      },
    },
  }
  const provider = createProvider('gitlab')
  const discover = async () =>
    (
      await provider.listResources(ctx, {
        kind: 'repository',
        query: JSON.stringify({
          instance,
          repository,
          monitoredObjects: [{ entityKind: 'pipeline', number: 123 }],
        }),
      })
    ).items[0]
  const collect = async (source, checkpoint = {}) => {
    const events = []
    for (let i = 0; i < 4; i++) {
      const result = await provider.collect(ctx, {
        source,
        checkpoint: structuredClone(checkpoint),
        force: true,
      })
      checkpoint = result.nextCheckpoint
      events.push(...result.events)
      if (!result.hasMore) return { events, checkpoint }
    }
    assert.fail('Pipeline collection exceeded its bounded cycle')
  }
  return {
    run,
    calls,
    provider,
    discover,
    collect,
    fail: code => {
      error = code
    },
  }
}

for (const status of ['success', 'failed', 'canceled', 'skipped', 'manual']) {
  test(`GitLab pipeline observes ${status}, deduplicates and keeps exact scope`, async () => {
    const f = fixture()
    const source = { ...(await f.discover()), enabledAfter: new Date().toISOString() }
    assert.equal(source.configurationSummary, 'Pipelines #123')
    const baseline = await f.collect(source)
    assert.deepEqual(baseline.events, [])
    f.run.status = status
    const terminal = await f.collect(source, baseline.checkpoint)
    assert.equal(terminal.events.length, 1)
    assert.equal(terminal.events[0].external.eventType, 'tracked.pipeline')
    assert.equal(terminal.events[0].external.headSha, f.run.sha)
    assert.equal(terminal.events[0].topicId, f.run.web_url)
    assert.equal(terminal.checkpoint.resourceStates[f.run.web_url].data.status, status)
    assert.deepEqual((await f.collect(source, terminal.checkpoint)).events, [])
    assert.ok(f.calls.every(call => ['identity', 'repository', 'api'].includes(call.operation)))
  })
}

test('GitLab initial terminal completion is visible and permission errors preserve its snapshot', async () => {
  const f = fixture()
  f.run.status = 'failed'
  const source = { ...(await f.discover()), enabledAfter: new Date().toISOString() }
  const completed = await f.collect(source)
  assert.equal(completed.events.length, 1)
  f.fail('git_permission_denied')
  const unavailable = await f.collect(source, completed.checkpoint)
  const snapshot = unavailable.checkpoint.resourceStates[f.run.web_url]
  assert.equal(snapshot.errorCode, 'git_permission_denied')
  assert.equal(snapshot.data.status, 'failed')
  f.fail(undefined)
  const recovered = await f.collect(source, unavailable.checkpoint)
  assert.equal(recovered.checkpoint.resourceStates[f.run.web_url].errorCode, undefined)
  assert.deepEqual(recovered.events, [])
})

test('GitLab pipeline rejects a different project, run, URL or revision', async () => {
  for (const patch of [
    { project_id: 43 },
    { id: 124 },
    { web_url: 'https://other/pipeline' },
    { sha: 'short' },
  ]) {
    const f = fixture()
    const source = { ...(await f.discover()), enabledAfter: new Date().toISOString() }
    Object.assign(f.run, patch)
    await assert.rejects(f.discover, /identity or account changed/)
    await assert.rejects(() => f.collect(source), /identity or account changed/)
  }
})
