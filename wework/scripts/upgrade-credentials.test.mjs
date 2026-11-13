import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import {
  credentialAssertionScript,
  credentialWriteForStage,
  readCloudDevicePublicKey,
} from '../e2e/desktop/modules/upgrade-credentials.mjs'

test('uses the native cloud reader for historical and transactional packages', async () => {
  const publicKey = { kty: 'EC', crv: 'P-256', x: 'device-x', y: 'device-y' }
  let legacyReads = 0
  const legacy = {
    async devicePublicKey() {
      legacyReads += 1
      return publicKey
    },
  }
  assert.equal(await readCloudDevicePublicKey(legacy, 'https://cloud.invalid/api'), publicKey)
  assert.equal(legacyReads, 1)
  const current = {
    async prepareAuthorization(apiBaseUrl) {
      assert.equal(apiBaseUrl, 'https://cloud.invalid/api')
      return { authorizationId: 'candidate', publicKey }
    },
  }
  assert.equal(await readCloudDevicePublicKey(current, 'https://cloud.invalid/api'), publicKey)
})

test('cannot substitute a legacy reader after current authorization fails', async () => {
  const error = new Error('Credential read failed')
  await assert.rejects(
    readCloudDevicePublicKey(
      {
        async prepareAuthorization() {
          throw error
        },
        devicePublicKey() {
          assert.fail('Native reader failures must propagate')
        },
      },
      'https://cloud.invalid/api'
    ),
    candidate => candidate === error
  )
  await assert.rejects(readCloudDevicePublicKey({}, 'https://cloud.invalid/api'), /no supported/)
})

async function credentialFixture(
  t,
  {
    stage = 're-upgraded',
    storageMode = 'isolated-copy-once',
    storageVersion = 3,
    write = false,
    discardWrites = false,
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'wework-credential-proof-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const profile = join(root, 'profile')
  const isolated = storageMode === 'isolated-copy-once'
  const protectedDirectory = isolated ? join(profile, 'protected-credentials') : profile
  const resourcesPath = join(root, 'resources')
  await mkdir(protectedDirectory, { recursive: true })
  await mkdir(join(resourcesPath, 'app.asar'), { recursive: true })
  await writeFile(
    join(resourcesPath, 'app.asar/package.json'),
    JSON.stringify({
      weworkCredentialStorageMode: storageMode,
      weworkCredentialStorageVersion: storageVersion,
    })
  )
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const cloud = {
    refreshToken: 'synthetic-upgrade-refresh-token',
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }),
  }
  await writeFile(
    join(protectedDirectory, 'cloud-credentials.json'),
    JSON.stringify(
      storageVersion === 3
        ? {
            version: 3,
            ciphertext: Buffer.from(JSON.stringify(cloud)).toString('base64'),
          }
        : { version: 2, ...cloud }
    )
  )
  await writeFile(
    join(protectedDirectory, 'secure-values.json'),
    JSON.stringify({ version: storageVersion, values: {} })
  )
  const legacyDigests = {}
  for (const name of isolated
    ? ['secure-values.key', 'secure-values.json', 'cloud-credentials.json']
    : []) {
    await writeFile(join(profile, name), `rollback-written-${name}`)
    legacyDigests[name] = createHash('sha256')
      .update(await readFile(join(profile, name)))
      .digest('hex')
  }
  const require = createRequire(import.meta.url)
  const publicJwk = publicKey.export({ format: 'jwk' })
  const initialSecret = stage === 'upgraded' ? 'source-written-secret' : 'target-written-secret'
  let secret = initialSecret
  const writes = []
  const nativeRequire = name => {
    if (name === 'electron')
      return {
        app: { getPath: () => profile },
        safeStorage: { decryptStringAsync: async value => ({ result: value.toString('utf8') }) },
      }
    if (basename(name) === 'secure-value-store.js')
      return {
        SecureValueStore: class {
          async get() {
            return secret
          }
          async set(key, value) {
            writes.push({ key, value })
            if (!discardWrites) secret = value
          }
        },
      }
    if (basename(name) === 'cloud-credential-service.js')
      return {
        CloudCredentialService: class {
          async prepareAuthorization() {
            return { publicKey: publicJwk }
          }
        },
      }
    return require(name)
  }
  const writeSecret = credentialWriteForStage(stage, write)
  const script = credentialAssertionScript({
    directories: [profile],
    expectedPublicKey: publicJwk,
    expectedSecrets: { shared: initialSecret, isolated: initialSecret },
    protectedFormats: { shared: 2, isolated: 3 },
    legacyDigests,
    stage,
    writeSecret,
    modelUrl: 'https://model.invalid',
  })
  const verify = () =>
    runInNewContext(script, {
      process: {
        execPath: process.execPath,
        resourcesPath,
        getBuiltinModule: () => ({ createRequire: () => nativeRequire }),
      },
      Buffer,
      console: { info() {} },
      fetch: async (url, { headers }) => {
        assert.equal(url, 'https://model.invalid')
        assert.equal(headers.Authorization, `Bearer ${writeSecret ?? initialSecret}`)
        assert.equal(headers['X-Upgrade-Credential-Domain'], isolated ? 'isolated' : 'shared')
        return { ok: true, json: async () => ({ authenticated: true }) }
      },
    })
  return { profile, verify, writes }
}

test('re-upgrade independence requires legacy files to retain their rollback hashes', async t => {
  const { profile, verify } = await credentialFixture(t)
  assert.equal((await verify()).newStoreIndependent, true)
  await writeFile(join(profile, 'secure-values.json'), 'target-overwrote-legacy')
  await assert.rejects(verify(), /changed a legacy rollback credential file/)
})

for (const [stage, storageVersion, write] of [
  ['upgraded', 2, false],
  ['upgraded', 3, false],
  ['rolled-back', 2, true],
]) {
  test(`${stage} shared v${storageVersion} evidence authenticates a native write`, async t => {
    const { verify, writes } = await credentialFixture(t, {
      stage,
      storageMode: 'shared',
      storageVersion,
      write,
    })
    assert.equal((await verify()).writeAuthenticated, true)
    assert.deepEqual(writes, [
      {
        key: 'upgrade-credential-fixture',
        value:
          stage === 'upgraded'
            ? 'wework-upgraded-synthetic-model-secret'
            : 'wework-rollback-synthetic-model-secret',
      },
    ])
  })
}

test('an acknowledged write that did not persist cannot become authenticated proof', async t => {
  const { verify } = await credentialFixture(t, {
    stage: 'upgraded',
    storageMode: 'shared',
    storageVersion: 2,
    discardWrites: true,
  })
  await assert.rejects(verify(), /Native model credential write did not persist/)
})
