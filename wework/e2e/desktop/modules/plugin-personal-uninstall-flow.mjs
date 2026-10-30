import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { waitForSnapshot } from './conversation-layout.mjs'
import { refreshPluginInventory } from './plugin-inventory-state.mjs'
import {
  accountPlugin,
  materializedPlugin,
  pathExists,
  pluginApi,
  testId,
  until,
} from './plugin-regression-fixture.mjs'
import { resultDir, WORKBENCH_READY_TIMEOUT_MS } from './shared.mjs'
import { captureVerificationScreenshot, reloadMainWindow } from './workspace-flows.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')

async function sourceFiles(root, directory = root) {
  const metadata = await lstat(directory)
  assert.ok(
    metadata.isDirectory() && !metadata.isSymbolicLink(),
    'The author source directory was replaced by a managed link'
  )
  const files = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    assert.equal(entry.isSymbolicLink(), false, 'The author source fixture became a symlink')
    if (entry.isDirectory()) Object.assign(files, await sourceFiles(root, path))
    else files[relative(root, path)] = digest(await readFile(path))
  }
  return files
}

async function snapshotPersonalSource(control, plugin) {
  const { marketplace } = JSON.parse(await control.command('getBundledPluginUpdates', 'body'))
  assert.ok(marketplace?.path, 'The real personal marketplace is unavailable')
  const sourcePath = join(marketplace.path, 'plugins', plugin.name)
  const registryPath = join(
    dirname(dirname(marketplace.path)),
    'plugin-state',
    'wework-personal-cloud-links.json'
  )
  const registry = await readFile(registryPath)
  const { cloudLinks: links } = JSON.parse(registry)
  assert.ok(Array.isArray(links), 'The native publication registry omitted cloudLinks')
  const link = links.find(item => item.localPluginName === plugin.name)
  assert.equal(
    link?.cloudPluginId,
    Number(plugin.id),
    'Author source lost its cloud Plugin identity'
  )
  assert.equal(
    link.cloudReleaseId,
    plugin.latestReleaseId,
    'Author source lost its shared Release identity'
  )
  return {
    sourcePath,
    registryPath,
    files: await sourceFiles(sourcePath),
    registryDigest: digest(registry),
    link,
  }
}

async function assertPersonalSourceUnchanged(snapshot) {
  assert.deepEqual(
    await sourceFiles(snapshot.sourcePath),
    snapshot.files,
    'Uninstall changed author source bytes'
  )
  assert.equal(
    digest(await readFile(snapshot.registryPath)),
    snapshot.registryDigest,
    'Uninstall changed the publication registry'
  )
}

async function openPersonalPlugin(control, plugin, { expectSourceConflict = false } = {}) {
  await control.command('navigate', 'body', { value: '/plugins' })
  await control.command('clickIfPresent', testId('plugin-detail-back-button'))
  await control.command('waitFor', testId('plugins-search-input'))
  await control.command('click', testId('plugins-distribution-tab-personal'))
  await control.command('fill', testId('plugins-search-input'), { value: plugin.name })
  if (expectSourceConflict) {
    // This fixture deliberately prevents account sync from taking author source
    // ownership. Verify the failed reconciliation instead of waiting for success.
    await control.command('clickIfPresent', testId('plugin-operation-notice-dismiss'))
    await control.command('clickWhenEnabled', testId('plugins-refresh-button'))
    await control.command(
      'waitFor',
      `${testId('plugin-operation-notice')}[data-notice-kind="error"]`,
      {
        text: `Plugin reconciliation failed for ${plugin.name}: PLUGIN_RUNTIME_METADATA_FAILED`,
      }
    )
    await control.command('waitFor', `${testId('plugins-refresh-button')}:not(:disabled)`)
  } else {
    await refreshPluginInventory(control, WORKBENCH_READY_TIMEOUT_MS)
  }
  await control.command('click', testId(`plugin-marketplace-row-${plugin.id}`))
  await control.command('waitFor', 'button[data-testid^="plugin-detail-actions-"]')
}

