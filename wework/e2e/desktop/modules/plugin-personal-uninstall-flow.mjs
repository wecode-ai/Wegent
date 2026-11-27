import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { waitForSnapshot } from './conversation-layout.mjs'
import { refreshPluginInventory } from './plugin-inventory-state.mjs'
import { collectLocalPluginCacheDiagnostics } from './plugin-runtime-diagnostics.mjs'
import {
  accountPlugin,
  materializedPlugin,
  pathExists,
  pluginApi,
  testId,
  until,
} from './plugin-regression-fixture.mjs'
import { CLOUD_DEVICE_ID, resultDir, WORKBENCH_READY_TIMEOUT_MS } from './shared.mjs'
import { captureVerificationScreenshot } from './workspace-flows.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export const personalVersionSlug = 'desktop-e2e-personal-version'

export async function uploadPersonalVersionFixture({
  request,
  backendUrl,
  packageBytes,
  version,
  pluginSlug = personalVersionSlug,
  targets,
}) {
  const initialized = await request('/plugins/submissions/init', 'POST', {
    slug: pluginSlug,
    displayName: pluginSlug === personalVersionSlug ? 'Personal Version E2E' : pluginSlug,
    version,
    filename: `${pluginSlug}-${version}.zip`,
    sha256: digest(packageBytes),
    sizeBytes: packageBytes.length,
    listingType: 'plugin',
    purpose: 'restricted_share',
    visibility: 'personal',
    targets,
    releaseNotes: 'Verify personal release HTTP permission boundaries.',
  })
  const uploaded = await fetch(new URL(initialized.uploadUrl, backendUrl), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/zip' },
    body: packageBytes,
  })
  assert.equal(uploaded.status, 204, 'The HTTP boundary fixture package failed to upload')
  return initialized
}

export async function deletePersonalPluginListing(request, pluginId) {
  const path = `/plugins/marketplace/${pluginId}`
  const impact = await request(`${path}/delete-impact`)
  await request(path, 'DELETE', { impactRevision: impact.impactRevision, revokeAndDelete: false })
}

