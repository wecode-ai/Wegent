import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import { cleanupPluginUpgradeFixtures } from '../e2e/desktop/modules/plugin-upgrade-fixture-cleanup.mjs'

const installations = [
  { plugin: { metadata: { labels: { id: '71' } }, spec: { releaseId: 101 } } },
  { plugin: { metadata: { labels: { id: '72' } }, spec: { releaseId: 102 } } },
]
const deviceIds = ['desktop-route', 'cloud-device', 'remote-device']

function fixture({ deleteStatus = 204 } = {}) {
  const deleted = []
  let rows = installations.flatMap(({ plugin }) =>
    deviceIds.map(device_id => ({
      installed_kind_id: Number(plugin.metadata.labels.id),
      device_id,
      state: 'installed',
      desired_release_id: plugin.spec.releaseId,
      actual_release_id: plugin.spec.releaseId,
      last_sync_at: '2026-10-30 08:21:01',
    }))
  )
  const cloud = {
    backendUrl: 'https://fixture.invalid',
    authToken: 'test-token',
    queryDatabase: vi.fn(async (sql, params) => {
      assert.match(sql, /WHERE user_id = %s/)
      assert.match(sql, /installed_kind_id IN \(%s, %s\)/)
      assert.match(sql, /device_id IN \(%s, %s, %s\)/)
      assert.deepEqual(params, [7, 71, 72, ...deviceIds])
      const selected = params.slice(1, 1 + installations.length)
      return rows.filter(row => selected.includes(row.installed_kind_id))
    }),
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options) => {
      const path = new URL(url).pathname
      if (path === '/api/users/me') return Response.json({ id: 7 })
      if (path === '/api/devices/online') {
        return Response.json({
          items: [
            { device_type: 'app', device_id: 'desktop', execution_target_id: deviceIds[0] },
            { device_type: 'cloud', device_id: deviceIds[1], socket_device_id: 'cloud-socket' },
            { device_type: 'remote', device_id: deviceIds[2] },
          ],
        })
      }
      assert.equal(options.method, 'DELETE')
      const id = Number(path.split('/').at(-1))
      deleted.push(id)
      if (deleteStatus === 204) {
        rows = rows.map(row =>
          row.installed_kind_id === id ? { ...row, state: 'uninstalling' } : row
        )
      }
      return new Response(null, { status: deleteStatus })
    })
  )
  return {
    cloud,
    deleted,
    updateRows(update) {
      rows = update(rows)
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

test('waits for every installation ACK, then each removal ACK before deleting another fixture', async () => {
  vi.useFakeTimers()
  const state = fixture()
  state.updateRows(rows =>
    rows.map(row =>
      row.installed_kind_id === 72 && row.device_id === deviceIds[2]
        ? { ...row, state: 'pending', actual_release_id: 0 }
        : row
    )
  )
  let finished = false
  const cleaning = cleanupPluginUpgradeFixtures(state.cloud, installations, 1000).then(() => {
    finished = true
  })
  await vi.advanceTimersByTimeAsync(0)
  assert.deepEqual(state.deleted, [], 'HTTP install completion does not prove every device ACK')
  assert.ok(state.cloud.queryDatabase.mock.calls.length > 0)

  state.updateRows(rows =>
    rows.map(row => ({ ...row, state: 'installed', actual_release_id: 101 }))
  )
  await vi.advanceTimersByTimeAsync(100)
  assert.deepEqual(state.deleted, [], 'An ACK for a different release must not allow cleanup')

  state.updateRows(rows => rows.map(row => ({ ...row, actual_release_id: row.desired_release_id })))
  state.updateRows(rows =>
    rows.map(row => (row.device_id === deviceIds[2] ? { ...row, last_sync_at: null } : row))
  )
  await vi.advanceTimersByTimeAsync(100)
  assert.deepEqual(state.deleted, [], 'Desired state without an ACK timestamp cannot allow cleanup')
  state.updateRows(rows => rows.map(row => ({ ...row, last_sync_at: '2026-10-30 08:21:02' })))
  await vi.advanceTimersByTimeAsync(100)
  assert.deepEqual(state.deleted, [71])
  assert.equal(finished, false, '204 alone does not prove device removal')

  state.updateRows(rows =>
    rows.filter(row => row.installed_kind_id !== 71 || row.device_id === deviceIds[2])
  )
  await vi.advanceTimersByTimeAsync(100)
  assert.deepEqual(state.deleted, [71], 'One remaining device ACK must block the next DELETE')

  state.updateRows(rows => rows.filter(row => row.installed_kind_id !== 71))
  await vi.advanceTimersByTimeAsync(100)
  assert.deepEqual(state.deleted, [71, 72])
  assert.equal(finished, false)
  state.updateRows(() => [])
  await vi.advanceTimersByTimeAsync(100)
  await cleaning
  assert.equal(finished, true)
})

test.each(['missing', 'failed'])(
  'never deletes fixtures when installation ACKs are %s',
  async failure => {
    vi.useFakeTimers()
    const state = fixture()
    state.updateRows(rows =>
      failure === 'missing' ? [] : rows.map(row => ({ ...row, state: 'failed' }))
    )
    const rejected = assert.rejects(
      cleanupPluginUpgradeFixtures(state.cloud, installations, 100),
      /did not finish installation on every online device/
    )
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    assert.deepEqual(state.deleted, [])
  }
)

test('a missing removal ACK fails cleanup before the next fixture DELETE', async () => {
  vi.useFakeTimers()
  const state = fixture()
  const rejected = assert.rejects(
    cleanupPluginUpgradeFixtures(state.cloud, installations, 100),
    /Plugin fixture 71 did not finish removal on every online device/
  )
  await vi.advanceTimersByTimeAsync(100)
  await rejected
  assert.deepEqual(state.deleted, [71])
})

test.each([200, 503])(
  'rejects DELETE status %i without retrying or deleting the next fixture',
  async deleteStatus => {
    const state = fixture({ deleteStatus })
    await assert.rejects(
      cleanupPluginUpgradeFixtures(state.cloud, installations),
      /Fixture uninstall 71 must return 204/
    )
    assert.deepEqual(state.deleted, [71])
  }
)
