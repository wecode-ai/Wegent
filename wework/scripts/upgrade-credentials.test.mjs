import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import {
  credentialAssertionScript,
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

test('re-upgrade independence requires legacy files to retain their rollback hashes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-credential-proof-'))
  try {
    const profile = join(root, 'profile')
    const protectedDirectory = join(profile, 'protected-credentials')
    const resourcesPath = join(root, 'resources')
    await mkdir(protectedDirectory, { recursive: true })
    await mkdir(join(resourcesPath, 'app.asar'), { recursive: true })
    await writeFile(
      join(resourcesPath, 'app.asar/package.json'),
      JSON.stringify({
        weworkCredentialStorageMode: 'isolated-copy-once',
        weworkCredentialStorageVersion: 3,
      })
    )
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const cloud = {
      refreshToken: 'synthetic-upgrade-refresh-token',
      privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    }
    await writeFile(
      join(protectedDirectory, 'cloud-credentials.json'),
      JSON.stringify({
        version: 3,
        ciphertext: Buffer.from(JSON.stringify(cloud)).toString('base64'),
      })
    )
    await writeFile(
      join(protectedDirectory, 'secure-values.json'),
      JSON.stringify({ version: 3, values: {} })
    )
    const legacyDigests = {}
    for (const name of ['secure-values.key', 'secure-values.json', 'cloud-credentials.json']) {
      await writeFile(join(profile, name), `rollback-written-${name}`)
      legacyDigests[name] = createHash('sha256')
        .update(await readFile(join(profile, name)))
        .digest('hex')
    }
    const require = createRequire(import.meta.url)
    const publicJwk = publicKey.export({ format: 'jwk' })
    const nativeRequire = name => {
      if (name === 'electron')
        return {
          app: { getPath: () => profile },
          safeStorage: { decryptStringAsync: async value => ({ result: value.toString('utf8') }) },
        }
      if (name.endsWith('/secure-value-store.js'))
        return {
          SecureValueStore: class {
            async get() {
              return 'target-written-secret'
            }
          },
        }
      if (name.endsWith('/cloud-credential-service.js'))
        return {
          CloudCredentialService: class {
            async prepareAuthorization() {
              return { publicKey: publicJwk }
            }
          },
        }
      return require(name)
    }
    const script = credentialAssertionScript({
      directories: [profile],
      expectedPublicKey: publicJwk,
      expectedSecrets: { isolated: 'target-written-secret' },
      protectedFormats: { isolated: 3 },
      legacyDigests,
      stage: 're-upgraded',
      write: false,
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
        fetch: async () => ({ ok: true, json: async () => ({ authenticated: true }) }),
      })
    assert.equal((await verify()).newStoreIndependent, true)
    await writeFile(join(profile, 'secure-values.json'), 'target-overwrote-legacy')
    await assert.rejects(verify(), /changed a legacy rollback credential file/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
