import assert from 'node:assert/strict'
import test from 'node:test'
import { createProvider } from './provider.js'

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
        else if (input.operation === 'object')
          data = {
            id: input.number,
            number: state.mismatch ? 999 : input.number,
            iid: state.mismatch ? 999 : input.number,
            ...(state.issueIsPr && input.entityKind === 'issue' ? { pull_request: {} } : {}),
            state: state.closed ? 'closed' : 'open',
            updated_at: state.changed ? NEW : OLD,
            head: { sha: HEAD },
            sha: HEAD,
          }
        else if (input.operation === 'checks') {
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
