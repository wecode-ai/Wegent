import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

test('loads the default-disabled runtime setting and applies explicit changes', async () => {
  const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')
  let handoff
  const window = {
    __ModuleLoader__: {
      load(value) {
        handoff = value
      },
    },
  }
  vm.runInNewContext(source, { URLSearchParams, window, setInterval, clearInterval })
  assert.ok(handoff)

  const plugin = handoff.factory()
  const backendRequests = []
  const registrations = []
  let configurationDefinition
  let configured = { enabled: true }
  let runtimeEnabled = false
  const ctx = {
    wework: {
      backend: {
        scope(id) {
          assert.equal(id, 'wework-transcript-sync')
          return {
            async request(method, params) {
              backendRequests.push({ method, params })
              if (method === 'getSettings') return { enabled: runtimeEnabled }
              if (method === 'getStatus') {
                return {
                  configured: true,
                  enabled: runtimeEnabled,
                  pendingTurns: 1,
                  transcripts: 28,
                  syncing: false,
                  lastError: runtimeEnabled ? 'Not Found' : null,
                  lastAttemptAt: '2026-09-09T17:41:48.000Z',
                  lastSuccessAt: null,
                }
              }
              if (method === 'flush') {
                return {
                  configured: true,
                  enabled: true,
                  pendingTurns: 0,
                  transcripts: 29,
                  syncing: false,
                  lastError: null,
                  lastAttemptAt: '2026-09-09T17:45:00.000Z',
                  lastSuccessAt: '2026-09-09T17:45:01.000Z',
                }
              }
              if (method === 'setEnabled') {
                runtimeEnabled = params.enabled
                return { enabled: runtimeEnabled }
              }
              throw new Error(`Unexpected backend method: ${method}`)
            },
          }
        },
      },
      configuration: {
        get() {
          return { ...configurationDefinition.defaults, ...configured }
        },
        register(_owner, definition) {
          configurationDefinition = definition
          return () => {}
        },
        update(_id, patch) {
          configured = { ...configured, ...patch }
          return configured
        },
      },
      contributions: {
        register(_owner, slot, descriptor) {
          registrations.push({ descriptor, options: { id: descriptor.id, name: slot } })
          return () => {}
        },
      },
      localization: {
        translate(messages) {
          return messages['zh-CN']
        },
      },
    },
  }

  plugin.apply(ctx)
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(configurationDefinition.defaults.enabled, false)
  assert.equal(backendRequests[0].method, 'getSettings')
  assert.equal(configured.enabled, false)
  const registration = registrations.find(
    entry => entry.descriptor?.id === 'wework-transcript-sync'
  )
  assert.equal(registration?.options.name, 'wework.settings.section')
  const descriptor = registration?.descriptor
  assert.equal(descriptor?.page, 'connections')
  assert.equal(descriptor?.experimental, true)
  assert.equal(descriptor?.module, 'plugins/wework-ui-transcript-sync-settings.js')

  const { store } = descriptor
  const snapshots = []
  const unsubscribe = store.subscribe(snapshot => snapshots.push(snapshot))
  await store.refreshStatus()
  unsubscribe()
  assert.ok(snapshots.some(snapshot => snapshot.statusRefreshing))
  assert.ok(snapshots.every(snapshot => !snapshot.statusPending))

  const disabled = store.getSnapshot()
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.pending, false)
  assert.ok(disabled.status)
  assert.equal(disabled.status.lastError, null)

  await store.setEnabled(true)
  assert.equal(configured.enabled, true)
  assert.equal(store.getSnapshot().enabled, true)
  assert.equal(store.getSnapshot().status.lastError, 'Not Found')
  assert.equal(backendRequests.at(-2).method, 'setEnabled')
  assert.equal(backendRequests.at(-2).params.enabled, true)
  assert.equal(backendRequests.at(-1).method, 'getStatus')

  await store.retry()
  assert.equal(store.getSnapshot().status.lastError, null)
  assert.equal(backendRequests.at(-1).method, 'flush')

  await store.setEnabled(false)
  assert.equal(configured.enabled, false)
  assert.equal(store.getSnapshot().enabled, false)
  assert.equal(backendRequests.at(-2).method, 'setEnabled')
  assert.equal(backendRequests.at(-2).params.enabled, false)
  assert.equal(backendRequests.at(-1).method, 'getStatus')
})
