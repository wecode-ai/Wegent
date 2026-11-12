import assert from 'node:assert/strict'
import test from 'node:test'
import { createProvider } from './provider.js'

const SHA = 'a'.repeat(40)
const OLD = new Date(Date.now() - 2 * 3600000).toISOString()
const NEW = new Date(Date.now() - 60000).toISOString()
function fixture(platform, count = 1) {
  const source = {
    providerId: '@wegent/dsh-connection-git/' + platform,
    kind: 'repository',
    id: '42',
    name: 'org/repo',
    transport: 'cli',
    profile: JSON.stringify([`https://${platform}.com`, '7']),
    enabledAfter: new Date(Date.now() - 3600000).toISOString(),
  }
  const state = {
    rows: Array.from({ length: count }, (_, i) => i + 1),
    closed: new Set(),
    repoId: 42,
    check: {
      id: 777,
      head_sha: SHA,
      sha: SHA,
      status: platform === 'github' ? 'completed' : 'success',
      conclusion: 'success',
      completed_at: OLD,
    },
  }
  const calls = []
  const ctx = {
    git: {
      read: async input => {
        calls.push(input)
        assert.equal(input.profile, source.profile)
        assert.equal(input.repository, source.name)
        let data
        if (input.operation === 'repository') data = { id: state.repoId }
        else if (input.operation === 'api' && /^(pulls|merge_requests)\?state=/.test(input.path)) {
          const page = Number(new URLSearchParams(input.path.split('?')[1]).get('page'))
          data = state.rows
            .filter(n => !state.closed.has(n))
            .slice((page - 1) * 100, page * 100)
            .map(n => ({ id: n, number: n, iid: n, updated_at: OLD }))
        } else if (input.operation === 'repository_events') data = []
        else if (input.operation === 'object')
          data = {
            id: input.number,
            number: input.number,
            iid: input.number,
            updated_at: OLD,
            state: state.closed.has(input.number) ? 'closed' : 'open',
            head: { sha: SHA },
            sha: SHA,
          }
        else if (input.operation === 'checks')
          data = platform === 'github' ? { check_runs: [state.check] } : [state.check]
        else data = []
        return { data, profile: source.profile, pollIntervalSeconds: 60 }
      },
    },
  }
  const step = checkpoint =>
    createProvider(platform).collect(ctx, {
      source,
      checkpoint: JSON.parse(JSON.stringify(checkpoint)),
    })
  return { source, state, calls, ctx, step }
}
async function drain(f, checkpoint, done = result => !result.hasMore) {
  const events = []
  for (let i = 0; i < 5000; i++) {
    const result = await f.step(checkpoint)
    events.push(...result.events)
    checkpoint = result.nextCheckpoint
    if (done(result)) return { checkpoint, events }
  }
  assert.fail('Collection failed to make bounded progress')
}

