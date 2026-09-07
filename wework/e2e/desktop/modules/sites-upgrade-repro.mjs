import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { x as extractTar } from 'tar'
import { fetchJson, resultDir } from './shared.mjs'
import { captureVerificationScreenshot } from './workspace-flows.mjs'

export async function verifySitesUpgrade({ cloudEnvironment: env, control, codexHome, setPhase }) {
  const deviceId = (
    await readFile(join(resultDir, 'electron-user-data/desktop-device-id'), 'utf8')
  ).trim()
  const headers = { Authorization: `Bearer ${env.authToken}`, 'Content-Type': 'application/json' }
  const request = (path, method = 'GET', body) =>
    fetchJson(`${env.backendUrl}/api${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  const evidence = []
  const capture = async label => {
    const installed = await request(`/plugins/installed?device_id=${deviceId}`)
    const market = await request(`/plugins/marketplace?device_id=${deviceId}`)
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    const item = market.items.find(item => item.name === 'wegent-sites')
    evidence.push({
      label,
      time: new Date().toISOString(),
      item,
      installed: installed.items.filter(item => item.spec.source.pluginKey === 'wegent-sites'),
      snapshot,
    })
    await writeFile(
      join(resultDir, 'sites-upgrade-evidence.json'),
      JSON.stringify(evidence, null, 2)
    )
    await captureVerificationScreenshot(control, `sites-${label}.png`)
    console.log(
      `[sites-repro] ${label}: ${JSON.stringify({ version: item?.version, update: item?.updateAvailable, device: item?.currentDeviceInstallation })}`
    )
    return { item, snapshot }
  }
  const archiveRoot = resolve(import.meta.dirname, '../fixtures/sites-upgrade')
  const fixtureRoot = join(resultDir, 'sites-upgrade-fixtures')
  for (const version of ['old', 'new']) {
    const cwd = join(fixtureRoot, version)
    await mkdir(cwd, { recursive: true })
    await extractTar({ file: join(archiveRoot, `${version}.tar.gz`), cwd })
  }
  setPhase('sites-old-install')
  const old = await env.publishPluginRelease({
    slug: 'wegent-sites',
    version: '0.1.1+20260804',
    packageRoot: join(fixtureRoot, 'old'),
  })
  await request(`/plugins/marketplace/${old.pluginId}/install?device_id=${deviceId}`, 'POST')
  const installs = await request(`/plugins/installed?device_id=${deviceId}`)
  const installed = installs.items.find(item => item.spec.pluginId === old.pluginId)
  assert.ok(installed, 'Old sites install is missing')
  const installedId = installed.metadata.labels.id
  await request(`/plugins/installed/${installedId}?device_id=${deviceId}`, 'PUT', {
    updatePolicy: 'manual',
  })
  assert.equal(
    JSON.parse(
      await readFile(
        join(
          codexHome,
          'plugins/cache/wegent/wegent-sites/0.1.1+20260804/.codex-plugin/plugin.json'
        ),
        'utf8'
      )
    ).version,
    '0.1.1+20260804'
  )
  await control.command('click', '[data-testid="plugins-button"]')
  await control.command('waitFor', `[data-testid="plugin-marketplace-row-${old.pluginId}"]`, {
    timeoutMs: 30000,
  })
  await control.command('click', `[data-testid="plugin-marketplace-row-${old.pluginId}"]`)
  await capture('01-old-installed')
  setPhase('sites-publish-current')
  await env.publishPluginRelease({
    slug: 'wegent-sites',
    version: '0.3.1',
    packageRoot: join(fixtureRoot, 'new'),
  })
  // The product revalidates the marketplace every sixty seconds.
  console.log('[sites-repro] Waiting for the normal sixty-second catalog refresh')
  await control.command('waitFor', '[data-testid^="plugin-detail-toggle-"]', {
    text: '更新',
    timeoutMs: 75000,
  })
  await capture('02-update-offered')
  setPhase('sites-click-update')
  await control.command('click', '[data-testid^="plugin-detail-toggle-"]')
  await control.command('waitFor', '[data-testid="plugin-update-confirm-button"]')
  await captureVerificationScreenshot(control, 'sites-update-confirmation.png')
  await control.command('click', '[data-testid="plugin-update-confirm-button-cancel-button"]')
  const cancelled = await capture('02b-update-cancelled')
  assert.equal(cancelled.item.currentDeviceInstallation.actualReleaseId, old.releaseId)
  await control.command('click', '[data-testid^="plugin-detail-toggle-"]')
  await control.command('waitFor', '[data-testid="plugin-update-confirm-button"]')
  await control.command('click', '[data-testid="plugin-update-confirm-button"]')
  await control.command('waitFor', '[data-testid^="plugin-detail-toggle-"]', {
    text: '立即对话',
    timeoutMs: 30000,
  })
  await capture('03-after-update-click')
  console.log('[sites-repro] Observing update and its next catalog refresh')
  await new Promise(resolve => setTimeout(resolve, 65000))
  const refreshed = await capture('04-after-refresh')
  const currentManifestPath = join(
    codexHome,
    'plugins/cache/wegent/wegent-sites/0.3.1/.codex-plugin/plugin.json'
  )
  const currentManifest = JSON.parse(await readFile(currentManifestPath, 'utf8'))
  assert.equal(currentManifest.version, '0.3.1')
  await writeFile(
    join(resultDir, 'sites-actual-manifest-after-update.json'),
    JSON.stringify(currentManifest, null, 2)
  )
  setPhase('sites-uninstall')
  await control.command('click', `[data-testid="plugin-detail-actions-${installedId}"]`)
  await control.command('waitFor', `[data-testid="plugin-detail-uninstall-${installedId}"]`)
  await control.command('click', `[data-testid="plugin-detail-uninstall-${installedId}"]`)
  await control.command('click', '[data-testid="plugin-uninstall-confirm-button"]')
  await new Promise(resolve => setTimeout(resolve, 3000))
  await control.command('waitFor', '[data-testid^="plugin-detail-toggle-"]', { text: '安装插件' })
  const uninstalled = await capture('05-after-uninstall')
  assert.ok(
    !uninstalled.snapshot.text.includes('立即对话'),
    'Uninstalled detail must not offer chat'
  )
  const remaining = await request(`/plugins/installed?device_id=${deviceId}`)
  assert.equal(
    remaining.items.some(item => item.spec.pluginId === old.pluginId),
    false,
    'Uninstall left the cloud install active'
  )
  await assert.rejects(access(currentManifestPath), { code: 'ENOENT' })
  setPhase('sites-reinstall')
  await control.command('click', '[data-testid="plugin-detail-back-button"]')
  await control.command('waitFor', `[data-testid="plugin-marketplace-row-${old.pluginId}"]`)
  await control.command('click', `[data-testid="plugin-marketplace-row-${old.pluginId}"]`)
  await capture('06-reopened-after-uninstall')
  await control.command('click', '[data-testid^="plugin-detail-toggle-"]')
  await control.command('waitFor', '[data-testid="install-plugin-dialog-confirm"]', {
    timeoutMs: 30000,
  })
  await control.command('click', '[data-testid="install-plugin-dialog-confirm"]')
  await control.command('waitFor', '[data-testid^="plugin-detail-toggle-"]', {
    text: '立即对话',
    timeoutMs: 30000,
  })
  await capture('07-reinstalled')
  assert.equal(
    JSON.parse(
      await readFile(
        join(codexHome, 'plugins/cache/wegent/wegent-sites/0.3.1/.codex-plugin/plugin.json'),
        'utf8'
      )
    ).version,
    '0.3.1'
  )
  assert.equal(
    refreshed.item.updateAvailable,
    false,
    'Reproduced: successfully installed 0.3.1 still offers update after refresh'
  )
  // The next checkpoint section verifies release notifications outside this page.
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', '[data-testid="chat-message-input"]')
}
