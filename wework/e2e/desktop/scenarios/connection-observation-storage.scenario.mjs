import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createDesktopScenario as createEventScenario } from './conversation-event-wakeup.scenario.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { waitForBundledMarketplaceRegistration } from '../modules/plugin-flows.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'

const PROVIDER = '@test/connection-source/records'

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
  const captured = {
    task_id: 'migration-receipt-task',
    status: 'cancelled',
    observation_id: 'old-0',
    resource_event_keys: ['captured'],
    events: [{ id: 'accepted-before-upgrade' }],
  }
  const snapshot = () => {
    const database = new DatabaseSync(databasePath, { readOnly: true })
    try {
      return database.prepare('SELECT section,id,value,consumers FROM records').all()
    } finally {
      database.close()
    }
  }
  return {
    async prepareApp(context) {
      await base.prepareApp(context)
      codexHome = context.codexHome
      const observations = Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [
          `old-${index}`,
          {
            source: { providerId: PROVIDER, id: `old-${index}` },
            checkpoint: { cursor: 1 },
            sequence: 1,
            events: [
              {
                sequence: 1,
                key: `old-event-${index}`,
                event: { id: `old-event-${index}`, text: 'x'.repeat(900_000) },
              },
            ],
          },
        ])
      )
      legacyBytes = JSON.stringify({
        version: 1,
        operations: { receipt: captured },
        observations,
        observers: {},
      })
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
      const input = { consumerKey: 'storage-regression', generation: 'restart', source }
      const initial = await rpc(control, 'runtime.connections.observers.start', input)
      const sourceId = initial.observation.id
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
      assert.deepEqual(JSON.parse(snapshot().find(row => row.id === 'receipt').value), captured)
      await restartDesktopApp()
      await control.command('ensureLocalModelCatalogReady', 'body', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      const renewed = await rpc(control, 'runtime.connections.observers.renew', input)
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
      assert.deepEqual(JSON.parse(rows.find(row => row.id === 'receipt').value), captured)
      for (const row of rows.filter(row => row.section === 'observers')) {
        const observer = JSON.parse(row.value)
        assert.equal(observer.status, 'stopped')
        assert.equal(observer.initial_checkpoint, undefined)
        assert.equal(observer.resource_states, undefined)
      }
      assert.equal(
        await readFile(legacyPath, 'utf8'),
        legacyBytes,
        'The import must preserve the original recovery snapshot'
      )
      await writeFile(
        join(resultDir, 'connection-observation-storage.json'),
        JSON.stringify({
          importedBytes: legacyBytes.length,
          retiredCollectors: 40,
          repeatedActivations: 12,
          remainingCollectors: 0,
          receiptPreserved: true,
          restartPreservedCheckpoint: true,
        })
      )
    },
  }
}