async function uninstallPersonalPluginInUi(control, plugin, options) {
  await openPersonalPlugin(control, plugin, options)
  await control.command('clickIfPresent', testId('plugin-operation-notice-dismiss'))
  await control.command('click', 'button[data-testid^="plugin-detail-actions-"]')
  await control.command('clickWhenEnabled', 'button[data-testid^="plugin-detail-uninstall-"]')
  await control.command('waitFor', testId('uninstall-plugin-dialog'))
  await control.command('clickWhenEnabled', testId('plugin-uninstall-confirm-button'))
  await control.command(
    'waitFor',
    `${testId('plugin-operation-notice')}[data-notice-kind="success"]`
  )
  assert.match(
    await control.command('getText', testId('plugin-operation-notice')),
    /已卸载|uninstalled/i
  )
}

function accountIdentity(plugin) {
  return plugin
    ? {
        id: String(plugin.metadata.labels.id),
        pluginId: plugin.spec.pluginId,
        releaseId: plugin.spec.releaseId,
        enabled: plugin.spec.enabled,
      }
    : null
}

async function assertAccountIdentity(cloud, plugin, expected) {
  assert.deepEqual(
    accountIdentity(await accountPlugin(cloud, plugin.name)),
    expected,
    'Uninstall changed another account installation'
  )
}

async function assertSharedRelease(owner, plugin, access) {
  const current = await pluginApi(owner, `/plugins/marketplace/${plugin.id}`)
  assert.equal(current.latestReleaseId, plugin.latestReleaseId)
  assert.equal(current.version, plugin.version)
  assert.deepEqual(await pluginApi(owner, `/plugins/marketplace/${plugin.id}/access`), access)
}

export async function disconnectPersonalPluginRuntime(control, cloud, plugin) {
  const runtime = JSON.parse(await control.command('getLocalExecutorStatus', 'body'))
  assert.ok(runtime.ready && runtime.deviceId, 'The local Runtime must remain ready')
  const status = JSON.parse(await control.command('disconnectLocalExecutorCloud', 'body'))
  assert.deepEqual(status, { configured: false, connected: false })
  await until(
    async () =>
      JSON.parse(
        await control.command('getPluginSyncDiagnostics', 'body', { value: runtime.deviceId })
      ),
    state => !state.backend.connected && !state.rendererConnected,
    'The real Native disconnect did not reach the renderer'
  )
  const readable = await pluginApi(cloud, `/plugins/marketplace/${plugin.id}`)
  assert.equal(readable.id, plugin.id, 'Cloud HTTP access was lost with the Runtime Socket')
  return runtime.deviceId
}

