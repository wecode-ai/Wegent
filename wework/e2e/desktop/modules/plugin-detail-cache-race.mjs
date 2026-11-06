import assert from 'node:assert/strict'
import { inventory, requestPluginExecutor, testId, until } from './plugin-regression-fixture.mjs'
import { runtimeTransportGates } from './runtime-transport-gates.mjs'

export function assertPluginDetailMembership(before, after, pluginName) {
  const member = state => state.installedPlugins.find(plugin => plugin.pluginKey === pluginName)
  const expected = member(before.sharedInventory)
  assert.ok(expected, 'The race needs confirmed shared membership')
  assert.equal(
    after.sharedInventory.deviceId,
    before.sharedInventory.deviceId,
    'Old detail crossed device scope'
  )
  assert.deepEqual(
    member(after.sharedInventory),
    expected,
    'Old detail overwrote shared membership'
  )
  // A cleared or partial adapter peek is not an uninstall. A successful native
  // read, or an existing adapter member, must still preserve the confirmed state.
  if (member(after) || after.installedSourceReads.codex?.status === 'fulfilled') {
    assert.deepEqual(member(after), member(before), 'Old detail overwrote adapter membership')
  }
}

// Hold original Runtime detail bytes while a real management action changes membership.
export async function verifyPluginDetailCacheRace({
  control,
  item,
  openDetail,
  backToList,
  refreshCatalog,
  entry,
}) {
  const gates = runtimeTransportGates(control)
  const detailGate = 'plugin-detail-before-disable'
  const manifestGate = 'plugin-detail-after-disable-manifest'
  const toggle = testId(`installed-plugin-toggle-${item.id}`)
  const member = state => state.installedPlugins.find(plugin => plugin.pluginKey === item.name)
  const sharedMember = state => member(state.sharedInventory)
  const read = () => inventory(control)
  try {
    await refreshCatalog()
    await gates.arm({
      id: detailGate,
      kind: 'response',
      name: 'codex.app_server_request',
      where: [
        { path: 'params.method', equals: 'plugin/read' },
        { path: 'params.params.pluginName', equals: item.name },
      ],
    })
    await openDetail(item)
    const held = await gates.wait(detailGate)
    assert.equal(held.deliveries, 0)
    assert.equal(held.value.result.plugin.summary.enabled, true)
    await backToList()
    await control.command('click', testId('plugins-manage-button'))
    await control.command('waitFor', `${toggle}[aria-checked="true"]`, { enabled: true })
    await control.command('clickWhenEnabled', toggle)
    await control.command('waitFor', `${toggle}[aria-checked="false"]`, { enabled: true })
    const before = await until(
      async () => {
        const state = await read()
        entry.beforeReleaseInventory = state
        return state
      },
      state => member(state)?.enabled === false && sharedMember(state)?.enabled === false,
      'The real management disable did not reach the adapter inventory'
    )
    entry.beforeRelease = member(before)
    await gates.arm({
      id: manifestGate,
      kind: 'response',
      name: 'executor.plugins.manifest.read',
      hold: false,
      where: [{ path: 'params.pluginName', equals: item.name }],
    })
    await gates.release(detailGate)
    // Manifest is the last awaited transport in detail expansion. Inspect the
    // cache on the next renderer command, without another inventory refresh.
    const completed = await gates.wait(manifestGate)
    assert.equal(completed.deliveries, 1)
    const after = await read()
    entry.afterReleaseInventory = after
    entry.afterRelease = member(after)
    assertPluginDetailMembership(before, after, item.name)
    await control.command('waitFor', `${toggle}[aria-checked="false"]`, { enabled: true })
    entry.oldDetailDelivered = (await gates.read(detailGate)).deliveries === 1
    assert.ok(entry.oldDetailDelivered)
  } finally {
    await gates.reset()
    await backToList()
    await control.command('click', testId('plugins-manage-button'))
    const state = await read()
    if (member(state)?.enabled === false) {
      await control.command('clickWhenEnabled', toggle)
      await control.command('waitFor', `${toggle}[aria-checked="true"]`, { enabled: true })
    }
    await control.command('click', testId('plugin-management-back-button'))
    await until(
      read,
      state => member(state)?.enabled === true,
      'The isolated race fixture did not restore its original enabled state'
    )
  }
}

// Delay only the response: both writes still run through the real Codex settings path.
export async function verifyPluginSettingsWriteRace({
  control,
  item,
  openDetail,
  backToList,
  entry,
}) {
  const gates = runtimeTransportGates(control)
  const oldGate = 'plugin-settings-old-disable'
  const newGate = 'plugin-settings-new-enable'
  const key = `skill:${item.qualifiedSkill}`
  const toggle = testId(`plugin-component-toggle-${key}`)
  let skillPath = null
  const member = state =>
    state.sharedInventory.installedPlugins.find(plugin => plugin.pluginKey === item.name)
  try {
    await openDetail(item)
    await control.command('waitFor', `${toggle}[aria-checked="true"]`, { enabled: true })
    await gates.arm({
      id: oldGate,
      kind: 'response',
      name: 'codex.app_server_request',
      where: [
        { path: 'params.method', equals: 'skills/config/write' },
        { path: 'params.params.enabled', equals: false },
      ],
    })
    await control.command('clickWhenEnabled', toggle)
    const held = await gates.wait(oldGate)
    skillPath = held.value.params.params.path
    assert.equal(held.deliveries, 0)
    assert.equal(held.value.result.effectiveEnabled, false)
    await control.command('waitFor', `${toggle}[aria-checked="false"]`, { enabled: true })
    await gates.arm({
      id: newGate,
      kind: 'response',
      name: 'codex.app_server_request',
      hold: false,
      where: [
        { path: 'params.method', equals: 'skills/config/write' },
        { path: 'params.params.enabled', equals: true },
      ],
    })
    const beforeNewSave = (await inventory(control)).sharedInventory.mutationRevision
    await control.command('clickWhenEnabled', toggle)
    const newer = await gates.wait(newGate)
    assert.equal(newer.value.result.effectiveEnabled, true)
    entry.beforeRelease = member(
      await until(
        () => inventory(control),
        state =>
          state.sharedInventory.mutationRevision > beforeNewSave &&
          member(state)?.componentStates[key] === true,
        'The newer real skill enable did not reach shared inventory'
      )
    )
    await gates.release(oldGate)
    assert.equal((await gates.read(oldGate)).deliveries, 1)
    entry.afterRelease = member(await inventory(control))
    assert.deepEqual(
      entry.afterRelease,
      entry.beforeRelease,
      'The older save replaced the newer component state'
    )
    await control.command('waitFor', `${toggle}[aria-checked="true"]`, { enabled: true })
    entry.oldResponseDeliveredAfterNewerSave = true
  } finally {
    await gates.reset()
    // Restore through the production write path even if an assertion failed mid-race.
    const restored = await requestPluginExecutor(control, 'codex.app_server_request', {
      method: 'skills/config/write',
      params: { path: skillPath, name: skillPath ? null : item.qualifiedSkill, enabled: true },
    })
    assert.equal(restored.payload.result?.effectiveEnabled, true)
    await backToList()
  }
}