/** Keep the real first /complete pending until a local-only deletion is confirmed. */
export async function verifyPersonalPublicationDeletion({
  cloud,
  control,
  apiProxy,
  prepareSource,
  report,
}) {
  const name = 'author-publication-delete-race-e2e'
  const status = JSON.parse(await control.command('getLocalExecutorStatus', 'body'))
  assert.ok(status.ready && status.deviceId, 'The publication fixture requires the local Runtime')
  await waitForPersonalPluginConnection(control, status.deviceId)
  await prepareSource(name)
  const { marketplace } = JSON.parse(await control.command('getBundledPluginUpdates', 'body'))
  assert.ok(marketplace?.path, 'The real personal source marketplace is unavailable')
  const sourcePath = join(marketplace.path, 'plugins', name)
  const original = await sourceFiles(sourcePath)
  assert.equal(await accountPlugin(cloud, name), undefined)
  await control.command('uninstallInstalledPlugin', 'body', {
    value: `${name}@wework-personal`,
  })
  await control.command('navigate', 'body', { value: '/plugins' })
  await control.command('waitFor', testId('plugins-search-input'))
  await control.command('click', testId('plugins-distribution-tab-personal'))
  await control.command('fill', testId('plugins-search-input'), { value: name })
  await refreshPluginInventory(control)
  await control.command(
    'clickWhenEnabled',
    `[data-testid^="plugin-marketplace-row-"] > button[aria-label*="${name}"]`
  )
  const previousRule = apiProxy.rule
  const start = apiProxy.requests.length
  apiProxy.rule = entry =>
    entry.method === 'POST' && /^\/api\/plugins\/submissions\/\d+\/complete$/.test(entry.path)
      ? 'pause-request'
      : previousRule(entry)
  let completing
  await control.command('holdLocalExecutorRequests', 'body', {
    value: JSON.stringify({
      method: 'executor.plugins.personal.package',
      phase: 'after-response',
      maxHeldCount: 1,
    }),
  })
  try {
    await control.command('clickWhenEnabled', 'button[data-testid^="plugin-detail-toggle-"]')
    await control.command('clickWhenEnabled', testId('install-plugin-dialog-confirm'))
    await until(
      async () => JSON.parse(await control.command('getLocalExecutorRequestHoldSnapshot', 'body')),
      state => state?.heldCount === 1,
      'First publication did not reach real package creation before deletion preflight'
    )
    await control.command('clickWhenEnabled', 'button[data-testid^="plugin-detail-actions-"]')
    await control.command(
      'clickWhenEnabled',
      '[role="menuitem"][data-testid^="plugin-detail-delete-"]'
    )
    await waitForSnapshot(
      control,
      snapshot =>
        snapshot.testIds.includes('delete-personal-plugin-dialog') &&
        /本地插件源码|local source/i.test(snapshot.text),
      'Deletion preflight did not show the unpublished local source'
    )
    await control.command('releaseLocalExecutorRequestHold', 'body')
    completing = await until(
      () => apiProxy.requests.slice(start).find(entry => entry.fault === 'pause-request'),
      entry => typeof entry?.release === 'function',
      'First private publication did not issue its real /complete request'
    )
    const listing = async () =>
      (await pluginApi(cloud, '/plugins/marketplace')).items.find(item => item.name === name)
    assert.equal(await listing(), undefined, 'The paused publication was already visible')
    await control.command('clickWhenEnabled', testId('plugin-delete-confirm-button'))
    await control.command('waitFor', `${testId('plugin-delete-confirm-button')}:disabled`, {
      stableMs: 250,
    })
    assert.deepEqual(
      await sourceFiles(sourcePath),
      original,
      'Deletion removed an in-flight source'
    )
    assert.equal(completing.released, undefined)
    assert.equal(await listing(), undefined)
    report.waitedForComplete = true
    assert.equal(completing.release(), true, 'The real publication request was not released')
    await waitForSnapshot(
      control,
      snapshot =>
        snapshot.testIds.includes('delete-personal-plugin-dialog') &&
        /将删除云端插件|Delete the cloud plugin/i.test(snapshot.text),
      'Deletion did not refresh cloud impact after the in-flight publication settled'
    )
    const published = await listing()
    assert.ok(published?.latestReleaseId, 'Deletion did not recheck the newly published release')
    assert.equal(await accountPlugin(cloud, name), undefined, 'Cancellation installed the plugin')
    assert.deepEqual(await sourceFiles(sourcePath), original)
    report.revalidatedPluginId = published.id
    await control.command('clickWhenEnabled', testId('plugin-delete-confirm-button'))
    await control.command('waitFor', testId('delete-personal-plugin-dialog'), { visible: false })
    assert.equal(await pathExists(sourcePath), false, 'Confirmed deletion retained author source')
    assert.equal(await listing(), undefined, 'Confirmed deletion left the published plugin')
    assert.equal(await accountPlugin(cloud, name), undefined)
    const rows = await cloud.queryDatabase('SELECT status FROM plugins WHERE id=%s', [published.id])
    assert.deepEqual(
      rows.map(row => row.status),
      ['deleted']
    )
    assert.equal(
      apiProxy.requests
        .slice(start)
        .some(
          entry =>
            entry.method === 'POST' &&
            entry.path === `/api/plugins/marketplace/${published.id}/install`
        ),
      false,
      'Cancelled publication continued with an account installation'
    )
    report.deletedSourceAndCloud = true
    console.log(`[personal-plugin-publication-delete] PASS ${JSON.stringify(report)}`)
  } finally {
    apiProxy.rule = previousRule
    if (completing && !completing.released && !completing.cancelled) completing.release()
    await control.command('releaseLocalExecutorRequestHold', 'body')
  }
}

