import assert from 'node:assert/strict'
import { inventory, testId, until } from './plugin-regression-fixture.mjs'
import { runtimeTransportGates } from './runtime-transport-gates.mjs'

// Hold original Runtime detail bytes while a real management action changes membership.
export async function verifyPluginDetailCacheRace({
  control,
  item,
  openDetail,
  backToList,
  entry,
}) {
  const gates = runtimeTransportGates(control)
  const detailGate = 'plugin-detail-before-disable'
  const manifestGate = 'plugin-detail-after-disable-manifest'
  const toggle = testId(`installed-plugin-toggle-${item.id}`)
  const member = state => state.installedPlugins.find(plugin => plugin.pluginKey === item.name)
  const read = () => inventory(control)
  try {
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
      read,
      state => member(state)?.enabled === false,
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
    entry.afterRelease = member(await read())
    assert.deepEqual(
      entry.afterRelease,
      entry.beforeRelease,
      'Old detail overwrote the newer disabled membership'
    )
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
