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

export async function pluginApi(cloud, path, method = 'GET', { signal } = {}) {
  const timeout = AbortSignal.timeout(method === 'POST' ? 180_000 : 10_000)
  const response = await fetch(`${cloud.backendUrl}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${cloud.authToken}` },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
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
    manifest = JSON.parse(await readFile(resolve(home, 'capabilities/manifest-v2.json'), 'utf8'))
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
  // The pending status span intentionally shares this test ID. Wait for the
  // actual actionable button, not just the disappearance of the installed row.
  const selector = `button${testId(`plugin-marketplace-install-${fixture.pluginId}`)}:not(:disabled)`
  const label = await control.command('waitFor', selector, { enabled: true, timeoutMs })
  assert.match(label.trim(), /^(Install|安装)$/)
}

export async function inventory(control) {
  return JSON.parse(await control.command('getComposerPluginInventoryDiagnostics', 'body'))
}

export async function completedApiResourceTimings(control, path) {
  assert.ok(path.startsWith('/api/') && !/[?#]/.test(path), 'Expected an API pathname')
  const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
  assert.ok(Number.isFinite(snapshot.timeOrigin), 'Missing renderer performance time origin')
  return snapshot.network
    .filter(
      resource =>
        ['fetch', 'xmlhttprequest'].includes(resource.initiatorType) && resource.path === path
    )
    .map(resource => ({
      path,
      startedAt: snapshot.timeOrigin + resource.startTime,
      completedAt: snapshot.timeOrigin + resource.startTime + resource.duration,
      durationMs: resource.duration,
    }))
}

export async function requestPluginExecutor(control, method, params = {}) {
  const origin = await control.command('getLocationOrigin', 'body')
  const response = await fetch(`${origin}/wework/executor/v1/rpc`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'plugin-regression', method, params }),
    signal: AbortSignal.timeout(10_000),
  })
  return { status: response.status, payload: await response.json() }
}

export async function openComposerPluginPicker(control) {
  const button = testId('composer-plugin-picker-button')
  await control.command('waitFor', button, { visible: true, enabled: true, stableMs: 250 })
  const expanded = await control.command('getAttribute', button, {
    value: 'aria-expanded',
    visible: true,
  })
  if (expanded !== 'true') await control.command('click', button, { visible: true })
  await control.command('waitFor', testId('composer-plugin-picker'), { visible: true })
}

export async function assertInventory(control, slug, present, timeoutMs = 10_000) {
  let lastState = null
  try {
    await until(
      async () => {
        lastState = await inventory(control)
        return lastState
      },
      state =>
        state.sharedInventory.installedPlugins.some(item => item.pluginKey === slug) === present &&
        state.composerApps.some(item => item.pluginKey === slug) === present,
      `Shared inventory and composer disagree about ${slug}: expected present=${present}`,
      timeoutMs
    )
  } catch (error) {
    throw new Error(
      `${error.message}; sharedInventory=${JSON.stringify(lastState?.sharedInventory ?? null)} ` +
        `composerApps=${JSON.stringify(lastState?.composerApps ?? null)} ` +
        `installedPlugins=${JSON.stringify(lastState?.installedPlugins ?? null)}`
    )
  }
}

export async function assertSurfaces(control, fixture, present, timeoutMs = 10_000) {
  assert.ok(
    Number.isSafeInteger(fixture.installedId) && fixture.installedId > 0,
    'Fixture installedId must be a positive safe integer'
  )
  await assertInventory(control, fixture.slug, present, timeoutMs)
  await control.command('click', testId('plugins-manage-button'))
  await control.command(
    'waitFor',
    `${testId('plugin-management-installed-list')}, ${testId('plugin-management-empty-state')}`
  )
  const manager = JSON.parse(
    await control.command('snapshot', testId('plugin-management-page-content'))
  )
  assert.equal(
    manager.testIds.includes(`installed-plugin-row-${fixture.installedId}`),
    present,
    'Manager disagrees with account membership'
  )
  await control.command('click', testId('new-chat-button'))
  await openComposerPluginPicker(control)
  await control.command('fill', testId('composer-plugin-picker-search'), { value: fixture.slug })
  const picker = JSON.parse(await control.command('snapshot', testId('composer-plugin-picker')))
  assert.equal(
    picker.testIds.includes(`composer-plugin-picker-item-plugin:${fixture.slug}`),
    present
  )
  await control.command('click', testId('composer-plugin-picker-button'), { visible: true })
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
  // Composer plugin catalogs load on demand. Exercise the real picker path
  // before asserting that the installed plugin reached the composer projection.
  await control.command('click', testId('new-chat-button'))
  await openComposerPluginPicker(control)
  await until(
    () => inventory(control),
    state => state.composerApps.some(item => item.pluginKey === slug),
    'Installed fixture is missing from composer',
    timeoutMs
  )
  await control.command('click', testId('composer-plugin-picker-button'), { visible: true })
  return fixture
}