export async function verifyInstalledPersonalPluginDeletion({
  cloud,
  control,
  prepareSource,
  report,
}) {
  const name = 'author-installed-delete-e2e'
  const localId = `${name}@wework-personal`
  await prepareSource(name)
  await control.command('uninstallInstalledPlugin', 'body', { value: localId })
  await openPersonalPlugin(control, { name, id: localId }, { refresh: true })
  await control.command('clickWhenEnabled', 'button[data-testid^="plugin-detail-toggle-"]')
  await control.command('clickWhenEnabled', testId('install-plugin-dialog-confirm'))
  const listing = await until(
    async () =>
      (await pluginApi(cloud, '/plugins/marketplace')).items.find(item => item.name === name),
    item => Boolean(item?.latestReleaseId),
    'The installed-detail deletion fixture did not publish its private release'
  )
  const installed = await waitForAuthorCloudInstall(cloud, listing)
  const source = await snapshotPersonalSource(control, listing)
  await control.command('click', testId('plugin-detail-back-button'))
  await control.command('clickWhenEnabled', testId(`plugins-installed-strip-item-${localId}`))
  await control.command('clickWhenEnabled', testId(`plugin-detail-actions-${localId}`))
  await control.command('clickWhenEnabled', testId(`plugin-detail-delete-${localId}`))
  await control.command('clickWhenEnabled', testId('plugin-delete-confirm-button'))
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('delete-personal-plugin-dialog') &&
      /将删除云端插件|Delete the cloud plugin/i.test(snapshot.text),
    'Installed-detail deletion did not resolve its omitted cloud identity'
  )
  await assertPersonalSourceUnchanged(source)
  assert.ok(await accountPlugin(cloud, name), 'Cloud membership disappeared before confirmation')
  report.confirmedCloudImpact = true
  await control.command('clickWhenEnabled', testId('plugin-delete-confirm-button'))
  await control.command('waitFor', testId('delete-personal-plugin-dialog'), { visible: false })
  assert.equal(
    await pathExists(source.sourcePath),
    false,
    'Installed-detail deletion retained source'
  )
  assert.equal(
    await accountPlugin(cloud, name),
    undefined,
    'Installed-detail deletion retained membership'
  )
  await until(
    () =>
      materializedPlugin(
        cloud.remoteExecutorEnv.WEGENT_EXECUTOR_HOME,
        installed.metadata.labels.id
      ),
    item => !item,
    'Installed-detail deletion left an active cloud device plugin'
  )
  const rows = await cloud.queryDatabase('SELECT status FROM plugins WHERE id=%s', [listing.id])
  assert.deepEqual(
    rows.map(row => row.status),
    ['deleted']
  )
  report.deletedSourceAndCloud = true
  console.log(`[personal-plugin-installed-delete] PASS ${JSON.stringify(report)}`)
}

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

