// @vitest-environment node

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, test, vi } from 'vitest'
import { nativeCloudAuthorizationFixture } from '../e2e/desktop/modules/native-cloud-authorization-client.mjs'

const transport = vi.hoisted(() => ({ evaluate: null, calls: [] }))
vi.mock('../e2e/desktop/modules/inspect-before-start.mjs', () => ({
  inspectRunningApp(port, pid, expression) {
    transport.calls.push({ port, pid })
    return transport.evaluate(expression)
  },
}))

const roots = []
const cloud = { backendUrl: 'http://127.0.0.1:8000', authToken: 'synthetic-user-token' }
const control = { nativeInspectorPort: 9234, applicationProcessId: 123 }
const require = createRequire(import.meta.url)

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'native-cloud-login-'))
  roots.push(root)
  const protectedRoot = join(root, 'protected-credentials')
  const calls = []
  let failure
  let ready = true
  let profile = root
  class Credentials {
    constructor(directory) {
      assert.equal(directory, root)
    }
    async prepareAuthorization() {
      calls.push('prepare')
      return { authorizationId: 'candidate', publicKey: { kty: 'EC' } }
    }
    async claimAuthorization(input) {
      assert.equal(input.authorizationId, 'candidate')
      assert.equal(input.sessionId, 'session')
      assert.equal(input.pollToken, 'synthetic-poll')
      calls.push('claim')
      return {
        status: 'success',
        credentialMode: 'desktop_refresh',
        accessToken: 'synthetic-access',
      }
    }
    async commitAuthorization(id, user) {
      assert.equal(id, 'candidate')
      assert.equal(user, 52)
      calls.push('commit')
      await writeFile(
        join(protectedRoot, 'cloud-credentials.json'),
        'temporary-protected-credential'
      )
      if (failure) throw failure
    }
    async refreshAccessToken() {
      calls.push('refresh')
      return { accessToken: 'synthetic-refreshed' }
    }
  }
  const request = async (url, options) => {
    if (url.endsWith('/sessions'))
      return {
        ok: true,
        json: async () => ({ session_id: 'session', poll_token: 'synthetic-poll' }),
      }
    if (url.endsWith('/approve')) {
      assert.equal(options.headers.Authorization, `Bearer ${cloud.authToken}`)
      calls.push('approve')
      return { ok: true }
    }
    assert.equal(options.headers.Authorization, 'Bearer synthetic-access')
    return { ok: true, json: async () => ({ id: 52 }) }
  }
  const nativeRequire = name => {
    if (name === 'electron') return { app: { getPath: () => profile, isReady: () => ready } }
    if (basename(name) === 'credential-storage-paths.js')
      return { protectedCredentialDirectory: directory => join(directory, 'protected-credentials') }
    if (basename(name) === 'cloud-credential-service.js')
      return { CloudCredentialService: Credentials }
    return require(name)
  }
  transport.evaluate = expression =>
    runInNewContext(expression, {
      process: {
        execPath: '/fixture/WeWork',
        resourcesPath: '/fixture/resources',
        getBuiltinModule: () => ({ createRequire: () => nativeRequire }),
      },
      fetch: request,
    })
  return {
    root,
    protectedRoot,
    calls,
    auth: nativeCloudAuthorizationFixture(cloud, root, control),
    fail: error => {
      failure = error
    },
    setProfile: value => {
      profile = value
    },
    setReady: value => {
      ready = value
    },
  }
}

afterEach(async () => {
  transport.calls = []
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

test('uses the connected native host and preserves independent legacy and protected credentials', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'cloud-credentials.json'), 'legacy-rollback-credential')
  await f.auth.authorize()
  expect(f.calls).toEqual(['prepare', 'approve', 'claim', 'commit', 'refresh'])
  expect(transport.calls).toEqual([
    { port: 9234, pid: 123 },
    { port: 9234, pid: 123 },
  ])
  await f.auth.restore()
  await expect(readFile(join(f.protectedRoot, 'cloud-credentials.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
  expect(await readFile(join(f.root, 'cloud-credentials.json'), 'utf8')).toBe(
    'legacy-rollback-credential'
  )
})

test('restores an existing protected credential after a partial committed login failure', async () => {
  const f = await fixture()
  const { mkdir } = await import('node:fs/promises')
  await mkdir(f.protectedRoot)
  await writeFile(join(f.protectedRoot, 'cloud-credentials.json'), 'original-protected-credential')
  f.fail(new Error('Native commit failed'))
  await expect(f.auth.authorize()).rejects.toThrow('Native commit failed')
  await f.auth.restore()
  expect(await readFile(join(f.protectedRoot, 'cloud-credentials.json'), 'utf8')).toBe(
    'original-protected-credential'
  )
})

test('refuses a different native profile before accessing credentials', async () => {
  const f = await fixture()
  f.setProfile('/unrelated/profile')
  await expect(f.auth.authorize()).rejects.toThrow('escaped its isolated profile')
  await f.auth.restore()
  expect(f.calls).toEqual([])
})

test('refuses an unready host instead of substituting Node mode or an unprotected store', async () => {
  const f = await fixture()
  f.setReady(false)
  await expect(f.auth.authorize()).rejects.toThrow('requires a ready Electron host')
  expect(f.calls).toEqual([])
})

test('cleanup remains possible after the host stops', async () => {
  const f = await fixture()
  await f.auth.authorize()
  transport.evaluate = () => {
    throw new Error('Host stopped')
  }
  await f.auth.restore()
  await expect(readFile(join(f.protectedRoot, 'cloud-credentials.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
})
