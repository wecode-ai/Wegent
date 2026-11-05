import assert from 'node:assert/strict'
import test from 'node:test'
import { assertReinstallReceipt } from '../e2e/desktop/modules/plugin-reinstall-status.mjs'

const receipt = (sync, device = {}) => ({
  sync,
  plugin: {
    spec: { releaseId: 3 },
    status: {
      devices: [
        {
          deviceId: 'app-record-73',
          state: 'installed',
          actualReleaseId: 3,
          desiredReleaseId: 3,
          ...device,
        },
      ],
    },
  },
})

test('accepts successful sync and an already converged idempotent reinstall', () => {
  for (const sync of [null, { success: true }])
    assert.doesNotThrow(() => assertReinstallReceipt(receipt(sync), 'app-record-73'))
})

test('rejects failed or missing sync responses and incomplete device receipts', () => {
  for (const sync of [undefined, {}, { success: false }])
    assert.throws(() => assertReinstallReceipt(receipt(sync), 'app-record-73'))
  for (const sync of [null, { success: true }]) {
    for (const device of [
      { state: 'pending' },
      { state: 'failed' },
      { deviceId: 'another-device' },
      { actualReleaseId: 2 },
      { desiredReleaseId: 4 },
    ])
      assert.throws(() => assertReinstallReceipt(receipt(sync, device), 'app-record-73'))
    const missingRelease = receipt(sync)
    missingRelease.plugin.spec.releaseId = null
    assert.throws(() => assertReinstallReceipt(missingRelease, 'app-record-73'))
  }
})