export async function restorePersonalPluginRuntime(control, deviceId) {
  await reloadMainWindow(control, 'The restored Runtime did not reconnect to desktop control')
  await control.command('waitFor', testId('new-chat-button'), {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await until(
    async () =>
      JSON.parse(await control.command('getPluginSyncDiagnostics', 'body', { value: deviceId })),
    state => state.backend.configured && state.backend.connected && state.rendererConnected,
    'The real Runtime Socket did not reconnect after restoring the renderer',
    WORKBENCH_READY_TIMEOUT_MS
  )
}

export async function switchPersonalPluginAccount(control, cloud) {
  const startedAt = Date.now()
  const user = await pluginApi(cloud, '/users/me')
  const before = JSON.parse(await control.command('getLocalExecutorStatus', 'body'))
  assert.ok(before.ready && before.deviceId, 'Account switching requires the existing device')
  const disconnected = JSON.parse(await control.command('disconnectLocalExecutorCloud', 'body'))
  assert.deepEqual(disconnected, { configured: false, connected: false })
  await control.command('setCloudSessionToken', 'body', { value: cloud.authToken })
  await restorePersonalPluginRuntime(control, before.deviceId)
  const connection = JSON.parse(
    await control.command('getLocalStorageItem', 'body', { value: 'wework.cloudConnection' })
  )
  assert.equal(connection.user.id, user.id, 'The renderer retained the previous cloud account')
  const after = JSON.parse(await control.command('getLocalExecutorStatus', 'body'))
  assert.equal(after.deviceId, before.deviceId, 'An account switch changed the existing device')
  return { userId: user.id, deviceId: after.deviceId, durationMs: Date.now() - startedAt }
}

export async function verifyAuthorSourceUninstall({
  control,
  cloudEnvironment,
  recipientCloud,
  plugin,
  access,
  codexHome,
  restartDesktopApp,
  prepareSource,
  version,
}) {
  assert.equal(
    await accountPlugin(cloudEnvironment, plugin.name),
    undefined,
    'Author no-membership case already has an account install'
  )
  const recipient = accountIdentity(await accountPlugin(recipientCloud, plugin.name))
  assert.ok(recipient, 'The other recipient must retain a real account installation')
  await prepareSource(version)
  const source = await snapshotPersonalSource(control, plugin)
  const cache = join(codexHome, 'plugins/cache/wework-personal', plugin.name)
  assert.equal(
    await pathExists(cache),
    true,
    'The author source was not installed before uninstall'
  )
  await uninstallPersonalPluginInUi(control, plugin)
  await until(
    () => pathExists(cache),
    exists => !exists,
    'Author local runtime cache survived uninstall'
  )
  await assertPersonalSourceUnchanged(source)
  await assertSharedRelease(cloudEnvironment, plugin, access)
  await assertAccountIdentity(recipientCloud, plugin, recipient)
  await openPersonalPlugin(control, plugin)
  assert.equal(
    await pathExists(cache),
    false,
    'Refresh reinstalled an explicitly removed author source'
  )
  await restartDesktopApp()
  await assertPersonalSourceUnchanged(source)
  assert.equal(
    await pathExists(cache),
    false,
    'Restart reinstalled an explicitly removed author source'
  )
  await control.command('navigate', 'body', { value: '/plugins' })
  await control.command('waitFor', testId('plugins-search-input'))
  await control.command('click', testId('plugins-distribution-tab-personal'))
  await control.command('fill', testId('plugins-search-input'), { value: plugin.name })
  await refreshPluginInventory(control, WORKBENCH_READY_TIMEOUT_MS)
  const deviceId = await disconnectPersonalPluginRuntime(control, cloudEnvironment, plugin)
  try {
    assert.deepEqual(
      await pluginApi(cloudEnvironment, `/plugins/marketplace/${plugin.id}/owner`),
      { pluginId: Number(plugin.id) },
      'The disconnected author must still pass the real HTTP ownership check'
    )
    await control.command('clickWhenEnabled', testId(`plugin-marketplace-install-${plugin.id}`))
    await control.command('waitFor', testId('install-plugin-dialog-confirm'))
    await control.command('clickWhenEnabled', testId('install-plugin-dialog-confirm'))
    await until(
      () => pathExists(join(cache, version)),
      Boolean,
      'The disconnected author source did not reinstall locally'
    )
    await control.command(
      'waitFor',
      `${testId('plugin-operation-notice')}[data-notice-kind="success"]`
    )
    await assertPersonalSourceUnchanged(source)
    await assertSharedRelease(cloudEnvironment, plugin, access)
    assert.equal(
      await accountPlugin(cloudEnvironment, plugin.name),
      undefined,
      'Reinstalling author source created a cloud account install'
    )
    const state = JSON.parse(
      await control.command('getPluginSyncDiagnostics', 'body', { value: deviceId })
    )
    assert.equal(state.backend.connected, false, 'Author reinstall reconnected the Runtime Socket')
    await captureVerificationScreenshot(control, 'personal-plugin-author-offline-reinstall.png')
  } finally {
    await restorePersonalPluginRuntime(control, deviceId)
  }
  await openPersonalPlugin(control, plugin)
  await control.command('waitFor', testId('plugin-version-submit-notice'), { text: version })
  await control.command('click', testId('plugin-version-submit-open'))
  await control.command('waitFor', testId('plugin-version-submit-drawer'))
  await control.command('fill', testId('plugin-version-submit-notes'), {
    value: 'Submit the same author source after uninstall and reinstall.',
  })
  await control.command('clickWhenEnabled', testId('plugin-version-submit-confirm'))
  const updated = await until(
    () => pluginApi(cloudEnvironment, `/plugins/marketplace/${plugin.id}`),
    item => item.version === version,
    'Reinstalled author source could not submit to the original cloud Plugin'
  )
  assert.equal(updated.id, plugin.id)
  assert.notEqual(updated.latestReleaseId, plugin.latestReleaseId)
  await waitForSnapshot(
    control,
    snapshot =>
      !snapshot.testIds.includes('plugin-version-submit-drawer') &&
      !snapshot.testIds.includes('plugin-version-submit-notice'),
    'Reinstalled source submission did not finish integrating the shared version'
  )
  assert.deepEqual(
    await pluginApi(cloudEnvironment, `/plugins/marketplace/${plugin.id}/access`),
    access
  )
  await assertAccountIdentity(recipientCloud, plugin, recipient)
  assert.deepEqual(await sourceFiles(source.sourcePath), source.files)
  await captureVerificationScreenshot(control, 'personal-plugin-author-uninstall-reinstall.png')
  return { plugin: updated, source: await snapshotPersonalSource(control, updated), recipient }
}

export async function prepareAuthorAccountInstall({
  control,
  cloudEnvironment,
  plugin,
  executorHome,
  source,
}) {
  const runtime = JSON.parse(
    await control.command('getPluginRuntimeIdentityDiagnostics', 'body', {
      value: `${cloudEnvironment.backendUrl}/api`,
    })
  )
  const installed = await pluginApi(
    cloudEnvironment,
    `/plugins/marketplace/${plugin.id}/install?device_id=${encodeURIComponent(runtime.pluginDeviceRouteId)}`,
    'POST'
  )
  const account = await accountPlugin(cloudEnvironment, plugin.name)
  assert.ok(account, 'The real backend did not create author account membership')
  const identity = accountIdentity(account)
  const failures = [
    ...(installed.sync?.plugins ?? []),
    ...(installed.sync?.results ?? []).flatMap(result => result.plugins ?? []),
  ]
  const occupied = failures.find(
    item => String(item.id) === identity.id && item.status === 'failed'
  )
  assert.equal(
    installed.sync?.success,
    false,
    'Account intent unexpectedly replaced unmanaged source'
  )
  assert.equal(occupied?.error_code, 'PLUGIN_RUNTIME_METADATA_FAILED')
  // Both the installed local cache and the author marketplace directory are
  // occupied; the guard that runs first depends on the runtime publication path.
  assert.match(
    occupied.error,
    /Plugin (?:path is occupied by an unmanaged item|marketplace entry is occupied by an unrelated source)/
  )
  // The authored directory is deliberately unmanaged. Account intent must not
  // grant the cloud synchronizer ownership of that source or its local cache.
  assert.equal(
    await materializedPlugin(executorHome, identity.id),
    null,
    'Creating account membership claimed the independent author source as a managed package'
  )
  assert.deepEqual(
    await sourceFiles(source.sourcePath),
    source.files,
    'Creating account membership replaced author source bytes'
  )
  await openPersonalPlugin(control, plugin, { expectSourceConflict: true })
  assert.equal(String(installed.plugin.metadata.labels.id), identity.id)
  return { identity }
}

export async function verifyRecipientUninstallDoesNotRemoveOwner({
  control,
  cloudEnvironment,
  recipientCloud,
  plugin,
  source,
  ownerIdentity,
}) {
  const recipient = await accountPlugin(recipientCloud, plugin.name)
  assert.ok(recipient, 'The cross-account fixture needs its own recipient membership')
  const recipientId = String(recipient.metadata.labels.id)
  assert.notEqual(recipientId, ownerIdentity.id, 'Cross-account test reused the author install ID')
  const denied = await fetch(
    `${recipientCloud.backendUrl}/api/plugins/installed/${ownerIdentity.id}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${recipientCloud.authToken}` },
      signal: AbortSignal.timeout(10_000),
    }
  )
  // The existing account-uninstall endpoint is idempotent for missing/non-owned IDs.
  assert.equal(
    denied.status,
    204,
    'The stale-ID uninstall violated the existing idempotent response contract'
  )
  await assertAccountIdentity(cloudEnvironment, plugin, ownerIdentity)
  // Remove only this recipient's own membership. The shared Home retains author source.
  await pluginApi(recipientCloud, `/plugins/installed/${recipientId}`, 'DELETE')
  assert.equal(await accountPlugin(recipientCloud, plugin.name), undefined)
  await assertAccountIdentity(cloudEnvironment, plugin, ownerIdentity)
  await uninstallPersonalPluginInUi(control, plugin)
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('uninstall-plugin-dialog'),
    'Recipient uninstall confirmation did not settle'
  )
  await assertAccountIdentity(cloudEnvironment, plugin, ownerIdentity)
  await assertPersonalSourceUnchanged(source)
  assert.equal(
    await accountPlugin(recipientCloud, plugin.name),
    undefined,
    'Uninstall restored recipient membership'
  )
  await pluginApi(recipientCloud, `/plugins/marketplace/${plugin.id}/install`, 'POST')
  const restored = await accountPlugin(recipientCloud, plugin.name)
  assert.ok(restored && restored.spec.pluginId === Number(plugin.id))
  await assertAccountIdentity(cloudEnvironment, plugin, ownerIdentity)
  await captureVerificationScreenshot(control, 'personal-plugin-recipient-stale-owner-install.png')
  return { ownerInstallId: ownerIdentity.id, recipientInstallId: recipientId }
}

