import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readCloudDevicePublicKey } from '../e2e/desktop/modules/upgrade-credentials.mjs'

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
