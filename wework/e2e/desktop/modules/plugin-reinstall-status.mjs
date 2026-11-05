import assert from 'node:assert/strict'
import { openComposerPluginPicker } from './conversation-layout.mjs'
import { lifecyclePluginSlug, publishLifecycleRelease } from './plugin-lifecycle-package.mjs'
import {
  accountPlugin,
  assertInstallButton,
  assertInventory,
  installFixture,
  materializedPlugin,
  openPlugin,
  pluginApi,
  testId,
  uninstallInUi,
  until,
} from './plugin-regression-fixture.mjs'

export function assertReinstallResponse(reply, slug, deviceId) {
  if (reply.sync != null)
    assert.equal(reply.sync.success, true, 'The held reinstall returned a sync failure')
  const plugin = reply.plugin
  assert.equal(plugin?.spec.source.pluginKey, slug)
  assert.ok(plugin.spec.releaseId != null, 'The reinstall has no target release')
  const device = plugin.status.devices?.find(row => row.deviceId === deviceId)
  assert.equal(device?.state, 'installed', 'The requesting device did not finish the reinstall')
  assert.equal(device.actualReleaseId, plugin.spec.releaseId)
  assert.equal(device.desiredReleaseId, plugin.spec.releaseId)
  assert.ok(!device.errorCode, 'The requesting device still reports a synchronization error')
}

export function holdReinstallResponse(apiProxy, installPath) {
  // The backend projects device rows using the HTTP route, which can differ
  // from both the device-list identity and the renderer's stable identity.
  const targets = new WeakMap()
  apiProxy.rule = (entry, request) => {
    if (entry.method !== 'POST' || entry.path !== installPath) return null
    targets.set(entry, new URL(request.url, apiProxy.url).searchParams.get('device_id'))
    return 'hold-response'
  }
  return (held, slug) => {
    const target = targets.get(held)
    assert.ok(target, 'The held reinstall must target a device')
    const reply = JSON.parse(held.readHeldResponse().body.toString('utf8'))
    assertReinstallResponse(reply, slug, target)
  }
}

export async function verifyPluginReinstallStatus({
  cloud,
  control,
  apiProxy,
  executorHome,
  localDeviceId,
  evidence,
  timeoutMs,
  resultDir,
  captureScreenshot,
}) {
  const slug = lifecyclePluginSlug('coordination-e2e-reinstall-status')
  const existing = await accountPlugin(cloud, slug)
  let item
  if (existing) {
    item = {
      slug,
      pluginId: existing.spec.pluginId,
      installedId: Number(existing.metadata.labels.id),
    }
  } else {
    const release = await publishLifecycleRelease(cloud, resultDir, {
      slug,
      version: '1.0.0',
      skills: { [slug]: 'Reinstall status verification' },
    })
    item = await installFixture(cloud, control, slug, localDeviceId, timeoutMs, release)
  }
  const installPath = `/api/plugins/marketplace/${item.pluginId}/install`
  const requestStart = apiProxy.requests.length
  const installs = () =>
    apiProxy.requests
      .slice(requestStart)
      .filter(request => request.method === 'POST' && request.path === installPath)
  let held
  apiProxy.pauseDeviceDelivery(true)
  try {
    await uninstallInUi(control, item)
    await assertInstallButton(control, item)
    assert.equal(await accountPlugin(cloud, slug), undefined)
    const removedRuntime = await materializedPlugin(executorHome, item.installedId)
    assert.ok(removedRuntime, 'The transport fault did not hold the actual old runtime cleanup')
    const assertHeldResponse = holdReinstallResponse(apiProxy, installPath)
    await control.command(
      'clickWhenEnabled',
      `button${testId(`plugin-marketplace-install-${item.pluginId}`)}`
    )
    await control.command('clickWhenEnabled', testId('install-plugin-dialog-confirm'))
    const status = testId(`plugin-marketplace-install-${item.pluginId}`)
    await control.command('waitFor', status, { text: '正在安装' })
    assert.equal((await control.command('getText', status)).trim(), '正在安装')
    await captureScreenshot(control, 'plugin-reinstall-installing.png', 'body')
    apiProxy.pauseDeviceDelivery(false)
    held = await until(
      installs,
      requests => requests.some(request => request.committedResponseHeld),
      'The real reinstall did not finish its device sync',
      timeoutMs
    ).then(requests => requests.find(request => request.committedResponseHeld))
    assert.equal(held.status, 200)
    // A concurrent cleanup may already have applied the latest desired install,
    // so the endpoint can return no new sync receipt with a confirmed device row.
    assertHeldResponse(held, slug)
    assert.equal((await control.command('getText', status)).trim(), '正在安装')
    const ariaLabel = await control.command('getAttribute', status, { value: 'aria-label' })
    assert.ok(ariaLabel.startsWith('正在安装 '))
    assert.ok(!ariaLabel.includes('正在卸载'))
    await captureScreenshot(control, 'plugin-reinstall-receipt-held.png', 'body')
    // Leave the installing view after checking its real response. Reopening
    // must reconcile the committed package without requiring connector login;
    // DingTalk OAuth and message delivery are outside this lifecycle scenario.
    await control.command('click', testId('new-chat-button'))
    await held.release()
    await openPlugin(control, item)
    await control.command('waitFor', testId(`plugin-marketplace-actions-${item.pluginId}`), {
      timeoutMs,
    })
    const current = (
      await pluginApi(cloud, `/plugins/installed?device_id=${encodeURIComponent(localDeviceId)}`)
    ).items.find(plugin => plugin.spec.source.pluginKey === slug)
    assert.ok(current, 'The reinstall did not restore account membership')
    const currentId = Number(current.metadata.labels.id)
    const device = current.status.devices?.find(row => row.deviceId === localDeviceId)
    assert.equal(device?.state, 'installed')
    assert.equal(device.actualReleaseId, current.spec.releaseId)
    assert.equal(device.desiredReleaseId, current.spec.releaseId)
    const runtime = await materializedPlugin(executorHome, currentId)
    assert.ok(runtime, 'The reinstall did not publish the installed runtime')
    assert.equal(runtime.version, current.spec.version)
    await control.command('click', testId('new-chat-button'))
    await openComposerPluginPicker(control)
    await assertInventory(control, slug, true)
    await control.command('click', testId('composer-plugin-picker-button'))
    await openPlugin(control, item)
    await control.command('waitFor', testId(`plugin-marketplace-actions-${item.pluginId}`))
    await captureScreenshot(control, 'plugin-reinstall-completed.png', 'body')
    evidence.push({
      case: 'reinstall-label-over-pending-cleanup',
      pluginKey: slug,
      previousInstalledId: item.installedId,
      installedId: currentId,
      pendingLabel: '正在安装',
      ariaLabel,
      installRequests: installs(),
    })
    await pluginApi(
      cloud,
      `/plugins/installed/${currentId}?device_id=${encodeURIComponent(localDeviceId)}`,
      'DELETE'
    )
    await until(
      () => materializedPlugin(executorHome, currentId),
      plugin => !plugin,
      'The lifecycle fixture cleanup did not settle',
      timeoutMs
    )
    await until(
      () =>
        cloud.queryDatabase(
          'SELECT device_id, state FROM plugin_device_installations WHERE user_id = %s AND installed_kind_id = %s',
          [1, currentId]
        ),
      rows => rows.length === 0,
      'Other devices did not finish the lifecycle fixture cleanup',
      timeoutMs
    )
  } finally {
    apiProxy.pauseDeviceDelivery(false)
    apiProxy.rule = () => null
    if (held && !held.released) await held.release()
  }
}
