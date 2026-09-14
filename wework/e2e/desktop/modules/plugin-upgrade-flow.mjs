import assert from 'node:assert/strict'
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fetchJson, resultDir } from './shared.mjs'
import { captureVerificationScreenshot } from './workspace-flows.mjs'

const pluginKey = 'desktop-e2e-upgrade'
const oldVersion = '0.1.1'
const newVersion = '0.3.1'
const sharedSkill = 'upgrade-check'
const retiredSkill = 'retired-check'
const addedSkill = 'added-check'
const oldContent = 'Old release upgrade marker'
const newContent = 'New release upgrade marker'

export async function verifyPluginUpgrade({ cloudEnvironment: env, control, codexHome, setPhase }) {
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
    const item = market.items.find(item => item.name === pluginKey)
    evidence.push({
      label,
      time: new Date().toISOString(),
      item,
      installed: installed.items.filter(item => item.spec.source.pluginKey === pluginKey),
      snapshot,
    })
    await writeFile(
      join(resultDir, 'plugin-upgrade-evidence.json'),
      JSON.stringify(evidence, null, 2)
    )
    await captureVerificationScreenshot(control, `plugin-upgrade-${label}.png`)
    console.log(
      `[plugin-upgrade] ${label}: ${JSON.stringify({ version: item?.version, update: item?.updateAvailable, device: item?.currentDeviceInstallation })}`
    )
    return { item, snapshot }
  }
  const cacheRoot = join(codexHome, 'plugins/cache/wegent', pluginKey)
  const oldRoot = join(cacheRoot, oldVersion)
  const newRoot = join(cacheRoot, newVersion)
  setPhase('plugin-upgrade-old-install')
  const old = await env.publishPluginRelease({
    slug: pluginKey,
    version: oldVersion,
    skills: { [sharedSkill]: oldContent, [retiredSkill]: 'Retired skill marker' },
  })
  await request(`/plugins/marketplace/${old.pluginId}/install?device_id=${deviceId}`, 'POST')
  const installs = await request(`/plugins/installed?device_id=${deviceId}`)
  const installed = installs.items.find(item => item.spec.pluginId === old.pluginId)
  assert.ok(installed, 'Old fixture install is missing')
  const installedId = installed.metadata.labels.id
  await request(`/plugins/installed/${installedId}?device_id=${deviceId}`, 'PUT', {
    updatePolicy: 'manual',
  })
  assert.equal(
    JSON.parse(await readFile(join(oldRoot, '.codex-plugin/plugin.json'), 'utf8')).version,
    oldVersion
  )
  assert.ok(
    (await readFile(join(oldRoot, 'skills', sharedSkill, 'SKILL.md'), 'utf8')).includes(oldContent)
  )
  await access(join(oldRoot, 'skills', retiredSkill, 'SKILL.md'))
  await control.command('click', '[data-testid="plugins-button"]')
  await control.command('waitFor', `[data-testid="plugin-marketplace-row-${old.pluginId}"]`, {
    timeoutMs: 30000,
  })
  await control.command('click', `[data-testid="plugin-marketplace-row-${old.pluginId}"]`)
  await capture('01-old-installed')
  setPhase('plugin-refresh-restores-missing-package')
  const capabilityManifestPath = join(dirname(codexHome), 'capabilities/manifest.json')
  const readCapabilities = async () => JSON.parse(await readFile(capabilityManifestPath, 'utf8'))
  const managedKey = `${pluginKey}@wegent`
  const beforeRepair = await readCapabilities()
  const managed = beforeRepair.plugins[managedKey]
  assert.ok(managed?.store_path, 'Managed package must have an authoritative store path')
  const personalRoot = join(codexHome, 'plugins/cache/wework-personal/reconcile-keep/1.0.0')
  await mkdir(personalRoot, { recursive: true })
  await writeFile(join(personalRoot, 'marker'), 'Keep personal plugin')
  await rm(managed.store_path, { recursive: true })
  await rm(oldRoot, { recursive: true })
  await control.command('click', '[data-testid="plugin-detail-back-button"]')
  let reconciliationRevision = 0
  const refreshAndVerify = async () => {
    await control.command('click', '[data-testid="plugins-refresh-button"]')
    reconciliationRevision += 1
    await control.command(
      'waitFor',
      `[data-testid="plugins-refresh-button"][data-reconciliation-revision="${reconciliationRevision}"]`,
      { timeoutMs: 60000 }
    )
    assert.equal(await readFile(join(personalRoot, 'marker'), 'utf8'), 'Keep personal plugin')
  }
  await refreshAndVerify()
  assert.equal(
    JSON.parse(await readFile(join(oldRoot, '.codex-plugin/plugin.json'), 'utf8')).version,
    oldVersion
  )
  const repaired = await readCapabilities()
  assert.deepEqual(repaired.skills, beforeRepair.skills)
  assert.deepEqual(repaired.mcps, beforeRepair.mcps)
  await refreshAndVerify()
  assert.equal(
    Object.keys((await readCapabilities()).plugins).filter(key => key === managedKey).length,
    1
  )
  await capture('01b-refresh-repaired-and-idempotent')
  await control.command('click', `[data-testid="plugin-marketplace-row-${old.pluginId}"]`)
  setPhase('plugin-upgrade-publish-current')
  await env.publishPluginRelease({
    slug: pluginKey,
    version: newVersion,
    skills: { [sharedSkill]: newContent, [addedSkill]: 'Added skill marker' },
  })
  // The product revalidates the marketplace every sixty seconds.
  console.log('[plugin-upgrade] Waiting for the normal sixty-second catalog refresh')
  await control.command('waitFor', '[data-testid^="plugin-detail-toggle-"]', {
    text: '更新',
    timeoutMs: 75000,
  })
  await capture('02-update-offered')
  setPhase('plugin-upgrade-click-update')
  await control.command('click', '[data-testid^="plugin-detail-toggle-"]')
  await control.command('waitFor', '[data-testid="plugin-update-confirm-button"]')
  await captureVerificationScreenshot(control, 'plugin-upgrade-update-confirmation.png')
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
  console.log('[plugin-upgrade] Observing update and its next catalog refresh')
  await new Promise(resolve => setTimeout(resolve, 65000))
  const refreshed = await capture('04-after-refresh')
  const currentManifestPath = join(newRoot, '.codex-plugin/plugin.json')
  const currentManifest = JSON.parse(await readFile(currentManifestPath, 'utf8'))
  assert.equal(currentManifest.version, newVersion)
  const updatedSkill = await readFile(join(newRoot, 'skills', sharedSkill, 'SKILL.md'), 'utf8')
  assert.ok(updatedSkill.includes(newContent))
  assert.ok(!updatedSkill.includes(oldContent))
  await access(join(newRoot, 'skills', addedSkill, 'SKILL.md'))
  await assert.rejects(access(join(newRoot, 'skills', retiredSkill)), { code: 'ENOENT' })
  await assert.rejects(access(oldRoot), { code: 'ENOENT' })
  await writeFile(
    join(resultDir, 'plugin-upgrade-actual-manifest-after-update.json'),
    JSON.stringify(currentManifest, null, 2)
  )
  const beforeUninstall = await readCapabilities()
  const removedEntry = beforeUninstall.plugins[managedKey]
  const residueBackup = join(resultDir, 'plugin-reconciliation-residue')
  await cp(removedEntry.store_path, residueBackup, { recursive: true })
  setPhase('plugin-upgrade-uninstall')
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
  await assert.rejects(access(newRoot), { code: 'ENOENT' })
  setPhase('plugin-refresh-cleans-cloud-uninstall-residue')
  // Reproduce a missed device cleanup after a successful cloud uninstall.
  await cp(residueBackup, removedEntry.store_path, { recursive: true })
  await cp(residueBackup, newRoot, { recursive: true })
  const stale = await readCapabilities()
  stale.plugins[managedKey] = removedEntry
  await writeFile(capabilityManifestPath, JSON.stringify(stale))
  await control.command('click', '[data-testid="plugin-detail-back-button"]')
  await refreshAndVerify()
  assert.equal((await readCapabilities()).plugins[managedKey], undefined)
  await assert.rejects(access(removedEntry.store_path), { code: 'ENOENT' })
  await assert.rejects(access(newRoot), { code: 'ENOENT' })
  await capture('05b-refresh-cleared-uninstalled-residue')
  await control.command('click', `[data-testid="plugin-marketplace-row-${old.pluginId}"]`)
  setPhase('plugin-upgrade-reinstall')
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
  assert.equal(JSON.parse(await readFile(currentManifestPath, 'utf8')).version, newVersion)
  assert.ok(
    (await readFile(join(newRoot, 'skills', sharedSkill, 'SKILL.md'), 'utf8')).includes(newContent)
  )
  assert.equal(
    refreshed.item.updateAvailable,
    false,
    'Successfully updated plugin must not offer another update after refresh'
  )
  // The next checkpoint section verifies release notifications outside this page.
  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', '[data-testid="chat-message-input"]')
}
