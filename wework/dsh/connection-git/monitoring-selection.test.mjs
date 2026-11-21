import assert from 'node:assert/strict'
import test from 'node:test'
import { ConnectionRegistry } from '../plugin-runtime/connections.js'
import { collectObservation } from '../plugin-runtime/connection-observations.js'
import { createProvider } from './provider.js'
import { bindGitProvider } from './runtime-bridge.js'

const HEAD = 'a'.repeat(40)
const OLD = new Date(Date.now() - 2 * 3600000).toISOString()
const NEW = new Date(Date.now() - 1000).toISOString()
function fixture(platform) {
  const profile = JSON.stringify([`https://${platform}.com`, '7'])
  const calls = []
  const state = {
    repoId: 42,
    repository: 'org/repo',
    mismatch: false,
    issueIsPr: false,
    closed: false,
    changed: false,
    queueState: 'QUEUED',
    pipelineSha: HEAD,
    inaccessible: false,
  }
  const ctx = {
    git: {
      read: async input => {
        calls.push(input)
        if (input.operation === 'identity')
          return { profile, login: 'alice', instance: `https://${platform}.com` }
        assert.equal(input.profile, profile)
        assert.equal(input.repository, 'org/repo')
        let data
        if (input.operation === 'repository')
          data = {
            id: state.repoId,
            full_name: state.repository,
            path_with_namespace: state.repository,
          }
        else if (input.operation === 'object') {
          if (state.inaccessible)
            throw Object.assign(new Error('Permission changed'), { code: 'git_permission_denied' })
          data = {
            id: input.number,
            number: state.mismatch ? 999 : input.number,
            iid: state.mismatch ? 999 : input.number,
            ...(state.issueIsPr && input.entityKind === 'issue' ? { pull_request: {} } : {}),
            state: state.closed ? 'closed' : 'open',
            updated_at: state.changed ? NEW : OLD,
            head: { sha: HEAD },
            sha: HEAD,
            head_pipeline: { sha: state.pipelineSha, status: state.changed ? 'failed' : 'success' },
            web_url: `https://${platform}.com/org/repo/${platform === 'github' ? 'pull' : '-/merge_requests'}/${input.number}`,
          }
        } else if (input.operation === 'change_request_status')
          data = {
            number: input.number,
            url: `https://github.com/org/repo/pull/${input.number}`,
            title: 'Observed PR',
            state: state.closed ? 'CLOSED' : 'OPEN',
            headRefOid: HEAD,
            statusCheckRollup: { state: state.changed ? 'FAILURE' : 'SUCCESS' },
            mergeQueueEntry: state.closed ? null : { state: state.queueState },
            ...state.nativeStatus,
          }
        else if (input.operation === 'checks') {
          if (state.checkError) throw state.checkError
          const check = {
            id: 7,
            head_sha: HEAD,
            sha: HEAD,
            status: platform === 'github' ? 'completed' : state.changed ? 'failed' : 'success',
            conclusion: state.changed ? 'failure' : 'success',
            completed_at: state.changed ? NEW : OLD,
          }
          data = platform === 'github' ? { check_runs: [check] } : [check]
        } else if (input.operation === 'comments')
          data = state.changed ? [{ id: 8, body: 'New follow-up', updated_at: NEW }] : []
        else if (input.operation === 'api') data = []
        else assert.fail('Unexpected operation: ' + input.operation)
        return { data, profile }
      },
    },
  }
  const discover = async objects =>
    (
      await createProvider(platform).listResources(ctx, {
        kind: 'repository',
        query: JSON.stringify({
          instance: `https://${platform}.com`,
          repository: 'org/repo',
          monitoredObjects: objects,
        }),
      })
    ).items[0]
  const step = (source, checkpoint) =>
    createProvider(platform).collect(ctx, {
      source,
      checkpoint: JSON.parse(JSON.stringify(checkpoint)),
    })
  return { ctx, calls, state, discover, step }
}
const pr = number => ({ entityKind: 'change_request', number })
const issue = number => ({ entityKind: 'issue', number })
async function drain(f, source, checkpoint) {
  const events = []
  for (let i = 0; i < 50; i++) {
    const result = await f.step(source, checkpoint)
    checkpoint = result.nextCheckpoint
    events.push(...result.events)
    if (!result.hasMore) return { events, checkpoint }
  }
  assert.fail('Selected collection did not finish a bounded cycle')
}