export async function verifyAuthorAccountUninstall({
  control,
  cloudEnvironment,
  recipientCloud,
  plugin,
  source,
  ownerIdentity,
  executorHome,
  access,
}) {
  const recipient = accountIdentity(await accountPlugin(recipientCloud, plugin.name))
  assert.ok(recipient)
  await assertAccountIdentity(cloudEnvironment, plugin, ownerIdentity)
  await uninstallPersonalPluginInUi(control, plugin, { expectSourceConflict: true })
  await until(
    () => accountPlugin(cloudEnvironment, plugin.name),
    item => !item,
    'Author UI uninstall did not clear account membership'
  )
  await until(
    () => materializedPlugin(executorHome, ownerIdentity.id),
    item => !item,
    'Author account uninstall left a managed device record for its removed membership',
    WORKBENCH_READY_TIMEOUT_MS
  )
  await assertPersonalSourceUnchanged(source)
  await assertSharedRelease(cloudEnvironment, plugin, access)
  await assertAccountIdentity(recipientCloud, plugin, recipient)
  await captureVerificationScreenshot(control, 'personal-plugin-author-account-uninstalled.png')
  await writeFile(
    join(resultDir, 'personal-plugin-uninstall-verification.json'),
    `${JSON.stringify(
      {
        pluginId: plugin.id,
        releaseId: plugin.latestReleaseId,
        ownerInstallId: ownerIdentity.id,
        recipientInstallId: recipient.id,
        sourceFiles: source.files,
        publicationLink: source.link,
        sourcePreserved: true,
        publicationRegistryPreserved: true,
        recipientMembershipPreserved: true,
        authorAccountFixture: 'account-intent-with-unmanaged-source',
      },
      null,
      2
    )}\n`
  )
}
