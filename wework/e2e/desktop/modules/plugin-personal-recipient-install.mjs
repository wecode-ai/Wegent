import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { waitForSnapshot } from './conversation-layout.mjs'
import { writeCodexConfig } from './desktop-build-flows.mjs'
import { waitForBundledPluginMarketplace } from './plugin-inventory-state.mjs'
import {
  accountPlugin,
  materializedPlugin,
  pathExists,
  testId,
  until,
} from './plugin-regression-fixture.mjs'
import {
  disconnectPersonalPluginRuntime,
  restorePersonalPluginRuntime,
} from './plugin-personal-uninstall-flow.mjs'
import { resultDir, WORKBENCH_READY_TIMEOUT_MS } from './shared.mjs'
import { captureVerificationScreenshot } from './workspace-flows.mjs'

async function readyExecutor(control) {
  return until(
    async () => JSON.parse(await control.command('getLocalExecutorStatus', 'body')),
    status => status.ready === true && Boolean(status.deviceId),
    'The isolated recipient executor did not become ready',
    WORKBENCH_READY_TIMEOUT_MS
  )
}

async function installSharedPlugin({ control, recipientCloud, plugin, executorHome, setPhase }) {
  assert.equal(
    await accountPlugin(recipientCloud, plugin.name),
    undefined,
    'The recipient fixture already has account membership before the UI install'
  )
  await control.command('navigate', 'body', { value: '/plugins' })
  await control.command('waitFor', testId('plugins-search-input'))
  await control.command('click', testId('plugins-distribution-tab-personal'))
  await control.command('fill', testId('plugins-search-input'), { value: plugin.name })
  setPhase('wait-shared-plugin')
  await control.command('waitFor', testId(`plugin-marketplace-install-${plugin.id}`), {
    enabled: true,
  })
  setPhase('verify-disconnected-recipient-gate')
  const deviceId = await disconnectPersonalPluginRuntime(control, recipientCloud, plugin)
  try {
    await control.command('clickWhenEnabled', testId(`plugin-marketplace-install-${plugin.id}`))
    await control.command(
      'waitFor',
      `${testId('plugin-operation-notice')}[data-notice-kind="error"]`
    )
    assert.match(
      await control.command('getText', testId('plugin-operation-notice')),
      /当前设备未连接到云端|This device is not connected to the cloud/i
    )
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    assert.equal(
      snapshot.testIds.includes('install-plugin-dialog-confirm'),
      false,
      'The disconnected recipient bypassed the cloud installation gate'
    )
    assert.equal(
      await accountPlugin(recipientCloud, plugin.name),
      undefined,
      'The disconnected recipient created cloud account membership'
    )
    await captureVerificationScreenshot(control, 'personal-plugin-recipient-offline-blocked.png')
  } finally {
    await restorePersonalPluginRuntime(control, deviceId)
  }
  setPhase('open-install-confirmation')
  await control.command('clickWhenEnabled', testId(`plugin-marketplace-install-${plugin.id}`))
  await control.command('waitFor', testId('install-plugin-dialog-confirm'))
  setPhase('confirm-installation')
  await control.command('clickWhenEnabled', testId('install-plugin-dialog-confirm'))
  setPhase('wait-account-membership')
  const account = await until(
    () => accountPlugin(recipientCloud, plugin.name),
    installed => installed?.spec.releaseId === plugin.latestReleaseId,
    'The recipient UI install did not create real membership for the shared release',
    WORKBENCH_READY_TIMEOUT_MS
  )
  const installedId = Number(account.metadata.labels.id)
  assert.ok(Number.isSafeInteger(installedId) && installedId > 0)
  assert.equal(account.spec.pluginId, Number(plugin.id))
  assert.equal(account.spec.source.type, 'marketplace')
  assert.equal(account.spec.origin, 'market')
  setPhase('wait-managed-package')
  const managed = await until(
    () => materializedPlugin(executorHome, installedId),
    entry => entry?.version === plugin.version && Boolean(entry.runtime?.codex_link),
    'The recipient account install did not materialize a managed runtime package',
    WORKBENCH_READY_TIMEOUT_MS
  )
  return { installedId, managed, disconnectedInstallBlocked: true }
}

async function captureRecipientFailure(control, phase) {
  const evidence = await Promise.allSettled([
    control
      .command('snapshot', 'body', { timeoutMs: 5000 })
      .then(snapshot =>
        writeFile(
          join(resultDir, 'personal-plugin-recipient-managed-install-failure.json'),
          `${JSON.stringify({ phase, snapshot: JSON.parse(snapshot) }, null, 2)}\n`,
          'utf8'
        )
      ),
    control.command('capture', 'body', { timeoutMs: 5000 }).then(dataUrl => {
      const prefix = 'data:image/png;base64,'
      assert.ok(dataUrl.startsWith(prefix), 'Recipient failure screenshot did not return PNG data')
      return writeFile(
        join(resultDir, 'personal-plugin-recipient-managed-install-failure.png'),
        Buffer.from(dataUrl.slice(prefix.length), 'base64')
      )
    }),
  ])
  console.log(
    `[personal-plugin-recipient] failure-evidence snapshot=${evidence[0].status} screenshot=${evidence[1].status}`
  )
}

