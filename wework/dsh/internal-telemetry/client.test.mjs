import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

test('waits for a ready host before registering the telemetry sink', async () => {
  const client = await loadClient()
  const ready = deferred()
  const runtime = createRuntime({ ready: ready.promise })

  client.apply(runtime.context)
  assert.equal(runtime.sinks.length, 0)

  ready.resolve({
    enabled: true,
    protocol: 'telemetry-sink/v1',
    catalogVersion: 1,
  })
  await settle()

  assert.equal(runtime.sinks.length, 1)
  assert.equal(runtime.sinks[0].id, 'wegent-internal-telemetry')
  assert.equal(runtime.sinks[0].protocol, 'telemetry-sink/v1')
  assert.equal(typeof runtime.sinks[0].accept, 'function')
  assert.equal(JSON.stringify(runtime.calls), JSON.stringify([['ready', {}]]))
})

test('does not register when the host is disabled, incompatible, or unavailable', async () => {
  for (const readyResult of [
    { enabled: false, protocol: 'telemetry-sink/v1', catalogVersion: 1 },
    { enabled: true, protocol: 'other', catalogVersion: 1 },
    { enabled: true, protocol: 'telemetry-sink/v1', catalogVersion: 2 },
  ]) {
    const client = await loadClient()
    const runtime = createRuntime({ ready: Promise.resolve(readyResult) })
    client.apply(runtime.context)
    await settle()
    assert.equal(runtime.sinks.length, 0)
  }

  const unavailableClient = await loadClient()
  const unavailableRuntime = createRuntime({
    ready: Promise.reject(new Error('backend is unavailable')),
  })
  unavailableClient.apply(unavailableRuntime.context)
  await settle()
  assert.equal(unavailableRuntime.sinks.length, 0)
})

test('unregisters with its owner lifecycle and does not duplicate registrations', async () => {
  const client = await loadClient()
  const runtime = createRuntime({
    ready: Promise.resolve({
      enabled: true,
      protocol: 'telemetry-sink/v1',
      catalogVersion: 1,
    }),
  })

  client.apply(runtime.context)
  client.apply(runtime.context)
  await settle()
  assert.equal(runtime.sinks.length, 1)

  for (const cleanup of runtime.cleanups.splice(0).reverse()) cleanup()
  assert.equal(runtime.sinks.length, 0)
})

test('forwards accepted envelopes without leaking backend failures to the application', async () => {
  const client = await loadClient()
  const envelope = {
    eventId: '110ec58a-a0f2-4ac4-8393-c866d813b8d1',
    name: 'smart_app_opened',
  }
  const runtime = createRuntime({
    accept: () => Promise.reject(new Error('network failure')),
    ready: Promise.resolve({
      enabled: true,
      protocol: 'telemetry-sink/v1',
      catalogVersion: 1,
    }),
  })

  client.apply(runtime.context)
  await settle()

  assert.doesNotThrow(() => runtime.sinks[0].accept(envelope))
  await settle()
  assert.equal(
    JSON.stringify(runtime.calls),
    JSON.stringify([
      ['ready', {}],
      ['accept', { envelope }],
    ])
  )
})

test('forwards the connected cloud email prefix without exposing the full email', async () => {
  const client = await loadClient({
    'wework.cloudConnection': JSON.stringify({
      user: { email: 'cloud-user@example.com', id: 42, user_name: 'cloud-user' },
    }),
  })
  const envelope = {
    eventId: '110ec58a-a0f2-4ac4-8393-c866d813b8d1',
    name: 'smart_app_opened',
  }
  const runtime = createRuntime({
    ready: Promise.resolve({
      enabled: true,
      protocol: 'telemetry-sink/v1',
      catalogVersion: 1,
    }),
  })

  client.apply(runtime.context)
  await settle()
  runtime.sinks[0].accept(envelope)
  await settle()

  assert.equal(
    JSON.stringify(runtime.calls),
    JSON.stringify([
      ['ready', {}],
      ['accept', { envelope, identity: { emailPrefix: 'cloud-user' } }],
    ])
  )
})

test('adds the active smart app tab name when the envelope has no app context', async () => {
  const client = await loadClient({
    location: { pathname: '/wework/app/app/harness-research-desk' },
    activeSmartAppName: 'Research Desk',
  })
  const envelope = {
    eventId: '110ec58a-a0f2-4ac4-8393-c866d813b8d1',
    name: 'smart_app_opened',
    properties: { domain: 'smart_app' },
  }
  const runtime = createRuntime({
    ready: Promise.resolve({
      enabled: true,
      protocol: 'telemetry-sink/v1',
      catalogVersion: 1,
    }),
  })

  client.apply(runtime.context)
  await settle()
  runtime.sinks[0].accept(envelope)
  await settle()

  assert.equal(
    JSON.stringify(runtime.calls[1]),
    JSON.stringify([
      'accept',
      {
        envelope: {
          ...envelope,
          properties: {
            ...envelope.properties,
            smart_app_name: 'Research Desk',
          },
        },
      },
    ])
  )
})

async function loadClient(localStorageValues = {}) {
  const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')
  let registration
  const location = localStorageValues.location ?? { pathname: '/' }
  const activeSmartAppName = localStorageValues.activeSmartAppName ?? null
  vm.runInNewContext(source, {
    Promise,
    window: {
      location,
      document: {
        querySelector(selector) {
          if (selector !== 'button[role="tab"][aria-selected="true"][data-tab-kind="auxiliary"]') {
            return null
          }
          return activeSmartAppName
            ? {
                getAttribute(name) {
                  return name === 'title' ? activeSmartAppName : null
                },
              }
            : null
        },
      },
      localStorage: {
        getItem(key) {
          return localStorageValues[key] ?? null
        },
      },
      __ModuleLoader__: {
        load(value) {
          registration = value
        },
      },
    },
  })
  assert.ok(registration)
  assert.equal(registration.id, '@wegent/dsh-internal-telemetry')
  return registration.factory()
}

function createRuntime({ ready, accept = Promise.resolve({ accepted: true }) }) {
  const calls = []
  const cleanups = []
  const sinks = []
  const backend = {
    request(method, params) {
      calls.push([method, params])
      if (method === 'ready') return ready
      if (method === 'accept') return typeof accept === 'function' ? accept() : accept
      throw new Error(`unexpected method: ${method}`)
    },
  }
  const context = {
    effect(factory) {
      const cleanup = factory()
      cleanups.push(cleanup)
      return cleanup
    },
    wework: {
      backend: {
        scope(id) {
          assert.equal(id, 'wework-internal-telemetry')
          return backend
        },
      },
      telemetry: {
        sinks: {
          register(_owner, sink) {
            if (sinks.some(entry => entry.id === sink.id)) {
              throw new Error('telemetry sink already registered')
            }
            sinks.push(sink)
            return () => {
              const index = sinks.indexOf(sink)
              if (index >= 0) sinks.splice(index, 1)
            }
          },
        },
      },
    },
  }
  return { calls, cleanups, context, sinks }
}

function deferred() {
  let resolve
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve))
}