test('GitHub shares complete status and emits merge queue changes even when REST details do not change', async () => {
  const f = fixture('github')
  const source = {
    ...(await f.discover([pr(1)])),
    enabledAfter: new Date(Date.now() - 3600000).toISOString(),
  }
  const baseline = await drain(f, source, {})
  assert.deepEqual(baseline.events, [])
  assert.equal(
    baseline.checkpoint.resourceStates['https://github.com/org/repo/pull/1'].data.mergeQueueEntry
      .state,
    'QUEUED'
  )
  f.state.queueState = 'AWAITING_CHECKS'
  const changed = await drain(f, source, { ...baseline.checkpoint, nextCheckAt: 0 })
  assert.equal(changed.events.length, 1)
  assert.equal(changed.events[0].external.objectKind, 'change_request_state')
  assert.equal(changed.events[0].external.payload.mergeQueueEntry.state, 'AWAITING_CHECKS')
  assert.deepEqual((await drain(f, source, { ...changed.checkpoint, nextCheckAt: 0 })).events, [])
})

test('GitLab keeps a stale pipeline separate from the current merge request head', async () => {
  const f = fixture('gitlab')
  f.state.pipelineSha = 'b'.repeat(40)
  const source = {
    ...(await f.discover([pr(1)])),
    enabledAfter: new Date(Date.now() - 3600000).toISOString(),
  }
  const baseline = await drain(f, source, {})
  const url = 'https://gitlab.com/org/repo/-/merge_requests/1'
  assert.equal(baseline.checkpoint.resourceStates[url].data.head_pipeline, undefined)
  assert.equal(baseline.checkpoint.resourceStates[url].data.observedPipeline.sha, 'b'.repeat(40))
  f.state.changed = true
  const oldFailure = await drain(f, source, { ...baseline.checkpoint, nextCheckAt: 0 })
  assert.equal(oldFailure.checkpoint.resourceStates[url].data.head_pipeline, undefined)
  assert.ok(
    oldFailure.events
      .filter(event => event.external.objectKind === 'change_request_state')
      .every(event => event.external.payload.conclusion === '')
  )
  f.state.pipelineSha = HEAD
  const currentFailure = await drain(f, source, { ...oldFailure.checkpoint, nextCheckAt: 0 })
  assert.equal(currentFailure.checkpoint.resourceStates[url].data.head_pipeline.status, 'failed')
  assert.ok(
    currentFailure.events.some(
      event =>
        event.external.objectKind === 'change_request_state' &&
        event.external.payload.conclusion === 'failed'
    )
  )
})

test('permission loss keeps the last resource snapshot explicitly unavailable instead of healthy', async () => {
  const f = fixture('github')
  const source = {
    ...(await f.discover([pr(1)])),
    enabledAfter: new Date(Date.now() - 3600000).toISOString(),
  }
  const baseline = await drain(f, source, {})
  f.state.inaccessible = true
  const lost = await f.step(source, { ...baseline.checkpoint, nextCheckAt: 0 })
  assert.equal(lost.resourceStates[0].errorCode, 'git_permission_denied')
  assert.deepEqual(
    lost.resourceStates[0].data,
    baseline.checkpoint.resourceStates[lost.resourceStates[0].topicId].data
  )
})