export async function snapshotPersonalSource(control, plugin) {
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

export async function assertPersonalSourceUnchanged(snapshot) {
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

async function openPersonalPlugin(control, plugin, { refresh = false, expectedVersion } = {}) {
  await control.command('navigate', 'body', { value: '/plugins' })
  await control.command('clickIfPresent', testId('plugin-detail-back-button'))
  await control.command('waitFor', testId('plugins-search-input'))
  await control.command('click', testId('plugins-distribution-tab-personal'))
  await control.command('fill', testId('plugins-search-input'), { value: plugin.name })
  if (refresh) {
    await refreshPluginInventory(control, WORKBENCH_READY_TIMEOUT_MS)
  }
  await openPersonalPluginDetail(control, plugin)
  if (expectedVersion) {
    await control.command('waitFor', testId('plugin-version-submit-notice'), {
      text: expectedVersion,
    })
  }
}

async function openPersonalPluginDetail(control, plugin) {
  await control.command('clickWhenEnabled', testId(`plugin-marketplace-row-${plugin.id}`))
  await control.command('waitFor', 'button[data-testid^="plugin-detail-actions-"]')
}

export async function uninstallPersonalPluginInUi(control, plugin, options) {
  await openPersonalPlugin(control, plugin, options)
  await control.command('clickIfPresent', testId('plugin-operation-notice-dismiss'))
  await control.command('click', 'button[data-testid^="plugin-detail-actions-"]')
  await control.command(
    'clickWhenEnabled',
    '[role="menuitem"][data-testid^="plugin-detail-uninstall-"]'
  )
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

export async function waitForAuthorCloudInstall(cloud, plugin) {
  return until(
    () => accountPlugin(cloud, plugin.name),
    item =>
      item?.spec.pluginId === Number(plugin.id) &&
      item.spec.releaseId === plugin.latestReleaseId &&
      item.status?.devices?.some(
        receipt =>
          receipt.deviceId === CLOUD_DEVICE_ID &&
          receipt.state === 'installed' &&
          receipt.actualReleaseId === plugin.latestReleaseId
      ),
    `The cloud device did not install the author's release for ${plugin.name}`
  )
}

export async function verifyUnlinkedOldPersonalPackageReinstall({
  cloud,
  request,
  plugin,
  oldPackage,
  newPackage,
  version,
}) {
  const installed = await accountPlugin(cloud, plugin.name)
  assert.ok(installed, 'The old-package reinstall fixture has no account install')
  const next = await uploadPersonalVersionFixture({
    request,
    backendUrl: cloud.backendUrl,
    packageBytes: newPackage,
    pluginSlug: plugin.name,
    version,
    targets: [],
  })
  const completed = await request(`/plugins/submissions/${next.submissionId}/complete`, 'POST')
  assert.equal(completed.submission.status, 'approved')
  assert.notEqual(completed.plugin.latestReleaseId, plugin.latestReleaseId)
  await pluginApi(cloud, `/plugins/installed/${installed.metadata.labels.id}`, 'DELETE')
  const home = cloud.remoteExecutorEnv.WEGENT_EXECUTOR_HOME
  await until(
    () => materializedPlugin(home, installed.metadata.labels.id),
    item => !item,
    'The cloud device did not remove the old-package reinstall fixture'
  )
  const path = `/plugins/marketplace/${plugin.id}`
  await deletePersonalPluginListing(request, plugin.id)
  const response = await fetch(`${cloud.backendUrl}/api/plugins/submissions/init`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cloud.authToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug: plugin.name,
      displayName: plugin.displayName,
      version: plugin.version,
      filename: `${plugin.name}.zip`,
      sha256: digest(oldPackage),
      sizeBytes: oldPackage.length,
      listingType: 'plugin',
      visibility: 'personal',
      privateFirstInstall: true,
      restoreDeleted: true,
    }),
    signal: AbortSignal.timeout(10_000),
  })
  assert.equal(response.status, 409, 'The old package did not resolve the retained plugin')
  const { detail } = await response.json()
  assert.equal(detail.code, 'PRIVATE_PLUGIN_REINSTALL_REQUIRED')
  assert.equal(detail.pluginId, Number(plugin.id))
  assert.equal(detail.releaseId, next.releaseId)
  assert.equal(await accountPlugin(cloud, plugin.name), undefined)
  await request(`${path}/install?restore_deleted=true`, 'POST')
  const restored = await waitForAuthorCloudInstall(cloud, completed.plugin)
  assert.equal(restored.metadata.labels.id, installed.metadata.labels.id)
  assert.equal((await materializedPlugin(home, restored.metadata.labels.id))?.version, version)
  return restored
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
  await control.command('reconnectLocalExecutorCloud', 'body')
  await waitForPersonalPluginConnection(control, deviceId)
}

async function waitForPersonalPluginConnection(control, deviceId) {
  await until(
    async () =>
      JSON.parse(await control.command('getPluginSyncDiagnostics', 'body', { value: deviceId })),
    state => state.backend.configured && state.backend.connected && state.rendererConnected,
    'The real Runtime Socket did not reconnect to the renderer',
    WORKBENCH_READY_TIMEOUT_MS
  )
}

export async function switchPersonalPluginAccount(control, cloud) {
  const startedAt = Date.now()
  const user = await pluginApi(cloud, '/users/me')
  assert.ok(
    typeof user.user_name === 'string' && user.user_name.trim(),
    'Cloud identity omitted its username'
  )
  const before = JSON.parse(await control.command('getLocalExecutorStatus', 'body'))
  assert.ok(before.ready && before.deviceId, 'Account switching requires the existing device')
  const disconnected = JSON.parse(await control.command('disconnectLocalExecutorCloud', 'body'))
  assert.deepEqual(disconnected, { configured: false, connected: false })
  await control.command('setCloudSessionToken', 'body', { value: cloud.authToken })
  await control.command('waitFor', testId('desktop-sidebar-account'), {
    text: user.user_name,
  })
  await waitForPersonalPluginConnection(control, before.deviceId)
  const connection = JSON.parse(
    await control.command('getLocalStorageItem', 'body', { value: 'wework.cloudConnection' })
  )
  assert.equal(connection.user.id, user.id, 'The renderer retained the previous cloud account')
  const after = JSON.parse(await control.command('getLocalExecutorStatus', 'body'))
  assert.equal(after.deviceId, before.deviceId, 'An account switch changed the existing device')
  return { userId: user.id, deviceId: after.deviceId, durationMs: Date.now() - startedAt }
}

