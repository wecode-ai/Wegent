import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

export const testId = value => `[data-testid="${value}"]`

export async function until(read, accept, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  do {
    const result = await read()
    if (accept(result)) return result
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  throw new Error(message)
}

export async function pluginApi(cloud, path, method = 'GET') {
  const response = await fetch(`${cloud.backendUrl}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${cloud.authToken}` },
    signal: AbortSignal.timeout(method === 'POST' ? 180_000 : 10_000),
  })
  assert.ok(response.ok, `${method} ${path.split('?')[0]}: HTTP ${response.status}`)
  return response.status === 204 ? null : response.json()
}

export async function accountPlugin(cloud, slug) {
  return (await pluginApi(cloud, '/plugins/installed')).items.find(
    item => item.spec.source.pluginKey === slug
  )
}

export async function materializedPlugin(home, installedId) {
  let manifest
  try {
    manifest = JSON.parse(await readFile(resolve(home, 'capabilities/manifest.json'), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  return (
    Object.values(manifest.plugins ?? {}).find(
      plugin => Number(plugin.installed_plugin_id) === Number(installedId) && plugin.managed
    ) ?? null
  )
}

export async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

export async function openPlugin(control, fixture) {
  await control.command('click', testId('plugins-button'))
  await control.command('waitFor', testId('plugins-search-input'))
  await control.command('click', testId('plugins-distribution-tab-all'))
  await control.command('fill', testId('plugins-search-input'), { value: fixture.slug })
}

export async function uninstallInUi(control, fixture) {
  await openPlugin(control, fixture)
  await control.command('click', testId(`plugin-marketplace-actions-${fixture.pluginId}`))
  await control.command('click', testId(`plugin-marketplace-uninstall-${fixture.pluginId}`))
  const startedAt = Date.now()
  await control.command('clickWhenEnabled', testId('plugin-uninstall-confirm-button'))
  return startedAt
}

export async function assertInstallButton(control, fixture, timeoutMs = 10_000) {
  const selector = testId(`plugin-marketplace-install-${fixture.pluginId}`)
  await control.command('waitFor', selector, { enabled: true, timeoutMs })
  assert.match((await control.command('getText', selector)).trim(), /^(Install|安装)$/)
}

export async function inventory(control) {
  return JSON.parse(await control.command('getComposerPluginInventoryDiagnostics', 'body'))
}

export async function assertInventory(control, slug, present) {
  await until(
    () => inventory(control),
    state =>
      state.sharedInventory.installedPlugins.some(item => item.pluginKey === slug) === present &&
      state.composerApps.some(item => item.pluginKey === slug) === present,
    `Shared inventory and composer disagree about ${slug}: expected present=${present}`
  )
}

export async function assertSurfaces(control, fixture, present) {
  await assertInventory(control, fixture.slug, present)
  await control.command('click', testId('plugins-manage-button'))
  await control.command(
    'waitFor',
    `${testId('plugin-management-installed-list')}, ${testId('plugin-management-empty-state')}`
  )
  const manager = await control.command('getText', testId('plugin-management-page-content'))
  assert.equal(manager.includes(fixture.slug), present, 'Manager disagrees with account membership')
  await control.command('click', testId('new-chat-button'))
  await control.command('click', testId('composer-plugin-picker-button'))
  await control.command('waitFor', testId('composer-plugin-picker'))
  await control.command('fill', testId('composer-plugin-picker-search'), { value: fixture.slug })
  const picker = JSON.parse(await control.command('snapshot', testId('composer-plugin-picker')))
  assert.equal(
    picker.testIds.includes(`composer-plugin-picker-item-plugin:${fixture.slug}`),
    present
  )
  await control.command('click', testId('composer-plugin-picker-button'))
}

export async function installFixture(cloud, control, slug, deviceId, timeoutMs) {
  const release = await cloud.publishPluginRelease({
    slug,
    version: '1.0.0',
    skills: { [slug]: `Use ${slug} for desktop regression verification` },
  })
  await pluginApi(
    cloud,
    `/plugins/marketplace/${release.pluginId}/install?device_id=${encodeURIComponent(deviceId)}`,
    'POST'
  )
  const installed = await accountPlugin(cloud, slug)
  assert.ok(installed, 'Real install did not create account membership')
  const fixture = { ...release, slug, installedId: Number(installed.metadata.labels.id) }
  await openPlugin(control, fixture)
  await control.command('click', testId('plugins-refresh-button'))
  await control.command('waitFor', testId(`plugin-marketplace-actions-${fixture.pluginId}`), {
    timeoutMs,
  })
  await until(
    () => inventory(control),
    state => state.composerApps.some(item => item.pluginKey === slug),
    'Installed fixture is missing from composer',
    timeoutMs
  )
  return fixture
}
