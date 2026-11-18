import assert from 'node:assert/strict'
import { createCipheriv, createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inspectRunningApp, readConnectedApplicationPid } from './inspect-before-start.mjs'
import { verifyLegacyModelBindings } from './upgrade-model-binding.mjs'

const KEY = 'upgrade-credential-fixture'
const SECRET = 'wework-upgrade-synthetic-model-secret'
const NEXT_SECRET = 'wework-rollback-synthetic-model-secret'
const UPGRADED_SECRET = 'wework-upgraded-synthetic-model-secret'
const MODEL_PATH = '/upgrade-credential-model'

/** Both storage modes must authenticate a target write before rollback. */
export function credentialWriteForStage(stage, write = false) {
  return stage === 'upgraded' ? UPGRADED_SECRET : write ? NEXT_SECRET : null
}

/** Invoke each delivered host's native reader; historical packages predate authorization transactions. */
export async function readCloudDevicePublicKey(credentials, apiBaseUrl) {
  if (typeof credentials.prepareAuthorization === 'function')
    return (await credentials.prepareAuthorization(apiBaseUrl)).publicKey
  if (typeof credentials.devicePublicKey === 'function') return credentials.devicePublicKey()
  throw new Error('The delivered host has no supported cloud credential reader')
}

/** Exercise shipped readers with synthetic credentials; never snapshot personal authentication. */
export function upgradeCredentials() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const expectedPublicKey = publicKey.export({ format: 'jwk' })
  const stages = []
  const expectedSecrets = { shared: SECRET, isolated: SECRET }
  const protectedFormats = { shared: 2, isolated: 3 }
  let authenticationSecrets = { ...expectedSecrets }
  let legacyDigests = {}
  return {
    stages,
    async seed(directory) {
      const key = randomBytes(32)
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const data = Buffer.concat([cipher.update(SECRET, 'utf8'), cipher.final()])
      const encrypted = Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), data]).toString(
        'base64'
      )
      const options = { mode: 0o600, flag: 'wx' }
      await writeFile(join(directory, 'secure-values.key'), key, options)
      await writeFile(
        join(directory, 'secure-values.json'),
        JSON.stringify({ version: 2, values: { [KEY]: encrypted } }),
        options
      )
      await writeFile(
        join(directory, 'cloud-credentials.json'),
        JSON.stringify({
          version: 2,
          apiBaseUrl: 'https://upgrade-credential.invalid/api',
          publicKey: expectedPublicKey,
          privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }),
          refreshToken: 'synthetic-upgrade-refresh-token',
          ownerUserId: 7,
        }),
        options
      )
      legacyDigests = Object.fromEntries(
        await Promise.all(
          ['secure-values.key', 'secure-values.json', 'cloud-credentials.json'].map(async name => [
            name,
            createHash('sha256')
              .update(await readFile(join(directory, name)))
              .digest('hex'),
          ])
        )
      )
    },
    handleHttp(request, response, url) {
      if (url.pathname !== MODEL_PATH) return false
      const domain = request.headers['x-upgrade-credential-domain']
      assert.ok(domain === 'shared' || domain === 'isolated')
      assert.equal(request.headers.authorization, `Bearer ${authenticationSecrets[domain]}`)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ authenticated: true }))
      return true
    },
    async verify(control, port, stage, directories, { write = false } = {}) {
      const applicationPid = await readConnectedApplicationPid(control)
      const writeSecret = credentialWriteForStage(stage, write)
      authenticationSecrets = {
        shared: writeSecret ?? expectedSecrets.shared,
        isolated: writeSecret ?? expectedSecrets.isolated,
      }
      const input = {
        directories,
        expectedPublicKey,
        expectedSecrets,
        writeSecret,
        stage,
        protectedFormats,
        legacyDigests,
        modelUrl: `http://127.0.0.1:${process.env.WEWORK_E2E_MODEL_SERVER_PORT}${MODEL_PATH}`,
      }
      const result = await inspectRunningApp(port, applicationPid, credentialAssertionScript(input))
      if (stage === 'source' || stage === 'rolled-back') legacyDigests = result.legacyDigests
      assert.ok([2, 3].includes(result.format))
      const domain = result.storageMode === 'isolated-copy-once' ? 'isolated' : 'shared'
      if (result.writeAuthenticated) expectedSecrets[domain] = authenticationSecrets[domain]
      protectedFormats[domain] = Math.max(protectedFormats[domain], result.format)
      stages.push({
        stage,
        format: result.format,
        storageVersion: result.storageVersion,
        storageMode: result.storageMode,
        modelAuthenticated: true,
        cloudDeviceSignature: true,
        ...(result.writeAuthenticated ? { writeAuthenticated: true } : {}),
        ...(result.legacyFilesPreserved ? { legacyFilesPreserved: true } : {}),
        ...(result.legacyModelBindingsPreserved ? { legacyModelBindingsPreserved: true } : {}),
        ...(result.newStoreIndependent ? { newStoreIndependent: true } : {}),
      })
    },
  }
}

