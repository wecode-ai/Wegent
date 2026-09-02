import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from './index.js'

test('leases scoped request header rules and removes them with the owner context', async () => {
  const calls = []
  let ownerCleanup
  let provided
  const ctx = {
    weworkDesktop: {
      browser: {
        setRequestHeaderRule: async rule => calls.push(['set', rule]),
        removeRequestHeaderRule: async id => calls.push(['remove', id]),
        createBackgroundPage: async id => calls.push(['create-page', id]),
        navigateBackgroundPage: async (id, url) => ({ id, url }),
        setBackgroundPageUserAgent: async (id, userAgent) => ({ id, userAgent }),
        backgroundPageState: async id => ({ id, url: 'https://example.test/' }),
        closeBackgroundPage: async id => calls.push(['close-page', id]),
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
  const owner = {
    effect(factory) {
      ownerCleanup = factory()
    },
  }

  apply(ctx)
  const lease = await provided.requestHeaders.register(owner, {
    origins: ['https://auth.example.test'],
    pathPrefixes: ['/login'],
    headers: { Authorization: 'Bearer first' },
  })
  await lease.update({
    origins: ['https://auth.example.test'],
    pathPrefixes: ['/login'],
    headers: { Authorization: 'Bearer second' },
  })
  await ownerCleanup()

  assert.equal(calls[0][0], 'set')
  assert.equal(calls[0][1].headers.Authorization, 'Bearer first')
  assert.equal(calls[1][1].headers.Authorization, 'Bearer second')
  assert.deepEqual(calls[2], ['remove', calls[0][1].id])
})

test('scopes background pages to the owner context', async () => {
  const calls = []
  let ownerCleanup
  let provided
  const ctx = {
    weworkDesktop: {
      browser: {
        setRequestHeaderRule: async () => undefined,
        removeRequestHeaderRule: async () => undefined,
        createBackgroundPage: async id => calls.push(['create', id]),
        navigateBackgroundPage: async (id, url) => ({ id, url }),
        setBackgroundPageUserAgent: async (id, userAgent) => ({ id, userAgent }),
        backgroundPageState: async id => ({ id, url: 'https://example.test/' }),
        closeBackgroundPage: async id => calls.push(['close', id]),
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
  const owner = {
    effect(factory) {
      ownerCleanup = factory()
    },
  }

  apply(ctx)
  const page = await provided.pages.open(owner)
  const createdId = calls[0][1]
  assert.deepEqual(await page.navigate('https://example.test/login'), {
    id: createdId,
    url: 'https://example.test/login',
  })
  assert.deepEqual(await page.setUserAgent('Example/1.0'), {
    id: createdId,
    userAgent: 'Example/1.0',
  })
  assert.deepEqual(await page.state(), {
    id: createdId,
    url: 'https://example.test/',
  })
  await ownerCleanup()
  assert.deepEqual(calls.at(-1), ['close', createdId])
})
