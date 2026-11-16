import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** Extend the existing password checkpoint without another service stack or build. */
export function localSnapshotChecks({
  control,
  homePath,
  slug,
  sourceDeviceId,
  connectionFor,
  waitForValue,
  timeoutMs,
  signalAutomaticRetry,
}) {
  const source = join(homePath, 'account-snapshot-synthetic.json')
  const auth = async (action, sessionId) =>
    JSON.parse(
      await control.command('localConnectorAuth', 'body', {
        value: JSON.stringify({ pluginKey: slug, connectorSlug: 'snapshot', action, sessionId }),
      })
    )
  const login = async () => {
    const started = await auth('start')
    return waitForValue(
      () => auth('poll', started.sessionId),
      result => ['ok', 'error'].includes(result.status),
      timeoutMs,
      'Snapshot source login did not complete'
    )
  }
  return {
    async verifySourceHealth() {
      await signalAutomaticRetry()
      await waitForValue(
        () => connectionFor('snapshot'),
        item => item?.status === 'connected' && item.device_ids.includes(sourceDeviceId),
        timeoutMs,
        'Snapshot was not enrolled and granted to the source device'
      )
      await rm(source)
      assert.equal(
        (await auth('health')).status,
        'need_login',
        'A connected cloud snapshot hid missing local credentials'
      )
      assert.equal((await connectionFor('snapshot')).status, 'connected')
      assert.equal((await login()).status, 'ok')
    },
    async beforeBackendStop() {
      assert.equal((await auth('logout')).status, 'ok')
      assert.equal((await connectionFor('snapshot')).status, 'disconnected')
    },
    async whileBackendStopped() {
      const result = await login()
      assert.equal(result.status, 'ok', 'A cloud outage reclassified a successful local login')
      assert.equal(result.accountSyncStatus, 'failed')
      assert.ok(await readFile(source), 'Cloud failure removed the source login')
      assert.equal((await auth('health')).status, 'ok')
    },
    async verifyRecovery() {
      assert.equal(
        (await connectionFor('snapshot')).status,
        'disconnected',
        'Offline login bypassed the cloud logout fence'
      )
      const result = await login()
      assert.equal(result.status, 'ok')
      assert.equal(result.accountSyncStatus, undefined)
      await signalAutomaticRetry()
      await waitForValue(
        () => connectionFor('snapshot'),
        item => item?.status === 'connected',
        timeoutMs,
        'Explicit snapshot login did not recover synchronization'
      )
    },
  }
}
