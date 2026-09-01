import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from './index.js'

test('prefixes secure values with a validated plugin namespace', async () => {
  const calls = []
  let provided
  const ctx = {
    weworkDesktop: {
      secureStorage: {
        get: async key => calls.push(['get', key]),
        set: async (key, value) => calls.push(['set', key, value]),
        delete: async key => calls.push(['delete', key]),
      },
    },
    reflect: {
      provide(_name, service) {
        provided = service
        return () => undefined
      },
    },
    effect(factory) {
      factory()
    },
  }

  apply(ctx)
  const storage = provided.scope('example-plugin')
  await storage.get('credential')
  await storage.set('credential', 'secret')
  await storage.delete('credential')

  assert.deepEqual(calls, [
    ['get', 'example-plugin.credential'],
    ['set', 'example-plugin.credential', 'secret'],
    ['delete', 'example-plugin.credential'],
  ])
})
