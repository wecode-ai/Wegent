import { createCipheriv, generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import {
  MemoryCredentialBackend,
  testCredentialLock,
} from '../../test-fixtures/credential-vault.js'
import { CloudCredentialService } from './cloud-credential-service.js'
import { CredentialMirrorMigration } from './credential-mirror-migration.js'
import { ModelConfigurationStore } from './model-configuration-store.js'
import { PreferencesStore } from './preferences-store.js'
import { RendererStorageStore } from './renderer-storage-store.js'
import { SecureValueStore } from './secure-value-store.js'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const originalKeys = { 'plugin.key': 'plugin-旧密钥🔑', 'plugin.empty': '' }
const yaml = `version: 1
providers:
  - id: existing
    name: Existing connection
    base_url: https://models.example/v1
    api_format: openai-responses
    api_key: yaml-old-key
    models:
      - id: existing-model
        model_id: upstream-a
`
const legacyModels = JSON.stringify([
  {
    id: 'legacy-model',
    modelId: 'upstream-b',
    baseUrl: 'https://legacy.example/v1',
    apiKey: 'renderer-old-key',
  },
])
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const jwk = publicKey.export({ format: 'jwk' })
const identity = {
  version: 2,
  apiBaseUrl: 'https://cloud.example/api',
  publicKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
  privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  refreshToken: 'refresh-old-key',
}
const connection = { apiBaseUrl: identity.apiBaseUrl, token: 'mirror-old-key', user: { id: 7 } }

async function seed(models = legacyModels) {
  const root = await mkdtemp(join(tmpdir(), 'wework-upgrade-'))
  directories.push(root)
  const key = randomBytes(32)
  const values = Object.fromEntries(
    Object.entries(originalKeys).map(([name, value]) => {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return [
        name,
        Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]).toString('base64'),
      ]
    })
  )
  await writeFile(join(root, 'secure-values.key'), key)
  await writeFile(join(root, 'secure-values.json'), JSON.stringify({ version: 2, values }))
  await writeFile(join(root, 'cloud-credentials.json'), JSON.stringify(identity))
  await writeFile(
    join(root, 'app-preferences.json'),
    JSON.stringify({ theme: 'dark', cloudConnection: connection })
  )
  await writeFile(
    join(root, 'renderer-local-storage.json'),
    JSON.stringify({
      version: 1,
      entries: {
        'wework.localModelSettings.v1': models,
        'wework.cloudConnection': JSON.stringify(connection),
        unrelated: 'keep',
      },
    })
  )
  await mkdir(join(root, 'model-connections'))
  await writeFile(join(root, 'model-connections/model.yml'), yaml)
  const backend = new MemoryCredentialBackend()
  const options = { backend, acquireLock: testCredentialLock() }
  return { root, backend, options }
}

async function boot(f: Awaited<ReturnType<typeof seed>>) {
  const store = new SecureValueStore(f.root, f.options)
  await store.initialize()
  const cloud = new CloudCredentialService(f.root, store)
  await cloud.initialize()
  const mirrors = new CredentialMirrorMigration(store)
  await mirrors.cleanArtifacts(f.root)
  const preferences = new PreferencesStore(f.root)
  preferences.transform = value => mirrors.preferences(value)
  preferences.protectDamaged = (name, content) => mirrors.archive(name, content)
  await preferences.read()
  const models = new ModelConfigurationStore(join(f.root, 'model-connections'), store)
  await models.read()
  const renderer = new RendererStorageStore(f.root)
  renderer.transform = value => mirrors.renderer(value)
  renderer.protectDamaged = (name, content) => mirrors.archive(name, content)
  await renderer.prepareOrigin('https://app.example', {
    clearAll: async () => {},
    clearOrigin: async () => {},
  })
  await renderer.initialize({})
  const snapshot = await models.read()
  return { store, cloud, models, snapshot }
}