async function assertManagedPackage(plugin, managed) {
  assert.equal(managed.managed, true)
  assert.equal(managed.cloud_plugin_id, Number(plugin.id))
  assert.equal(managed.name, plugin.name)
  assert.equal(managed.version, plugin.version)
  assert.ok(managed.store_path)
  const [stored, runtime] = await Promise.all([
    readFile(join(managed.store_path, '.codex-plugin/plugin.json'), 'utf8'),
    readFile(join(managed.runtime.codex_link, '.codex-plugin/plugin.json'), 'utf8'),
  ])
  for (const body of [stored, runtime]) {
    const manifest = JSON.parse(body)
    assert.equal(manifest.name, plugin.name)
    assert.equal(manifest.version, plugin.version)
  }
  assert.equal(runtime, stored, 'The recipient runtime manifest differs from its managed package')
  const [storedSkill, runtimeSkill] = await Promise.all([
    readFile(join(managed.store_path, 'skills/version-check/SKILL.md'), 'utf8'),
    readFile(join(managed.runtime.codex_link, 'skills/version-check/SKILL.md'), 'utf8'),
  ])
  assert.equal(runtimeSkill, storedSkill)
  assert.ok(storedSkill.includes(`Release ${plugin.version}.`))
}

async function assertRecipientActions(control, plugin) {
  await control.command('clickWhenEnabled', testId(`plugin-marketplace-row-${plugin.id}`))
  const primary = 'button[data-testid^="plugin-detail-toggle-"]'
  await control.command('waitFor', primary)
  await until(
    () => control.command('getText', primary),
    label => /^(立即对话|Start chat)$/.test(label.trim()),
    'The installed recipient plugin did not become usable in the detail view'
  )
  await control.command('waitFor', primary, { enabled: true })
  await control.command('click', 'button[data-testid^="plugin-detail-actions-"]')
  await waitForSnapshot(
    control,
    snapshot =>
      !snapshot.testIds.some(
        id =>
          id.startsWith('plugin-detail-edit-') ||
          id.startsWith('plugin-detail-share-') ||
          id.startsWith('plugin-detail-delete-')
      ) &&
      !snapshot.testIds.includes('plugin-detail-manage-access') &&
      !snapshot.testIds.includes('plugin-version-submit-open') &&
      snapshot.testIds.some(id => id.startsWith('plugin-detail-uninstall-')),
    'A real recipient managed installation exposed source-owner actions'
  )
}

export async function verifyPersonalRecipientManagedInstall({
  cloudEnvironment,
  control,
  restartDesktopApp,
  plugin,
  recipientToken,
  recipientId,
  userDataDirectory,
}) {
  assert.ok(userDataDirectory, 'The initialized Electron profile is required')
  assert.ok(control.url, 'The existing synthetic model server URL is required')
  const recipientRoot = join(resultDir, 'personal-recipient-device')
  const recipientExecutorHome = join(recipientRoot, 'executor-home')
  const recipientCodexHome = join(recipientExecutorHome, 'codex')
  await writeCodexConfig(recipientCodexHome, control.url, '[features]\nplugins = true\n')
  const ownerRuntime = await readyExecutor(control)
  const ownerMarketplace = await waitForBundledPluginMarketplace(
    control,
    WORKBENCH_READY_TIMEOUT_MS
  )
  assert.ok(ownerMarketplace?.path, 'The owner personal marketplace is unavailable')
  const recipientCloud = { backendUrl: cloudEnvironment.backendUrl, authToken: recipientToken }
  let phase = 'owner-runtime-ready'
  const setPhase = value => {
    phase = value
    console.log(`[personal-plugin-recipient] phase=${value}`)
  }
  try {
    setPhase('restart-recipient')
    // Reuse the initialized Electron/Core profile and stable device. Only plugin
    // storage is isolated so the recipient cannot adopt the author's source.
    await restartDesktopApp({
      appEnvironmentOverrides: {
        WEGENT_EXECUTOR_HOME: recipientExecutorHome,
        WEGENT_CODEX_HOME: recipientCodexHome,
        CODEX_HOME: recipientCodexHome,
        WEWORK_USER_DATA_DIR: userDataDirectory,
        WEWORK_E2E_CLOUD_TOKEN: recipientToken,
      },
    })
    await control.command('clickIfPresent', testId('telemetry-consent-decline'))
    setPhase('wait-recipient-runtime')
    const recipientRuntime = await readyExecutor(control)
    assert.equal(recipientRuntime.deviceId, ownerRuntime.deviceId)
    const connection = JSON.parse(
      await control.command('getLocalStorageItem', 'body', { value: 'wework.cloudConnection' })
    )
    assert.equal(connection.user.id, recipientId, 'The clean Runtime loaded the wrong account')
    const recipientMarketplace = await waitForBundledPluginMarketplace(
      control,
      WORKBENCH_READY_TIMEOUT_MS
    )
    assert.ok(recipientMarketplace?.path, 'The recipient personal marketplace is unavailable')
    assert.notEqual(
      recipientMarketplace.path,
      ownerMarketplace.path,
      'The recipient runtime reused the author source directory'
    )
    assert.equal(
      await pathExists(join(recipientMarketplace.path, 'plugins', plugin.name)),
      false,
      'The recipient managed-install fixture already contains author source'
    )
    setPhase('open-shared-plugin')
    const { installedId, managed, disconnectedInstallBlocked } = await installSharedPlugin({
      control,
      recipientCloud,
      plugin,
      executorHome: recipientExecutorHome,
      setPhase,
    })
    setPhase('verify-managed-package')
    await assertManagedPackage(plugin, managed)
    setPhase('verify-recipient-actions')
    await assertRecipientActions(control, plugin)
    await captureVerificationScreenshot(control, 'personal-plugin-recipient-managed-install.png')
    setPhase('complete')
    return {
      deviceId: recipientRuntime.deviceId,
      runtimeInstanceId: recipientRuntime.runtimeInstanceId,
      installedId,
      managed,
      disconnectedInstallBlocked,
    }
  } catch (error) {
    console.log(`[personal-plugin-recipient] failed-phase=${phase}`)
    await captureRecipientFailure(control, phase)
    throw error
  }
}