for (const platform of ['github', 'gitlab']) {
  test(
    platform + ' migrates an empty checkpoint into an open-change baseline without old failures',
    async () => {
      const f = fixture(platform)
      f.state.check.conclusion = 'failure'
      if (platform === 'gitlab') f.state.check.status = 'failed'
      const discovered = await f.step({ tracked: {}, seen: {}, activityComplete: false })
      assert.equal(discovered.events.length, 0)
      assert.equal(Object.keys(discovered.nextCheckpoint.tracked).length, 1)
      assert.ok(
        f.calls[1].path.includes(
          platform === 'github' ? 'sort=updated&direction=desc' : 'order_by=updated_at&sort=desc'
        )
      )
      const first = await drain(f, discovered.nextCheckpoint)
      assert.deepEqual(first.events, [])
      assert.equal(Object.values(first.checkpoint.tracked)[0].baseline, undefined)
      f.state.check = {
        ...f.state.check,
        status: platform === 'github' ? 'completed' : 'success',
        conclusion: 'success',
        completed_at: NEW,
      }
      const changed = await drain(f, { ...first.checkpoint, nextCheckAt: 0 })
      const event = changed.events.find(e => e.external.eventType === 'tracked.checks')
      assert.ok(event)
      assert.equal(event.external.headSha, SHA)
      const duplicate = await drain(f, { ...changed.checkpoint, nextCheckAt: 0 })
      assert.deepEqual(duplicate.events, [])
      f.state.check = {
        ...f.state.check,
        conclusion: 'failure',
        status: platform === 'github' ? 'completed' : 'failed',
        completed_at: new Date(Date.now() - 30000).toISOString(),
      }
      const failure = await drain(f, { ...duplicate.checkpoint, nextCheckAt: 0 })
      const failed = failure.events.find(e => e.external.eventType === 'tracked.checks')
      assert.equal(failed.objectId, event.objectId)
      assert.notEqual(failed.version, event.version)
    }
  )

  test(
    platform +
      ' preserves proven new checks while baseline is incomplete and never invents source time',
    async () => {
      for (const timestamp of [NEW, undefined]) {
        const f = fixture(platform)
        const discovered = await f.step({ tracked: {}, seen: {} })
        const object = await f.step(discovered.nextCheckpoint)
        assert.deepEqual(object.events, [])
        f.state.check.completed_at = timestamp
        const checks = await f.step(object.nextCheckpoint)
        assert.equal(checks.events.length, timestamp ? 1 : 0)
        if (timestamp) assert.equal(checks.events[0].at, NEW)
        assert.deepEqual(
          f.calls.map(c => c.operation),
          ['repository', 'api', 'object', 'checks']
        )
        assert.equal(Object.values(checks.nextCheckpoint.tracked)[0].baseline, undefined)
        if (!timestamp) {
          const observedAfter = Date.now()
          f.state.check = {
            ...f.state.check,
            status: platform === 'github' ? 'completed' : 'failed',
            conclusion: 'failure',
          }
          const changed = await drain(f, checks.nextCheckpoint)
          const event = changed.events.find(e => e.external.eventType === 'tracked.checks')
          assert.equal(event.external.timestampBasis, 'observed_change')
          assert.ok(Date.parse(event.at) >= observedAfter)
        }
      }
    }
  )

  test(
    platform +
      ' retains a full discovery page, compares admitted changes and reports coverage recovery',
    async () => {
      const f = fixture(platform, 101)
      const page = await f.step({ tracked: {}, seen: {} })
      assert.equal(page.nextCheckpoint.openChanges.page, 2)
      assert.equal(Object.keys(page.nextCheckpoint.tracked).length, 100)
      const baseline = await drain(
        f,
        page.nextCheckpoint,
        r => r.nextCheckpoint.openChanges.phase === 'discover'
      )
      assert.deepEqual(baseline.events, [])
      const overflow = await f.step(baseline.checkpoint)
      assert.equal(overflow.nextCheckpoint.openChanges.page, 2)
      assert.equal(overflow.nextCheckpoint.openChanges.backlog, true)
      assert.equal(overflow.events[0].eventType, 'git.monitoring_coverage')
      assert.equal(overflow.events[0].external.entityKind, 'monitoring_coverage')
      assert.equal(overflow.events[0].external.coverageStatus, 'limited')
      const before = f.calls.length
      const compared = await drain(
        f,
        overflow.nextCheckpoint,
        r => r.nextCheckpoint.openChanges.phase === 'discover'
      )
      assert.ok(f.calls.slice(before).some(c => c.operation === 'checks'))
      const repeated = await f.step(compared.checkpoint)
      assert.deepEqual(repeated.events, [])
      f.state.closed.add(1)
      const freed = await drain(
        f,
        repeated.nextCheckpoint,
        r => r.nextCheckpoint.openChanges.phase === 'discover'
      )
      const recovery = await drain(f, freed.checkpoint)
      const recovered = recovery.events.find(e => e.external.coverageStatus === 'complete')
      assert.ok(recovered)
      assert.equal(recovered.objectId, overflow.events[0].objectId)
      assert.notEqual(recovered.version, overflow.events[0].version)
      assert.ok(Object.values(recovery.checkpoint.tracked).some(t => t.number === 101))
      assert.ok(Object.keys(recovery.checkpoint.tracked).length <= 100)
      assert.equal(recovery.checkpoint.openChanges.complete, true)
    }
  )

  test(
    platform + ' keeps repository and transient errors from committing discovery progress',
    async () => {
      const f = fixture(platform)
      const checkpoint = { tracked: {}, seen: {} }
      f.state.repoId = 43
      await assert.rejects(f.step(checkpoint), /Repository identity changed/)
      assert.deepEqual(checkpoint, { tracked: {}, seen: {} })
      assert.equal(f.calls.length, 1)
    }
  )
}