async function verify(f: Awaited<ReturnType<typeof seed>>) {
  const result = await boot(f)
  expect(result.snapshot.error).toBeUndefined()
  expect(
    result.snapshot.providers.flatMap(provider => provider.models.map(model => model.id)).sort()
  ).toEqual(['existing-model', 'legacy-model'])
  for (const [key, value] of Object.entries(originalKeys))
    expect(await result.store.get(key)).toBe(value)
  const enabled = await result.models.runtime()
  expect(enabled.models.map(item => item.provider.api_key).sort()).toEqual([
    'renderer-old-key',
    'yaml-old-key',
  ])
  expect(JSON.parse((await result.store.get('wework-cloud.identity'))!)).toEqual(identity)
  expect(await result.cloud.devicePublicKey()).toEqual(identity.publicKey)
  let protectedValues: Record<string, string> = {}
  await result.store.update(values => {
    protectedValues = { ...values }
  })
  expect(Object.values(protectedValues).some(value => value.includes('mirror-old-key'))).toBe(true)
  expect(await readdir(f.root)).not.toContain('secure-values.key')
  expect(await readdir(f.root)).not.toContain('cloud-credentials.json')
  for (const path of [
    'app-preferences.json',
    'renderer-local-storage.json',
    'model-connections/model.yml',
  ]) {
    expect(await readFile(join(f.root, path), 'utf8')).not.toMatch(
      /yaml-old-key|renderer-old-key|mirror-old-key|refresh-old-key/
    )
  }
  expect(await result.store.get('wework-models.pending')).toBeNull()
  return result
}

test('an old user retains every credential and device identity through the complete startup and two restarts', async () => {
  const f = await seed()
  await verify(f)
  await verify(f)
})

test.each([false, true])(
  'colliding IDs retain all old credentials, including a partial merge: %s',
  async partial => {
    const conflicting = JSON.parse(legacyModels.replace('legacy-model', 'existing-model'))
    const conflict = JSON.stringify(
      partial ? [...conflicting, ...JSON.parse(legacyModels)] : conflicting
    )
    const f = await seed(conflict)
    const { store, models } = await boot(f)
    expect((await models.runtime()).models[0].provider.api_key).toBe('yaml-old-key')
    let values: Record<string, string> = {}
    await store.update(current => {
      values = { ...current }
    })
    expect(
      Object.values(values).some(
        value =>
          value.includes('renderer-old-key') ||
          (value.includes('base64') &&
            Buffer.from(JSON.parse(value).base64, 'base64').toString() === conflict)
      )
    ).toBe(true)
    const archived = Object.entries(values).filter(([key]) =>
      key.startsWith('wework-mirrors.recovery.')
    )
    expect(archived).toHaveLength(1)
    expect(Buffer.from(JSON.parse(archived[0][1]).base64, 'base64').toString()).toBe(conflict)
    await boot(f)
    expect((await models.runtime()).models.map(item => item.model.id).sort()).toEqual(
      partial ? ['existing-model', 'legacy-model'] : ['existing-model']
    )
  }
)

test('a late corrupt AES entry cannot publish or delete earlier valid entries', async () => {
  const f = await seed()
  const path = join(f.root, 'secure-values.json')
  const original = await readFile(path)
  const key = await readFile(join(f.root, 'secure-values.key'))
  const damaged = JSON.parse(original.toString())
  const envelope = Buffer.from(damaged.values['plugin.empty'], 'base64')
  envelope[14] ^= 255
  damaged.values['plugin.empty'] = envelope.toString('base64')
  const source = JSON.stringify(damaged)
  await writeFile(path, source)
  await expect(boot(f)).rejects.toMatchObject({ code: 'secure_storage_corrupted' })
  expect(await readFile(path, 'utf8')).toBe(source)
  expect(await readFile(join(f.root, 'secure-values.key'))).toEqual(key)
  await writeFile(path, original)
  await verify(f)
})

test('historical YAML references keep their exact key when the encrypted store migrates first', async () => {
  const f = await seed()
  const key = await readFile(join(f.root, 'secure-values.key'))
  const path = join(f.root, 'secure-values.json')
  const stored = JSON.parse(await readFile(path, 'utf8'))
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update('yaml-old-key', 'utf8'), cipher.final()])
  const ref = 'wework-model-key.historical-ref'
  stored.values[ref] = Buffer.concat([
    Buffer.from([1]),
    iv,
    cipher.getAuthTag(),
    encrypted,
  ]).toString('base64')
  await writeFile(path, JSON.stringify(stored))
  await writeFile(
    join(f.root, 'model-connections/model.yml'),
    yaml.replace('api_key: yaml-old-key', `api_key_ref: ${ref}`)
  )
  await verify(f)
  const { store } = await verify(f)
  expect(await store.get(ref)).toBe('yaml-old-key')
})