export function credentialAssertionScript(input) {
  return `(async () => {
    const require = process.getBuiltinModule('module').createRequire(process.execPath)
    const assert = require('node:assert/strict')
    const fs = require('node:fs/promises')
    const path = require('node:path')
    const crypto = require('node:crypto')
    const {app, safeStorage} = require('electron')
    const input = ${JSON.stringify(input)}
    const started = Date.now()
    const mark = stage => console.info('[upgrade-credential-stage]', JSON.stringify({
      pid: process.pid, stage, elapsedMs: Date.now() - started
    }))
    mark('read-model')
    const directory = app.getPath('userData')
    assert.ok(input.directories.includes(directory), 'Credential fixture escaped its isolated profile')
    const host = path.join(process.resourcesPath, 'app.asar/dist/host')
    const {SecureValueStore} = require(path.join(host, 'secure-value-store.js'))
    const {CloudCredentialService} = require(path.join(host, 'cloud-credential-service.js'))
    const metadata = JSON.parse(await fs.readFile(path.join(process.resourcesPath, 'app.asar/package.json'), 'utf8'))
    const storageMode = metadata.weworkCredentialStorageMode ?? 'shared'
    const isolated = storageMode === 'isolated-copy-once'
    const domain = isolated ? 'isolated' : 'shared'
    const storageDirectory = isolated ? path.join(directory, 'protected-credentials') : directory
    const store = new SecureValueStore(directory)
    const secret = await store.get(${JSON.stringify(KEY)})
    mark('model-read')
    assert.ok(secret === input.expectedSecrets[domain], 'Native model credential changed across release selection')
    const nextSecret = input.writeSecret
    const write = typeof nextSecret === 'string'
    if (write) {
      mark('write-model')
      await store.set(${JSON.stringify(KEY)}, nextSecret)
      assert.ok(await store.get(${JSON.stringify(KEY)}) === nextSecret,
        'Native model credential write did not persist')
      mark('model-written')
    }
    const authenticationSecret = write ? nextSecret : secret
    const response = await fetch(input.modelUrl, {headers: {
      Authorization: 'Bearer ' + authenticationSecret, 'X-Upgrade-Credential-Domain': domain
    }})
    assert.ok(response.ok && (await response.json()).authenticated, 'Stored model credential could not authenticate')
    mark('model-authenticated')
    const credentials = new CloudCredentialService(directory)
    const publicKey = await (${readCloudDevicePublicKey.toString()})(credentials, 'https://upgrade-credential.invalid/api')
    mark('cloud-read')
    assert.ok(publicKey.x === input.expectedPublicKey.x && publicKey.y === input.expectedPublicKey.y,
      'Cloud credential reader lost the authorized device identity')
    const cloudEnvelope = JSON.parse(await fs.readFile(path.join(storageDirectory, 'cloud-credentials.json'), 'utf8'))
    const cloud = cloudEnvelope.version === 3
      ? JSON.parse((await safeStorage.decryptStringAsync(Buffer.from(cloudEnvelope.ciphertext, 'base64'))).result) : cloudEnvelope
    mark('cloud-decrypted')
    assert.ok(cloud.refreshToken === 'synthetic-upgrade-refresh-token', 'Cloud refresh credential changed')
    const challenge = Buffer.from('credential-upgrade-device-proof')
    const signature = crypto.sign('sha256', challenge, cloud.privateKey)
    assert.ok(crypto.verify('sha256', challenge, crypto.createPublicKey({key: input.expectedPublicKey, format: 'jwk'}), signature),
      'The retained cloud private key cannot authenticate the device')
    const values = JSON.parse(await fs.readFile(path.join(storageDirectory, 'secure-values.json'), 'utf8'))
    const storageVersion = metadata.weworkCredentialStorageVersion ?? 2
    assert.ok([2, 3].includes(storageVersion), 'Unknown packaged credential storage version')
    const expectedFormat = Math.max(input.protectedFormats[domain], storageVersion)
    assert.ok(values.version === expectedFormat && cloudEnvelope.version === expectedFormat, 'Credential format was downgraded or migration was missed')
    if (expectedFormat === 3) {
      await assert.rejects(fs.readFile(path.join(storageDirectory, 'secure-values.key')), {code: 'ENOENT'})
      assert.ok(!JSON.stringify(values).includes(authenticationSecret), 'Model secret remains readable on disk')
      assert.ok(!JSON.stringify(cloudEnvelope).includes('synthetic-upgrade-refresh-token'), 'Cloud credential remains plaintext')
    }
    if (isolated && ['upgraded', 're-upgraded'].includes(input.stage)) {
      for (const [name, digest] of Object.entries(input.legacyDigests)) {
        assert.equal(crypto.createHash('sha256').update(await fs.readFile(path.join(directory, name))).digest('hex'),
          digest, 'The security target changed a legacy rollback credential file')
      }
    }
    const legacyModelBindingsPreserved = isolated && input.stage === 'upgraded'
      ? await (${verifyLegacyModelBindings.toString()})({nativeRequire: require, directory, host})
      : false
    mark('verified')
    const legacyDigests = ['source', 'rolled-back'].includes(input.stage) ? Object.fromEntries(await Promise.all(
      Object.keys(input.legacyDigests).map(async name => [name,
        crypto.createHash('sha256').update(await fs.readFile(path.join(directory, name))).digest('hex')])
    )) : undefined
    return {
      format: expectedFormat, storageVersion, storageMode, writeAuthenticated: write,
      legacyDigests,
      legacyModelBindingsPreserved,
      legacyFilesPreserved: isolated && input.stage === 'upgraded',
      newStoreIndependent: isolated && input.stage === 're-upgraded'
    }
  })()`
}
