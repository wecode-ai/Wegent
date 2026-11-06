import { expect, test } from 'vitest'
import { readCloudConnection, requireCloudCredentialOwner } from './cloud-connection-profile.js'

const apiBaseUrl = 'https://cloud.example/api'

test('reads only the configured cloud profile and preserves its owner', async () => {
  const profile = { apiBaseUrl, user: { id: 7 } }
  const storage = { read: async () => ({ 'wework.cloudConnection': JSON.stringify(profile) }) }
  const connection = await readCloudConnection(storage)
  expect(requireCloudCredentialOwner(connection, apiBaseUrl)).toBe(7)
  expect(await readCloudConnection({ read: async () => ({}) })).toBeNull()
})

test('reports malformed cloud settings without echoing stored data', async () => {
  const storage = { read: async () => ({ 'wework.cloudConnection': 'private-invalid-setting' }) }
  await expect(readCloudConnection(storage)).rejects.toThrow('Stored cloud connection is invalid')
})

test('rejects a different backend even when it has the same account number', () => {
  expect(() =>
    requireCloudCredentialOwner(
      { apiBaseUrl: 'https://other.example/api', user: { id: 7 } },
      apiBaseUrl
    )
  ).toThrow('destination is not configured')
})

test.each([null, {}, { id: 0 }, { id: -1 }, { id: '7' }, { id: 1.5 }, { id: Infinity }])(
  'rejects an unavailable profile owner: %j',
  user => {
    expect(() => requireCloudCredentialOwner({ apiBaseUrl, user }, apiBaseUrl)).toThrow(
      'account is unavailable'
    )
  }
)