export async function verifyPersonalSourcePersistence({
  runLifecycle,
  restartDesktopApp,
  verifyUninstalled,
}) {
  let restarts = 0
  await runLifecycle(async options => {
    assert.equal(options, undefined, 'Shared persistence must retain the author Runtime Home')
    await restartDesktopApp()
    restarts += 1
    await verifyUninstalled()
  })
  assert.equal(restarts, 2, 'The existing plugin lifecycle must execute both real restarts')
  return restarts
}

export async function verifyAuthorSourceUninstall({
  control,
  cloudEnvironment,
  recipientCloud,
  plugin,
  access,
  codexHome,
  verifyRestartPersistence,
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
  const beforeUninstall = await collectLocalPluginCacheDiagnostics(
    codexHome,
    plugin.name,
    'wework-personal'
  )
  const uninstallStartedAt = new Date().toISOString()
  try {
    await uninstallPersonalPluginInUi(control, plugin, { refresh: true, expectedVersion: version })
    await until(
      () => pathExists(cache),
      exists => !exists,
      'Author local runtime cache survived uninstall'
    )
  } finally {
    await writeFile(
      join(resultDir, 'author-source-uninstall-cache.json'),
      `${JSON.stringify(
        {
          uninstallStartedAt,
          capturedAt: new Date().toISOString(),
          before: beforeUninstall,
          after: await collectLocalPluginCacheDiagnostics(
            codexHome,
            plugin.name,
            'wework-personal'
          ),
        },
        null,
        2
      )}\n`
    )
  }
  await assertPersonalSourceUnchanged(source)
  await assertSharedRelease(cloudEnvironment, plugin, access)
  await assertAccountIdentity(recipientCloud, plugin, recipient)
  await openPersonalPlugin(control, plugin, { refresh: true })
  assert.equal(
    await pathExists(cache),
    false,
    'Refresh reinstalled an explicitly removed author source'
  )
  await verifyRestartPersistence(async () => {
    await assertPersonalSourceUnchanged(source)
    assert.equal(
      await pathExists(cache),
      false,
      'Restart reinstalled an explicitly removed author source'
    )
  })
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
  assert.equal(await pathExists(cache), false, 'Post-restart refresh reinstalled author source')
  const deviceId = await disconnectPersonalPluginRuntime(control, cloudEnvironment, plugin)
  try {
    assert.deepEqual(
      await pluginApi(cloudEnvironment, `/plugins/marketplace/${plugin.id}/owner`),
      { pluginId: Number(plugin.id) },
      'The disconnected author must still pass the real HTTP ownership check'
    )
    await control.command('clickIfPresent', testId('plugin-operation-notice-dismiss'))
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
    assert.match(
      await control.command('getText', testId('plugin-operation-notice')),
      /已安装|installed/i
    )
    await assertPersonalSourceUnchanged(source)
    await assertSharedRelease(cloudEnvironment, plugin, access)
    const cloudInstall = await waitForAuthorCloudInstall(cloudEnvironment, plugin)
    const installedId = cloudInstall.metadata.labels.id
    const state = JSON.parse(
      await control.command('getPluginSyncDiagnostics', 'body', { value: deviceId })
    )
    assert.equal(state.backend.connected, false, 'Author reinstall reconnected the Runtime Socket')
    assert.equal(state.rendererConnected, false, 'Author reinstall reconnected the renderer')
    await assertAccountIdentity(recipientCloud, plugin, recipient)
    await captureVerificationScreenshot(control, 'personal-plugin-author-offline-reinstall.png')
    // The following version submission uses the editable source without account membership.
    await pluginApi(cloudEnvironment, `/plugins/installed/${installedId}`, 'DELETE')
    await assertAccountIdentity(cloudEnvironment, plugin, null)
    await until(
      () =>
        materializedPlugin(cloudEnvironment.remoteExecutorEnv.WEGENT_EXECUTOR_HOME, installedId),
      item => !item,
      'Cleaning up the disconnected reinstall left the package on the cloud device'
    )
  } finally {
    await restorePersonalPluginRuntime(control, deviceId)
  }
  await openPersonalPluginDetail(control, plugin)
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
}) {
  const source = await snapshotPersonalSource(control, plugin)
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
  const results = [
    ...(installed.sync?.plugins ?? []),
    ...(installed.sync?.results ?? []).flatMap(result => result.plugins ?? []),
  ]
  const preserved = results.find(
    item => String(item.id) === identity.id && item.status === 'source_preserved'
  )
  assert.equal(installed.sync?.success, true, 'The author source prevented account synchronization')
  assert.ok(preserved, 'The author source must be acknowledged separately from a cloud runtime')
  const registered = await materializedPlugin(executorHome, identity.id)
  assert.equal(
    registered?.materialization,
    'author_source',
    'Account membership must retain the independent author source'
  )
  assert.deepEqual(
    await sourceFiles(source.sourcePath),
    source.files,
    'Creating account membership replaced author source bytes'
  )
  await openPersonalPlugin(control, plugin, { refresh: true })
  assert.equal(String(installed.plugin.metadata.labels.id), identity.id)
  return { identity, source }
}

