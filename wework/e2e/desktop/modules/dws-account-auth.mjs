import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { CLOUD_DEVICE_ID } from './shared.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const fixture = join(repository, 'wework/e2e/desktop/fixtures/dws-account-auth.py')
const run = promisify(execFile)
const slug = 'dingtalk'

async function usePreparedFixture(resultDir, timeoutMs) {
  const preparedRoot = process.env.WEWORK_E2E_DWS_FIXTURE_DIR?.trim()
  if (!preparedRoot) return null
  const ready = join(preparedRoot, 'ready')
  const failed = join(preparedRoot, 'failed')
  const deadline = Date.now() + Math.max(timeoutMs, 10 * 60 * 1000)
  while (Date.now() < deadline) {
    try {
      await readFile(ready)
      break
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    try {
      const status = (await readFile(failed, 'utf8')).trim()
      throw new Error(`DWS fixture preparation failed with status ${status}`)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  try {
    await readFile(ready)
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('Timed out waiting for the prepared DWS E2E fixture')
    }
    throw error
  }
  const archive = join(resultDir, 'dws-native.zip')
  const sourceRoot = join(resultDir, 'dws-source')
  await mkdir(sourceRoot, { recursive: true })
  await Promise.all([
    copyFile(join(preparedRoot, 'dws-native.zip'), archive),
    copyFile(join(preparedRoot, 'store-helper'), join(sourceRoot, 'store-helper')),
  ])
  await chmod(join(sourceRoot, 'store-helper'), 0o755)
  return { archive, sourceRoot }
}

export async function verifyDwsCloudAccount({
  cloud,
  resultDir,
  executorHome,
  api,
  waitForValue,
  managedRoot,
  reconcileMarker,
  timeoutMs,
  invoke,
}) {
  const prepared = await usePreparedFixture(resultDir, timeoutMs)
  const archive = prepared?.archive ?? join(resultDir, 'dws-native.zip')
  if (!prepared) {
    await run('uv', ['run', '--no-project', 'python', fixture, 'build', '--output', archive], {
      cwd: repository,
      timeout: 15 * 60 * 1000,
    })
  }
  const sha256 = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex')
  const release = await cloud.publishPluginRelease({
    slug,
    version: '1.0.0',
    prebuilt: { path: archive, sha256 },
  })
  const local = await cloud.waitForConnectedAppDevice()
  // Account grants use the canonical execution route, not the displayed device ID.
  const sourceDeviceId = local.execution_target_id
  assert.match(sourceDeviceId, /^app-record-[1-9][0-9]*$/)
  for (const device of [sourceDeviceId, CLOUD_DEVICE_ID]) {
    await api(`/plugins/marketplace/${release.pluginId}/install?device_id=${device}`, 'POST')
  }
  const installed = (await api('/plugins/installed')).items.find(
    item => item.spec.source.pluginKey === slug
  )
  const installedId = Number(installed?.metadata?.labels?.id)
  assert.ok(Number.isSafeInteger(installedId) && installedId > 0)
  await waitForValue(
    () => managedRoot(executorHome, installedId),
    Boolean,
    timeoutMs,
    'Local DWS package did not synchronize'
  )
  const cloudRoot = await waitForValue(
    () => managedRoot(dirname(cloud.remoteCodexHome), installedId),
    Boolean,
    timeoutMs,
    'Cloud DWS package did not synchronize'
  )
  // The upstream writer creates two synthetic accounts in an isolated encrypted store.
  // Enrollment must now travel through the real desktop migration, not a DB seed.
  const sourceRoot = prepared?.sourceRoot ?? join(resultDir, 'dws-source')
  const store = action =>
    run('uv', ['run', '--no-project', 'python', fixture, action, '--source-root', sourceRoot], {
      cwd: repository,
      timeout: 5 * 60 * 1000,
    })
  assert.equal(JSON.parse((await store('seed')).stdout).verified, true)
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  const command = `python3 ${quote(join(cloudRoot, 'scripts/cli.py'))} account-status`
  const connection = await waitForValue(
    () => api('/plugin-connections'),
    list =>
      list.some(
        item => item.installed_plugin_id === installedId && item.device_ids.includes(sourceDeviceId)
      ),
    timeoutMs,
    'The native DWS source-store migration did not enroll and grant the source device'
  ).then(list => list.find(item => item.installed_plugin_id === installedId))
  assert.equal(connection.account_id, 'synthetic-corp:synthetic-user')
  assert.ok(connection.device_ids.includes(sourceDeviceId))
  assert.equal(JSON.parse((await store('check')).stdout).verified, true)
  await waitForValue(
    () => api('/plugin-connections'),
    list => list.find(item => item.id === connection.id).device_ids.includes(CLOUD_DEVICE_ID),
    timeoutMs,
    'DWS cloud grant was not saved'
  )
  await invoke(command, 'synthetic-corp:synthetic-user')
  const latest = (await api('/plugin-connections')).find(item => item.id === connection.id)
  await api(`/plugin-connections/${connection.id}/devices/${CLOUD_DEVICE_ID}`, 'DELETE', {
    expected_revision: latest.revision,
  })
  await waitForValue(
    () => api('/plugin-connections'),
    list => !list.find(item => item.id === connection.id).device_ids.includes(CLOUD_DEVICE_ID),
    timeoutMs,
    'DWS cloud grant was not revoked'
  )
  await invoke(command, 'plugin_auth_device_not_granted')
  const reconciliationCount = () =>
    readFile(reconcileMarker, 'utf8')
      .then(contents => contents.split('\n').filter(Boolean).length)
      .catch(error => {
        if (error.code === 'ENOENT') return 0
        throw error
      })
  const initialReconciliations = await reconciliationCount()
  // Observe two completed native reconciliation cycles after manual revocation.
  const until = Date.now() + timeoutMs
  while ((await reconciliationCount()) < initialReconciliations + 2) {
    const current = (await api('/plugin-connections')).find(item => item.id === connection.id)
    assert.ok(
      !current.device_ids.includes(CLOUD_DEVICE_ID),
      'Automatic sync restored a revoked grant'
    )
    if (Date.now() >= until) {
      throw new Error('Automatic reconciliation did not complete two post-revocation cycles')
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  await invoke(command, 'plugin_auth_device_not_granted')
}
