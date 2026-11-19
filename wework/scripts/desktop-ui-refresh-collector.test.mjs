import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  DesktopUiRefreshCollector,
  assertUiRefreshBudgets,
} from '../e2e/desktop/ui-refresh-collector.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'wework-ui-refresh-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const token = {
    captureId: 'capture',
    rendererInstanceId: 'renderer',
    regionNames: ['sidebar'],
    renderIds: ['desktop-sidebar', 'unavailable'],
  }
  const snapshot = {
    version: 1,
    captureId: token.captureId,
    rendererInstanceId: token.rendererInstanceId,
    durationMs: 10,
    reactCommits: null,
    renders: { 'desktop-sidebar': 1, unavailable: null },
    regions: {
      sidebar: {
        selector: '#sidebar',
        observed: true,
        initialMatches: 1,
        finalMatches: 1,
        mutationBatches: 2,
        mutationRecords: 3,
        attributeChanges: 1,
        textChanges: 0,
        addedNodes: 1,
        removedNodes: 1,
        rootRemovals: 1,
        addedSubtreeElements: 0,
        removedSubtreeElements: 0,
        maxAddedSubtreeElements: 200,
        maxRemovedSubtreeElements: 200,
      },
    },
  }
  const calls = []
  const control = {
    activeControlClientId: 'initial-client',
    command: async (action, selector) => {
      calls.push([action, selector])
      return JSON.stringify(action === 'startUiRefreshCapture' ? token : snapshot)
    },
    commandForClient: async (clientId, ...args) => {
      assert.equal(clientId, 'initial-client')
      return control.command(...args)
    },
  }
  const collector = new DesktopUiRefreshCollector(control, root)
  return { collector, snapshot, calls, control }
}

test('records one window spanning multiple operations and persists numeric evidence', async t => {
  const { collector, calls, control } = fixture(t)
  const operations = []
  const result = await collector.measure('send-and-open', {}, async () => {
    operations.push('send')
    await Promise.resolve()
    operations.push('open')
    control.activeControlClientId = 'another-window'
  })
  assert.deepEqual(operations, ['send', 'open'])
  assert.deepEqual(calls, [
    ['startUiRefreshCapture', 'body'],
    ['stopUiRefreshCapture', 'body'],
  ])
  assert.equal(result.label, 'send-and-open')
  assert.equal(result.regions.sidebar.mutationBatches, 2)
  assert.deepEqual(JSON.parse(readFileSync(collector.path, 'utf8')), result)
  collector.assertWithin(result, {
    regions: { sidebar: { mutationBatches: 2 } },
    renders: { 'desktop-sidebar': 1 },
  })
  assert.throws(
    () => collector.assertWithin(result, { regions: { sidebar: { mutationBatches: 1 } } }),
    /observed 2, budget 1/
  )
  assert.throws(
    () =>
      collector.assertWithin(result, { regions: { sidebar: { maxRemovedSubtreeElements: 10 } } }),
    /observed 200, budget 10/
  )
})

test('unavailable counters, missing selectors and misspelled budgets cannot pass as zero', t => {
  const { snapshot } = fixture(t)
  const result = { ...snapshot, complete: true, actionSucceeded: true }
  assert.throws(
    () => assertUiRefreshBudgets(result, { renders: { unavailable: 0 } }),
    /unavailable/
  )
  assert.throws(() => assertUiRefreshBudgets(result, { reactCommits: 0 }), /unavailable/)
  assert.throws(
    () => assertUiRefreshBudgets(result, { regions: { missing: { mutationBatches: 0 } } }),
    /Unknown UI refresh region/
  )
  assert.throws(
    () => assertUiRefreshBudgets(result, { regions: { sidebar: { mutationsBatches: 2 } } }),
    /Unknown UI refresh metric/
  )
  assert.throws(() => assertUiRefreshBudgets(result, { render: {} }), /Unknown UI refresh budget/)
  assert.throws(() => assertUiRefreshBudgets(result, {}), /At least one/)
  result.regions.sidebar.observed = false
  result.regions.sidebar.mutationBatches = 0
  assert.throws(
    () => assertUiRefreshBudgets(result, { regions: { sidebar: { mutationBatches: 0 } } }),
    /never observed/
  )
  assertUiRefreshBudgets(result, {
    regions: { sidebar: { mutationBatches: 0, allowAbsent: true } },
  })
})

