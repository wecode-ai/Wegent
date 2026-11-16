// @vitest-environment node
import { expect, test, vi } from 'vitest'
import { restrictNativeRevocationToLocal } from '../e2e/desktop/modules/native-account-runtime-isolation.mjs'
import { CLOUD_DEVICE_ID, REMOTE_DOCKER_DEVICE_ID } from '../e2e/desktop/modules/shared.mjs'

test('local revocation removes competing grants using each returned revision', async () => {
  const connection = {
    id: 'native',
    revision: 7,
    device_ids: ['desktop', CLOUD_DEVICE_ID, REMOTE_DOCKER_DEVICE_ID],
  }
  const api = vi
    .fn()
    .mockResolvedValueOnce({
      ...connection,
      revision: 8,
      device_ids: ['desktop', REMOTE_DOCKER_DEVICE_ID],
    })
    .mockResolvedValueOnce({ ...connection, revision: 9, device_ids: ['desktop'] })
  expect(await restrictNativeRevocationToLocal(api, connection)).toEqual({
    ...connection,
    revision: 9,
    device_ids: ['desktop'],
  })
  expect(api.mock.calls).toEqual([
    [`/plugin-connections/native/devices/${CLOUD_DEVICE_ID}`, 'DELETE', { expected_revision: 7 }],
    [
      `/plugin-connections/native/devices/${REMOTE_DOCKER_DEVICE_ID}`,
      'DELETE',
      { expected_revision: 8 },
    ],
  ])
})

test('a missing desktop grant cannot be masked by successful remote revocation', async () => {
  const api = vi.fn()
  await expect(
    restrictNativeRevocationToLocal(api, {
      id: 'native',
      revision: 1,
      device_ids: [CLOUD_DEVICE_ID, REMOTE_DOCKER_DEVICE_ID],
    })
  ).rejects.toThrow('one granted desktop Runtime')
  expect(api).not.toHaveBeenCalled()
})

test('permission or revision errors remain failures without retrying logout', async () => {
  const api = vi.fn().mockRejectedValue(new Error('plugin_auth_revision_conflict'))
  await expect(
    restrictNativeRevocationToLocal(api, {
      id: 'native',
      revision: 1,
      device_ids: ['desktop', CLOUD_DEVICE_ID, REMOTE_DOCKER_DEVICE_ID],
    })
  ).rejects.toThrow('plugin_auth_revision_conflict')
  expect(api).toHaveBeenCalledTimes(1)
})
