import assert from 'node:assert/strict'
import test from 'node:test'

test('reads a safe smart app identity from an installed-app registry entry', async () => {
  const module = await import('./smart-app-registry.js').catch(() => null)

  assert.ok(module)
  const registry = module.createSmartAppRegistry({
    dshHome: '/tmp/wework/dsh-core',
    read: async path => {
      assert.equal(path, '/tmp/wework/harness-apps/installations.json')
      return JSON.stringify([
        {
          id: 'research-desk',
          source: 'managed',
          manifest: {
            name: 'research-desk',
            displayName: 'Research Desk',
            version: '1.2.3',
          },
        },
      ])
    },
  })

  assert.deepEqual(await registry.find('research-desk'), {
    key: 'research-desk',
    name: 'Research Desk',
    version: '1.2.3',
    source: 'managed',
  })
})