test('retains evidence when the operation fails and rethrows its original failure', async t => {
  const { collector } = fixture(t)
  const failure = new Error('injected operation failure')
  await assert.rejects(
    collector.measure('failed-operation', {}, async () => {
      throw failure
    }),
    error => error === failure
  )
  const evidence = JSON.parse(readFileSync(collector.path, 'utf8'))
  assert.equal(evidence.complete, true)
  assert.equal(evidence.actionSucceeded, false)
  assert.throws(
    () => collector.assertWithin(evidence, { renders: { 'desktop-sidebar': 10 } }),
    /operation did not complete/
  )
})

test('a reloaded renderer or missing counters produce incomplete evidence and fail', async t => {
  const { collector, snapshot } = fixture(t)
  snapshot.rendererInstanceId = 'reloaded'
  await assert.rejects(
    collector.measure('reload', {}, async () => {}),
    /renderer changed/
  )
  assert.equal(JSON.parse(readFileSync(collector.path, 'utf8')).complete, false)
  snapshot.rendererInstanceId = 'renderer'
  delete snapshot.regions.sidebar.mutationRecords
  await assert.rejects(
    collector.measure('missing-data', {}, async () => {}),
    /Missing UI refresh counter/
  )
})

test('preserves both operation and collection failures', async t => {
  const { collector, control } = fixture(t)
  const original = control.command
  const operationFailure = new Error('operation failure')
  const collectionFailure = new Error('renderer disconnected')
  control.command = async (...args) => {
    if (args[0] === 'stopUiRefreshCapture') throw collectionFailure
    return original(...args)
  }
  await assert.rejects(
    collector.measure('both-failed', {}, async () => {
      throw operationFailure
    }),
    error => {
      assert.ok(error instanceof AggregateError)
      assert.deepEqual(error.errors, [operationFailure, collectionFailure])
      return true
    }
  )
})

test('subtree element budgets reject excessive replacement and unavailable counters', () => {
  const snapshot = {
    complete: true,
    actionSucceeded: true,
    version: 1,
    regions: { sidebar: { observed: true, addedSubtreeElements: 3, removedSubtreeElements: 4 } },
  }
  assert.doesNotThrow(() =>
    assertUiRefreshBudgets(snapshot, {
      regions: { sidebar: { addedSubtreeElements: 3, removedSubtreeElements: 4 } },
    })
  )
  assert.throws(
    () =>
      assertUiRefreshBudgets(snapshot, {
        regions: { sidebar: { removedSubtreeElements: 3 } },
      }),
    /observed 4, budget 3/
  )
  delete snapshot.regions.sidebar.removedSubtreeElements
  assert.throws(
    () =>
      assertUiRefreshBudgets(snapshot, {
        regions: { sidebar: { removedSubtreeElements: 4 } },
      }),
    /measurement is unavailable/
  )
})

test('responsiveness budgets reject a measured stall and unsupported zero counters', t => {
  const { snapshot } = fixture(t)
  snapshot.complete = true
  snapshot.actionSucceeded = true
  snapshot.responsiveness = { supportedEntryTypes: ['longtask'], longTaskMaxMs: 7577 }
  assert.throws(
    () => assertUiRefreshBudgets(snapshot, { responsiveness: { longTaskMaxMs: 1000 } }),
    /observed 7577, budget 1000/
  )
  snapshot.responsiveness = { supportedEntryTypes: [], longTaskMaxMs: 0 }
  assert.throws(
    () => assertUiRefreshBudgets(snapshot, { responsiveness: { longTaskMaxMs: 1000 } }),
    /measurement unavailable/
  )
})