for (const platform of ['github', 'gitlab']) {
  test(
    platform +
      ' discovers canonical monitoring metadata after exact repository/object verification',
    async () => {
      const f = fixture(platform)
      const source = await f.discover([issue(2), pr(1), issue(2)])
      assert.deepEqual(source.monitoredObjects, [pr(1), issue(2)])
      assert.match(source.collectionKey, /^git-monitor:v1:[a-f0-9]{64}$/)
      assert.ok(source.configurationSummary.includes(platform === 'github' ? '#1' : '!1'))
      assert.ok(source.configurationSummary.includes('#2'))
      assert.deepEqual(
        f.calls.map(c => c.operation),
        ['identity', 'repository', 'object', 'object']
      )
      const reordered = await f.discover([pr(1), issue(2)])
      assert.equal(reordered.collectionKey, source.collectionKey)
      assert.equal(reordered.configurationSummary, source.configurationSummary)
      f.state.repository = 'foreign/repo'
      await assert.rejects(f.discover([pr(1)]), /Repository discovery identity changed/)
      f.state.repository = 'org/repo'
      f.state.mismatch = true
      await assert.rejects(f.discover([pr(1)]), /Selected object does not match/)
      if (platform === 'github') {
        f.state.mismatch = false
        f.state.issueIsPr = true
        await assert.rejects(f.discover([issue(1)]), /object kind/)
      }
    }
  )

  test(
    platform +
      ' validates opaque metadata, keeps read authority unchanged and clears an old selection checkpoint',
    async () => {
      const f = fixture(platform)
      const source = {
        ...(await f.discover([pr(1)])),
        enabledAfter: new Date(Date.now() - 3600000).toISOString(),
      }
      const provider = createProvider(platform)
      for (const patch of [
        { collectionKey: 'forged' },
        { configurationSummary: 'Monitor all objects' },
        { monitoredObjects: [pr(2)] },
      ])
        await assert.rejects(provider.validate(f.ctx, { ...source, ...patch }), /not canonical/)
      for (const objects of [[], [pr(0)], [pr(1.5)], [{ entityKind: 'all', number: 1 }]])
        await assert.rejects(f.discover(objects), /Select/)
      await provider.validate(f.ctx, {
        ...source,
        monitoredObjects: [{ number: 1, entityKind: 'change_request' }],
      })
      const beforeForeign = f.calls.length
      await assert.rejects(
        f.step(source, {
          selectionSignature: source.collectionKey,
          tracked: {
            foreign: {
              ...pr(1),
              repository: 'foreign/repo',
              url: 'https://github.com/foreign/repo/pull/1',
            },
          },
        }),
        /unselected object/
      )
      assert.equal(f.calls.length, beforeForeign)
      const read = await provider.readSource(f.ctx, {
        source,
        query: { entityKind: 'change_request', number: 99, view: 'details' },
      })
      assert.equal(read.items[0].data.number, 99)
      const result = await f.step(source, {
        selectionSignature: 'old',
        tracked: { foreign: { repository: 'org/repo', ...pr(99) } },
        seen: {},
      })
      assert.equal(result.nextCheckpoint.selectionSignature, source.collectionKey)
      assert.deepEqual(
        Object.values(result.nextCheckpoint.tracked).map(t => t.number),
        [1]
      )
      const before = f.calls.length
      f.state.repoId = 43
      await assert.rejects(
        f.step(source, { selectionSignature: 'old' }),
        /Repository identity changed/
      )
      assert.equal(f.calls.length, before + 1)
    }
  )

  test(
    platform +
      ' compares only selected objects and retains a closed object through reopen and new versions',
    async () => {
      const f = fixture(platform)
      const source = {
        ...(await f.discover([pr(1), issue(2)])),
        enabledAfter: new Date(Date.now() - 3600000).toISOString(),
      }
      f.calls.length = 0
      f.state.closed = true
      const first = await drain(f, source, {})
      assert.deepEqual(first.events, [])
      assert.equal(Object.keys(first.checkpoint.tracked).length, 2)
      assert.ok(Object.values(first.checkpoint.tracked).every(t => !t.baseline && t.finished))
      assert.ok(f.calls.every(c => c.operation === 'repository' || [1, 2].includes(c.number)))
      assert.ok(
        !f.calls.some(c => c.operation === 'repository_events' || c.path?.includes('?state='))
      )
      f.state.closed = false
      f.state.changed = true
      const reopened = await drain(f, source, { ...first.checkpoint, nextCheckAt: 0 })
      assert.ok(reopened.events.some(e => e.external.eventType === 'tracked.checks'))
      assert.ok(reopened.events.some(e => e.external.eventType === 'tracked.comments'))
      assert.ok(Object.values(reopened.checkpoint.tracked).every(t => !t.finished && !t.baseline))
      const duplicate = await drain(f, source, { ...reopened.checkpoint, nextCheckAt: 0 })
      assert.deepEqual(duplicate.events, [])
      const changedSource = { ...source, ...(await f.discover([issue(2)])) }
      const narrowed = await f.step(changedSource, reopened.checkpoint)
      assert.deepEqual(
        Object.values(narrowed.nextCheckpoint.tracked).map(t => t.number),
        [2]
      )
    }
  )
}