export async function resetPersonalRecipientAccount({
  cloudEnvironment,
  recipientCloud,
  plugin,
  source,
  recipient,
  access,
}) {
  // The author lifecycle has finished checking this exact membership. Remove
  // only the recipient's fixture so its final UI install starts without intent.
  assert.ok(recipient?.id, 'The recipient fixture identity is required')
  await assertAccountIdentity(recipientCloud, plugin, recipient)
  await pluginApi(recipientCloud, `/plugins/installed/${recipient.id}`, 'DELETE')
  assert.equal(
    await accountPlugin(recipientCloud, plugin.name),
    undefined,
    'The managed-install fixture retained recipient membership'
  )
  await assertAccountIdentity(cloudEnvironment, plugin, null)
  await assertPersonalSourceUnchanged(source)
  await assertSharedRelease(cloudEnvironment, plugin, access)
  return recipient.id
}

async function assertIdempotentRecipientUninstall(recipientCloud, installedId) {
  const response = await fetch(
    `${recipientCloud.backendUrl}/api/plugins/installed/${installedId}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${recipientCloud.authToken}` },
      signal: AbortSignal.timeout(10_000),
    }
  )
  // The account-uninstall endpoint is idempotent for missing/non-owned IDs.
  assert.equal(
    response.status,
    204,
    'The stale-ID uninstall violated the existing idempotent response contract'
  )
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
  await assertIdempotentRecipientUninstall(recipientCloud, ownerIdentity.id)
  await assertAccountIdentity(cloudEnvironment, plugin, ownerIdentity)
  // The caller already verified the recipient menu. This shared native home
  // still contains the author's source, so reconciling the recipient's package
  // would correctly reject replacing it before this account-only uninstall.
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
  // With no native install or account membership, refresh correctly removes
  // the UI uninstall action. Exercise both stale IDs at the real API boundary.
  for (const staleId of [recipientId, ownerIdentity.id]) {
    await assertIdempotentRecipientUninstall(recipientCloud, staleId)
    await assertAccountIdentity(cloudEnvironment, plugin, ownerIdentity)
    await assertPersonalSourceUnchanged(source)
    assert.equal(
      await accountPlugin(recipientCloud, plugin.name),
      undefined,
      'A no-membership uninstall restored recipient membership'
    )
  }
  await pluginApi(recipientCloud, `/plugins/marketplace/${plugin.id}/install`, 'POST')
  const restored = await accountPlugin(recipientCloud, plugin.name)
  assert.ok(restored && restored.spec.pluginId === Number(plugin.id))
  await assertAccountIdentity(cloudEnvironment, plugin, ownerIdentity)
  await captureVerificationScreenshot(control, 'personal-plugin-recipient-stale-owner-install.png')
  return {
    ownerInstallId: ownerIdentity.id,
    recipientInstallId: recipientId,
    absentRecipientUninstallVerified: true,
  }
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
  await uninstallPersonalPluginInUi(control, plugin, { refresh: true })
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
