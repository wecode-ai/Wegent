import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createDesktopScenario as createEventScenario } from './conversation-event-wakeup.scenario.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { waitForBundledMarketplaceRegistration } from '../modules/plugin-flows.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'

const PROVIDER = '@test/connection-source/records'

async function verifyStatusSurvivesTimeout(control, resultDir, source, timeoutMs) {
  const input = { consumerKey: 'pr-status-timeout', generation: 'first', source }
  const invoke = (operation, deadline = timeoutMs) =>
    requestExecutor(control, `runtime.connections.observers.${operation}`, input, deadline)
  const status = {
    kind: 'change_request',
    provider: 'github',
    topicId: 'https://github.com/org/repo/pull/17',
    observedAt: new Date().toISOString(),
    data: { statusCheckRollup: { state: 'PENDING' } },
  }
  const setStatus = (stall, observed = status) =>
    writeFile(
      join(resultDir, 'records.json'),
      JSON.stringify([{ id: source.id, value: JSON.stringify({ stall, status: observed }) }])
    )
  await setStatus(false)
  const initial = await invoke('start')
  try {
    assert.equal(initial.observation.errorCode, null)
    assert.deepEqual(initial.observation.resourceStates, [status])
    await setStatus(true)
    const timedOut = await invoke('refresh', 25_000)
    assert.equal(timedOut.observation.errorCode, 'request_timeout')
    assert.equal(timedOut.observation.lastCollectedAt, initial.observation.lastCollectedAt)
    assert.deepEqual(timedOut.observation.resourceStates, [status])

    const updated = { ...status, data: { statusCheckRollup: { state: 'SUCCESS' } } }
    await setStatus(false, updated)
    const recovered = await invoke('refresh')
    assert.equal(recovered.observation.errorCode, null)
    assert.deepEqual(recovered.observation.resourceStates, [updated])
  } finally {
    await invoke('stop')
    await writeFile(
      join(resultDir, 'records.json'),
      JSON.stringify([{ id: 'archive-record', value: '[]' }])
    )
  }
}

/** Real installed provider, executor, SQLite, collection scheduler and desktop restart. */
export function createDesktopScenario(options) {
  const base = createEventScenario(options)
  const { executorHome, resultDir, uiTimeoutMs, restartDesktopApp, workbenchReadyTimeoutMs } =
    options
  const runtime = join(executorHome, 'runtime-work')
  const legacyPath = join(runtime, 'conversation-event-subscriptions.json')
  const databasePath = join(runtime, 'conversation-event-subscriptions.sqlite')
  let codexHome
  let legacyBytes
  const rpc = (control, method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  const snapshot = () => {
    const database = new DatabaseSync(databasePath, { readOnly: true })
    try {
      database.exec('PRAGMA busy_timeout=250')
      return database.prepare('SELECT section,id,value,consumers FROM records').all()
    } finally {
      database.close()
    }
  }
  return {
    async prepareApp(context) {
      await base.prepareApp(context)
      codexHome = context.codexHome
      legacyBytes = '{obsolete JSON is not part of the new store'
      await mkdir(runtime, { recursive: true })
      await writeFile(legacyPath, legacyBytes)
    },
    async verify(control) {
      await waitForBundledMarketplaceRegistration(codexHome)
      await rpc(control, 'runtime.codex.app_server.request', {
        method: 'marketplace/add',
        params: { source: join(resultDir, 'connection-marketplace') },
      })
      await rpc(control, 'runtime.connections.dependencies.install', {
        providerId: PROVIDER,
        aliases: ['source'],
      })
      const resources = await rpc(control, 'runtime.connections.resources', {
        providerId: PROVIDER,
        kind: 'record',
        query: 'archive-record',
      })
      const source = resources.items.find(item => item.id === 'archive-record')
      assert.ok(source)
      const prStatus = resources.items.find(item => item.id === 'pr-status-record')
      assert.ok(prStatus)
      await verifyStatusSurvivesTimeout(control, resultDir, prStatus, uiTimeoutMs)
      const input = { consumerKey: 'storage-regression', generation: 'restart', source }
      const initial = await rpc(control, 'runtime.connections.observers.start', input)
      const sourceId = initial.observation.id
      assert.equal(snapshot().filter(row => row.section === 'operations').length, 0)
      await writeFile(
        join(resultDir, 'records.json'),
        JSON.stringify([
          {
            id: 'archive-record',
            value: JSON.stringify([
              {
                id: 'durable-event',
                eventType: 'message.received',
                text: 'new source event',
                at: new Date().toISOString(),
              },
            ]),
          },
          { id: 'long-archive-record', value: '[]' },
        ])
      )
      await rpc(control, 'runtime.connections.observers.refresh', input)
      const before = JSON.parse(
        snapshot().find(row => row.section === 'observations' && row.id === sourceId).value
      )
      assert.equal(before.checkpoint.cursor, 1)
      assert.equal(before.events.length, 1)
      await restartDesktopApp()
      await control.command('ensureLocalModelCatalogReady', 'body', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      // Model readiness does not establish connection-host readiness after restart.
      // Observe the scheduler's successful collection before checking restored facts.
      const renewed = await waitForValue(
        () => rpc(control, 'runtime.connections.observers.renew', input),
        result => result.observation.errorCode === null,
        'The restored observer did not recover after the connection host restarted',
        workbenchReadyTimeoutMs
      )
      assert.equal(renewed.observation.id, sourceId)
      assert.equal(renewed.observation.errorCode, null)
      const restored = JSON.parse(
        snapshot().find(row => row.section === 'observations' && row.id === sourceId).value
      )
      assert.deepEqual(restored.checkpoint, before.checkpoint)
      assert.deepEqual(restored.events, before.events)
      await rpc(control, 'runtime.connections.observers.stop', input)
      await assert.rejects(
        rpc(control, 'runtime.connections.observers.start', input),
        /lease|activation/i
      )
      for (let generation = 0; generation < 12; generation++) {
        const lease = {
          consumerKey: 'storage-regression',
          generation: `cycle-${generation}`,
          source,
        }
        await rpc(control, 'runtime.connections.observers.start', lease)
        await rpc(control, 'runtime.connections.observers.stop', lease)
      }
      await waitForValue(
        () => snapshot(),
        rows => rows.every(row => row.section !== 'observations'),
        'Retired observation histories were not reclaimed by the real scheduler',
        60_000
      )
      const rows = snapshot()
      for (const row of rows.filter(row => row.section === 'observers')) {
        const observer = JSON.parse(row.value)
        assert.equal(observer.status, 'stopped')
        assert.equal(observer.initial_checkpoint, undefined)
        assert.equal(observer.resource_states, undefined)
      }
      assert.equal(
        await readFile(legacyPath, 'utf8'),
        legacyBytes,
        'Legacy data must remain outside the new store'
      )
      await writeFile(
        join(resultDir, 'connection-observation-storage.json'),
        JSON.stringify({
          legacyIgnored: true,
          repeatedActivations: 12,
          remainingCollectors: 0,
          restartPreservedCheckpoint: true,
        })
      )
    },
  }
}