test('GitHub aggregate merge status remains distinct from each successful check', async () => {
  const f = fixture('github')
  f.state.nativeStatus = {
    isDraft: false,
    mergeable: 'CONFLICTING',
    mergeStateStatus: 'DIRTY',
    statusCheckRollup: { state: 'PENDING' },
  }
  const source = {
    ...(await f.discover([pr(1)])),
    enabledAfter: new Date(Date.now() - 3600000).toISOString(),
  }
  const url = 'https://github.com/org/repo/pull/1'
  const baseline = await drain(f, source, {})
  assert.deepEqual(baseline.events, [])
  let checkpoint = baseline.checkpoint
  for (const stage of [
    { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', checks: 'SUCCESS' },
    { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', checks: 'SUCCESS' },
    { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', checks: 'SUCCESS' },
  ]) {
    f.state.nativeStatus = {
      isDraft: false,
      mergeable: stage.mergeable,
      mergeStateStatus: stage.mergeStateStatus,
      statusCheckRollup: { state: stage.checks },
    }
    const result = await drain(f, source, { ...checkpoint, nextCheckAt: 0 })
    checkpoint = result.checkpoint
    const aggregate = result.events.filter(event => event.external.eventType === 'tracked.status')
    assert.equal(aggregate.length, 1)
    assert.equal(aggregate[0].topicId, url)
    assert.equal(aggregate[0].external.headSha, HEAD)
    assert.deepEqual(aggregate[0].external.payload, {
      ...checkpoint.resourceStates[url].data,
      conclusion: 'success',
    })
    assert.equal(aggregate[0].external.payload.mergeStateStatus, stage.mergeStateStatus)
  }
  assert.deepEqual((await drain(f, source, { ...checkpoint, nextCheckAt: 0 })).events, [])
})

test('PR waits observe a failure already present at activation and on later polls', async t => {
  const f = fixture('github')
  f.state.nativeStatus = { statusCheckRollup: { state: 'FAILURE' } }
  const providerId = '@wegent/dsh-connection-git/github'
  const registry = new ConnectionRegistry({
    inventory: async () => [],
    satisfies: () => true,
    context: identity => identity,
  })
  t.after(
    await registry.register({ effect() {} }, new URL('./package.json', import.meta.url), {
      github: bindGitProvider(providerId, createProvider('github'), (method, input) => {
        assert.equal(method, 'runtime.connections.git.read')
        return f.ctx.git.read(input)
      }),
      gitlab: createProvider('gitlab'),
    })
  )
  const source = {
    ...(await f.discover([pr(1)])),
    providerId,
    enabledAfter: new Date().toISOString(),
  }
  const collect = (source, checkpoint) =>
    collectObservation(registry, source.providerId, { source, checkpoint })
  const waitSource = { ...source, observeCurrentStatus: true }
  f.calls.length = 0
  const first = await collect(waitSource, {})
  assert.deepEqual(
    f.calls.map(call => call.operation),
    ['change_request_status']
  )
  assert.equal(f.calls[0].repositoryId, source.id)
  const firstStatus = first.events.find(event => event.external.eventType === 'tracked.status')
  assert.equal(firstStatus?.external.payload.statusCheckRollup.state, 'FAILURE')
  assert.equal(firstStatus.external.payload.headRefOid, HEAD)
  assert.ok(Date.parse(firstStatus.at) >= Date.parse(source.enabledAfter))

  const second = await collect(waitSource, { ...first.nextCheckpoint, nextCheckAt: 0 })
  const secondStatus = second.events.find(event => event.external.eventType === 'tracked.status')
  assert.equal(secondStatus?.external.payload.statusCheckRollup.state, 'FAILURE')
  assert.equal(secondStatus.objectId, firstStatus.objectId)
  assert.notEqual(secondStatus.version, firstStatus.version)

  const historical = await collect(source, {})
  assert.equal(
    historical.events.some(event => event.external.eventType === 'tracked.status'),
    false
  )
})

test('a pending PR refreshes its aggregate after 15 seconds and emits the terminal status', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const f = fixture('github')
  f.state.nativeStatus = { statusCheckRollup: { state: 'PENDING' } }
  const provider = createProvider('github')
  const registry = { call: (_id, operation, input) => provider[operation](f.ctx, input) }
  const source = { ...(await f.discover([pr(1)])), observeCurrentStatus: true }
  const collect = checkpoint =>
    collectObservation(registry, source.providerId, { source, checkpoint })
  const startedAt = Date.now()
  const pending = await collect({})
  assert.equal(pending.nextPollAt, startedAt)
  assert.equal(pending.resourceStates[0].data.statusCheckRollup.state, 'PENDING')
  t.mock.timers.tick(1_000)
  const checks = await collect(pending.nextCheckpoint)
  assert.equal(f.calls.at(-1).operation, 'checks')
  assert.equal(checks.nextPollAt, startedAt + 15_000)

  t.mock.timers.tick(13_999)
  const early = await collect(checks.nextCheckpoint)
  assert.deepEqual(early.events, [])
  t.mock.timers.tick(1)
  const stillPending = await collect(early.nextCheckpoint)
  assert.equal(stillPending.resourceStates[0].data.statusCheckRollup.state, 'PENDING')
  assert.equal(stillPending.nextPollAt, startedAt + 30_000)
  assert.equal(stillPending.nextCheckpoint.pendingStatusChecks, false)

  f.state.nativeStatus.statusCheckRollup.state = 'SUCCESS'
  const done = await collect(early.nextCheckpoint)
  assert.equal(f.calls.at(-1).operation, 'change_request_status')
  assert.equal(done.resourceStates[0].data.statusCheckRollup.state, 'SUCCESS')
  assert.equal(done.events[0].external.eventType, 'tracked.status')
  assert.equal(done.events[0].external.payload.statusCheckRollup.state, 'SUCCESS')
  assert.equal(done.nextPollAt, undefined)
  assert.equal(done.nextCheckpoint.nextCheckAt, Date.now() + 60_000)
})

test('a later check timeout leaves the committed PR status readable', async () => {
  const f = fixture('github')
  f.state.changed = true
  f.state.nativeStatus = { statusCheckRollup: { state: 'PENDING' } }
  const source = {
    ...(await f.discover([pr(1)])),
    observeCurrentStatus: true,
    enabledAfter: OLD,
  }
  f.calls.length = 0
  const status = await f.step(source, {})
  assert.equal(status.hasMore, false)
  assert.equal(status.events[0].external.eventType, 'tracked.status')
  assert.equal(status.resourceStates[0].data.statusCheckRollup.state, 'PENDING')
  assert.deepEqual(
    f.calls.map(call => call.operation),
    ['change_request_status']
  )

  f.state.checkError = Object.assign(new Error('Timed out'), { code: 'request_timeout' })
  await assert.rejects(f.step(source, status.nextCheckpoint), { code: 'request_timeout' })
  assert.equal(
    status.nextCheckpoint.resourceStates[status.resourceStates[0].topicId].data.headRefOid,
    HEAD
  )

  delete f.state.checkError
  const checks = await f.step(source, status.nextCheckpoint)
  assert.equal(checks.hasMore, false)
  assert.equal(checks.events[0].external.eventType, 'tracked.checks')
  assert.equal(checks.events[0].external.payload.conclusion, 'failure')
  assert.deepEqual(
    f.calls.map(call => call.operation),
    ['change_request_status', 'checks', 'checks']
  )
  assert.equal(f.calls[2].repositoryId, source.id)

  const overdue = structuredClone(status.nextCheckpoint)
  overdue.resourceStates[status.resourceStates[0].topicId].observedAt = OLD
  f.state.checkError = Object.assign(new Error('Timed out'), { code: 'request_timeout' })
  f.state.nativeStatus.statusCheckRollup.state = 'SUCCESS'
  const refreshed = await f.step(source, overdue)
  assert.equal(f.calls.at(-1).operation, 'change_request_status')
  assert.equal(refreshed.resourceStates[0].data.statusCheckRollup.state, 'SUCCESS')
})
