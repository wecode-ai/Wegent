import assert from 'node:assert/strict'
import { createCipheriv, generateKeyPairSync, randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inspectRunningApp } from './inspect-before-start.mjs'

const KEY = 'upgrade-credential-fixture'
const SECRET = 'wework-upgrade-synthetic-model-secret'
const NEXT_SECRET = 'wework-rollback-synthetic-model-secret'
const MODEL_PATH = '/upgrade-credential-model'

/** Exercise shipped readers with synthetic credentials; never snapshot personal authentication. */
export function upgradeCredentials() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const expectedPublicKey = publicKey.export({ format: 'jwk' })
  const stages = []
  let expectedSecret = SECRET
  let protectedFormat = 2
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
    },
    handleHttp(request, response, url) {
      if (url.pathname !== MODEL_PATH) return false
      assert.equal(request.headers.authorization, `Bearer ${expectedSecret}`)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ authenticated: true }))
      return true
    },
    async verify(control, port, stage, directories, { write = false } = {}) {
      const { applicationPid } = JSON.parse(
        await control.command('getOwnedProcessSnapshot', 'body')
      )
      const input = {
        directories,
        expectedPublicKey,
        expectedSecret,
        write,
        protectedFormat,
        modelUrl: `http://127.0.0.1:${process.env.WEWORK_E2E_MODEL_SERVER_PORT}${MODEL_PATH}`,
      }
      const result = await inspectRunningApp(port, applicationPid, credentialAssertionScript(input))
      assert.ok([2, 3].includes(result.format))
      protectedFormat = Math.max(protectedFormat, result.format)
      if (write) expectedSecret = NEXT_SECRET
      stages.push({
        stage,
        format: result.format,
        modelAuthenticated: true,
        cloudDeviceSignature: true,
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
    const directory = app.getPath('userData')
    assert.ok(input.directories.includes(directory), 'Credential fixture escaped its isolated profile')
    const host = path.join(process.resourcesPath, 'app.asar/dist/host')
    const {SecureValueStore} = require(path.join(host, 'secure-value-store.js'))
    const {CloudCredentialService} = require(path.join(host, 'cloud-credential-service.js'))
    const store = new SecureValueStore(directory)
    const secret = await store.get(${JSON.stringify(KEY)})
    assert.ok(secret === input.expectedSecret, 'Native model credential changed across release selection')
    const response = await fetch(input.modelUrl, {headers: {Authorization: 'Bearer ' + secret}})
    assert.ok(response.ok && (await response.json()).authenticated, 'Stored model credential could not authenticate')
    const credentials = new CloudCredentialService(directory)
    const prepared = await credentials.prepareAuthorization('https://upgrade-credential.invalid/api')
    assert.ok(prepared.publicKey.x === input.expectedPublicKey.x && prepared.publicKey.y === input.expectedPublicKey.y,
      'Cloud credential reader lost the authorized device identity')
    const cloudEnvelope = JSON.parse(await fs.readFile(path.join(directory, 'cloud-credentials.json'), 'utf8'))
    const cloud = cloudEnvelope.version === 3
      ? JSON.parse(safeStorage.decryptString(Buffer.from(cloudEnvelope.ciphertext, 'base64'))) : cloudEnvelope
    assert.ok(cloud.refreshToken === 'synthetic-upgrade-refresh-token', 'Cloud refresh credential changed')
    const challenge = Buffer.from('credential-upgrade-device-proof')
    const signature = crypto.sign('sha256', challenge, cloud.privateKey)
    assert.ok(crypto.verify('sha256', challenge, crypto.createPublicKey({key: input.expectedPublicKey, format: 'jwk'}), signature),
      'The retained cloud private key cannot authenticate the device')
    if (input.write) await store.set(${JSON.stringify(KEY)}, ${JSON.stringify(NEXT_SECRET)})
    const values = JSON.parse(await fs.readFile(path.join(directory, 'secure-values.json'), 'utf8'))
    const metadata = JSON.parse(await fs.readFile(path.join(process.resourcesPath, 'app.asar/package.json'), 'utf8'))
    const expectedFormat = Math.max(input.protectedFormat, metadata.weworkCredentialStorageVersion ?? 2)
    assert.ok(values.version === expectedFormat && cloudEnvelope.version === expectedFormat, 'Credential format was downgraded or migration was missed')
    if (expectedFormat === 3) {
      await assert.rejects(fs.readFile(path.join(directory, 'secure-values.key')), {code: 'ENOENT'})
      assert.ok(!JSON.stringify(values).includes(input.expectedSecret), 'Model secret remains readable on disk')
      assert.ok(!JSON.stringify(cloudEnvelope).includes('synthetic-upgrade-refresh-token'), 'Cloud credential remains plaintext')
    }
    return {format: expectedFormat}
  })()`
}