test.each(['rotate', 'logout'])(
  'a delayed second migration cannot undo a committed cloud %s',
  async action => {
    const f = await seed()
    const store = new SecureValueStore(f.root, f.options)
    await store.initialize()
    let resume!: () => void
    let reached!: () => void
    const paused = new Promise<void>(resolve => {
      resume = resolve
    })
    const ready = new Promise<void>(resolve => {
      reached = resolve
    })
    const delayed = new CloudCredentialService(f.root, {
      get: key => store.get(key),
      update: async change => {
        reached()
        await paused
        await store.update(change)
      },
    })
    const migrating = delayed.initialize()
    await ready
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'success',
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
        })
      )
    )
    const current = new CloudCredentialService(f.root, store, request)
    try {
      await current.initialize()
      if (action === 'rotate')
        await current.claimAuthorization({
          apiBaseUrl: identity.apiBaseUrl,
          sessionId: 'synthetic-session',
          pollToken: 'synthetic-poll-token',
        })
      else await current.clear()
    } finally {
      resume()
    }
    await migrating
    const stored = await store.get('wework-cloud.identity')
    if (action === 'rotate') {
      expect(JSON.parse(stored!).refreshToken).toBe('new-refresh-token')
      expect(JSON.parse(stored!).publicKey).toEqual(identity.publicKey)
    } else {
      expect(stored).toBeNull()
      expect(await store.get('wework-cloud.mirrors-closed')).toBe('3')
    }
  }
)

test('unavailable native storage preserves every old file byte for byte and permits a later upgrade', async () => {
  const f = await seed()
  const paths = [
    'secure-values.json',
    'secure-values.key',
    'cloud-credentials.json',
    'app-preferences.json',
    'renderer-local-storage.json',
    'model-connections/model.yml',
  ]
  const originals = await Promise.all(paths.map(path => readFile(join(f.root, path))))
  f.backend.fault = () => {
    throw new Error('native storage denied')
  }
  await expect(boot(f)).rejects.toThrow('native storage denied')
  for (let index = 0; index < paths.length; index++)
    expect(await readFile(join(f.root, paths[index]))).toEqual(originals[index])
  f.backend.fault = null
  await verify(f)
})

test('a real filesystem publication failure retains the key referenced by the already-written YAML', async () => {
  const f = await seed()
  const blocked = join(f.root, 'model-connections/model-binding.json')
  const store = new SecureValueStore(f.root, f.options)
  await store.initialize()
  const models = new ModelConfigurationStore(join(f.root, 'model-connections'), {
    get: key => store.get(key),
    set: (key, value) => store.set(key, value),
    delete: key => store.delete(key),
    update: async change => {
      await store.update(change)
      // Block publication only after the protected intent, not during binding lookup.
      if (await store.get('wework-models.pending')) await mkdir(blocked, { recursive: true })
    },
  })
  expect((await models.read()).error).toBeDefined()
  const source = await readFile(join(f.root, 'model-connections/model.yml'), 'utf8')
  const reference = /api_key_ref: (wework-model-key\.[a-f0-9-]+)/.exec(source)![1]
  expect(await store.get(reference)).toBe('yaml-old-key')
  expect(await store.get('wework-models.pending')).not.toBeNull()
  await rm(blocked, { recursive: true })
  await verify(f)
})

test.each(['before', 'after'])(
  'complete upgrade recovers every native boundary: %s',
  async timing => {
    const baseline = await seed()
    await boot(baseline)
    const count = baseline.backend.trace.length
    console.info(`Complete upgrade: testing ${timing} each of ${count} native boundaries`)
    for (let faultAt = 1; faultAt <= count; faultAt++) {
      const f = await seed()
      let index = 0
      let injected = false
      f.backend.fault = stage => {
        if (stage.startsWith(`${timing}:`) && ++index === faultAt) {
          injected = true
          throw new Error(`interrupted upgrade at ${faultAt}`)
        }
      }
      await boot(f).catch(() => {})
      expect(injected, `unreached boundary ${faultAt}`).toBe(true)
      f.backend.fault = null
      await verify(f)
      await rm(f.root, { recursive: true, force: true })
    }
  },
  120_000
)
