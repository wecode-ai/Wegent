import assert from 'node:assert/strict'
import test from 'node:test'
import { createProvider } from './provider.js'

const SHA = 'a'.repeat(40)
const profile = JSON.stringify(['https://github.com', '7'])
function fixture() {
  const calls = []
  const run = {
    id: 44231414768,
    html_url: 'https://github.com/org/repo/actions/runs/44231414768',
    repository: { id: 42, full_name: 'org/repo' },
    head_sha: SHA,
    status: 'in_progress',
    conclusion: null,
    run_attempt: 1,
  }
  const pr = {
    number: 4792,
    url: 'https://github.com/org/repo/pull/4792',
    headRefOid: SHA,
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
  }
  let error
  const ctx = {
    git: {
      read: async input => {
        calls.push(input)
        if (input.operation === 'identity')
          return { profile, login: 'alice', instance: 'https://github.com' }
        assert.equal(input.profile, profile)
        assert.equal(input.repository, 'org/repo')
        if (input.operation === 'repository')
          return { profile, data: { id: 42, full_name: 'org/repo' } }
        if (input.operation === 'change_request_status') {
          assert.equal(input.number, pr.number)
          assert.equal(input.entityKind, 'change_request')
          return { profile, data: structuredClone(pr) }
        }
        assert.equal(input.operation, 'api')
        assert.equal(input.path, 'actions/runs/44231414768')
        if (error) throw Object.assign(new Error(error), { code: error })
        return { profile, data: structuredClone(run) }
      },
    },
  }
  const provider = createProvider('github')
  const discover = async () =>
    (
      await provider.listResources(ctx, {
        kind: 'repository',
        query: JSON.stringify({
          instance: 'https://github.com',
          repository: 'org/repo',
          monitoredObjects: [{ entityKind: 'workflow_run', number: run.id }],
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
    assert.fail('Workflow collection exceeded its bounded cycle')
  }
  return {
    run,
    pr,
    calls,
    provider,
    discover,
    collect,
    fail: code => {
      error = code
    },
  }
}

test('a manually dispatched run wakes for its verified PR conflict while CI is running', async () => {
  const f = fixture()
  const link = { number: f.pr.number, base: { repo: { id: 42 } }, head: { sha: SHA } }
  f.run.event = 'workflow_dispatch'
  f.run.pull_requests = [link]
  const source = await f.discover()
  const baseline = await f.collect(source)
  assert.deepEqual(baseline.events, [])

  f.pr.mergeStateStatus = 'DIRTY'
  f.pr.headRefOid = 'b'.repeat(40)
  const stale = await f.collect(source, baseline.checkpoint)
  assert.deepEqual(stale.events, [])
  f.pr.headRefOid = SHA
  const conflict = await f.collect(source, stale.checkpoint)
  assert.equal(conflict.events.length, 1)
  const [event] = conflict.events
  assert.equal(event.topicId, f.run.html_url)
  assert.equal(event.external.eventType, 'tracked.workflow_run_pr_conflict')
  assert.equal(event.external.url, f.pr.url)
  assert.deepEqual(event.external.payload, { id: f.run.id, head_sha: SHA, run_attempt: 1 })
  assert.equal(f.run.status, 'in_progress')
  assert.deepEqual((await f.collect(source, conflict.checkpoint)).events, [])
  assert.equal((await f.collect(source)).events.length, 1)

  for (const unverified of [
    [{ ...link, base: { repo: { id: 43 } } }],
    [link, { ...link, number: link.number + 1 }],
  ]) {
    f.run.pull_requests = unverified
    const result = await f.collect(source, stale.checkpoint)
    assert.ok(result.events.every(event => event.external.eventType === 'tracked.workflow_run'))
  }
})

for (const conclusion of ['success', 'failure', 'cancelled', 'timed_out', 'action_required']) {
  test(`exact workflow run wakes on ${conclusion}, deduplicates, and observes reruns`, async () => {
    const f = fixture()
    const source = { ...(await f.discover()), enabledAfter: new Date().toISOString() }
    assert.equal(source.configurationSummary, 'Workflow runs #44231414768')
    const baseline = await f.collect(source)
    assert.deepEqual(baseline.events, [])
    f.run.status = 'completed'
    f.run.conclusion = conclusion
    const completed = await f.collect(source, baseline.checkpoint)
    assert.equal(completed.events.length, 1)
    const event = completed.events[0]
    assert.equal(event.topicId, f.run.html_url)
    assert.equal(event.external.eventType, 'tracked.workflow_run')
    assert.equal(event.external.headSha, SHA)
    assert.equal(event.external.payload.id, 44231414768)
    assert.equal(event.external.payload.conclusion, conclusion)
    assert.deepEqual((await f.collect(source, completed.checkpoint)).events, [])
    f.run.run_attempt = 2
    f.run.status = 'queued'
    f.run.conclusion = null
    const restarted = await f.collect(source, completed.checkpoint)
    assert.equal(restarted.events[0].external.payload.run_attempt, 2)
    f.run.status = 'completed'
    f.run.conclusion = 'success'
    const rerun = await f.collect(source, restarted.checkpoint)
    assert.equal(rerun.events.length, 1)
    assert.notEqual(rerun.events[0].version, event.version)
    assert.equal(rerun.events[0].objectId, event.objectId)
  })
}

test('completion before first collection is delivered, without a source timestamp dependency', async () => {
  const f = fixture()
  const source = await f.discover()
  f.run.status = 'completed'
  f.run.conclusion = 'failure'
  assert.equal((await f.collect(source)).events.length, 1)
})

test('run and repository identity mismatches reject discovery and collection', async () => {
  for (const patch of [
    { repository: { full_name: 'foreign/repo' } },
    { html_url: 'https://github.com/org/repo/actions/runs/9' },
    { head_sha: '' },
    { run_attempt: 0 },
  ]) {
    const f = fixture()
    const source = await f.discover()
    Object.assign(f.run, patch)
    await assert.rejects(f.discover(), /identity or account changed/)
    await assert.rejects(f.collect(source), /identity or account changed/)
  }
})

test('permission loss preserves an explicitly unavailable snapshot and recovery', async () => {
  const f = fixture()
  const source = await f.discover()
  const baseline = await f.collect(source)
  f.fail('git_permission_denied')
  const lost = await f.collect(source, baseline.checkpoint)
  assert.deepEqual(lost.events, [])
  assert.equal(lost.checkpoint.resourceStates[f.run.html_url].errorCode, 'git_permission_denied')
  assert.equal(lost.checkpoint.resourceStates[f.run.html_url].data.status, 'in_progress')
  f.fail(undefined)
  f.run.status = 'completed'
  f.run.conclusion = 'cancelled'
  const recovered = await f.collect(source, lost.checkpoint)
  assert.equal(recovered.events.length, 1)
  assert.equal(recovered.checkpoint.resourceStates[f.run.html_url].errorCode, undefined)
})

test('GitLab rejects workflow-run selection rather than treating it as an issue', async () => {
  await assert.rejects(
    createProvider('gitlab').listResources(
      {},
      {
        kind: 'repository',
        query: JSON.stringify({
          monitoredObjects: [{ entityKind: 'workflow_run', number: 1 }],
        }),
      }
    ),
    /Select/
  )
})

test('terminal snapshots ignore JSON key ordering and idle collection makes no native reads', async () => {
  const f = fixture()
  const source = await f.discover()
  f.run.status = 'completed'
  f.run.conclusion = 'success'
  const first = await f.collect(source)
  f.run.repository = { full_name: 'org/repo', id: 42 }
  const second = await f.collect(source, first.checkpoint)
  assert.deepEqual(second.events, [])
  const calls = f.calls.length
  await f.provider.collect({}, { source, checkpoint: second.checkpoint })
  assert.equal(f.calls.length, calls)
})

test('transient and authentication errors preserve the committed checkpoint without fallback', async () => {
  for (const code of ['git_cli_timeout', 'connector_auth_required']) {
    const f = fixture()
    const source = await f.discover()
    const baseline = await f.collect(source)
    const saved = JSON.stringify(baseline.checkpoint)
    f.fail(code)
    await assert.rejects(f.collect(source, baseline.checkpoint), error => error.code === code)
    assert.equal(JSON.stringify(baseline.checkpoint), saved)
  }
})
