import assert from 'node:assert/strict'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { packagedResourcesRoot } from './runtime-assets.mjs'

const LEGACY_VERSION = '0.1.0-rc.8'

export async function prepareLegacyHarnessRuntimeVerification({
  appBinary,
  appEnvironment,
  requestJson,
  resultDir,
}) {
  const runtimeRoot = appEnvironment.WEWORK_HARNESS_RUNTIME_ROOT
  assert.equal(
    resolve(runtimeRoot),
    resolve(join(resultDir, 'harness-runtime')),
    'Legacy runtime verification must use the session-isolated client cache'
  )
  const catalog = JSON.parse(
    await readFile(
      join(packagedResourcesRoot(appBinary), 'harness-runtime', 'runtimes.json'),
      'utf8'
    )
  )
  const legacy = catalog.runtimes.find(
    runtime => runtime.role === 'workbench' && runtime.dshVersion === LEGACY_VERSION
  )
  assert.ok(legacy, 'The runtime catalog must describe the legacy Smart app runtime')
  assert.equal(legacy.bundled, false, 'Legacy Smart app runtime must be downloaded on demand')
  const legacyRoot = join(runtimeRoot, legacy.sourceFingerprint)
  const initial = await stat(legacyRoot).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  assert.equal(initial, null, 'Legacy runtime must not be preloaded into the isolated client cache')
  const downloadPath = `/dsh-runtime-assets/${legacy.assetName}`
  const snapshots = []
  const downloads = control =>
    control.httpRequests.filter(
      request => request.method === 'GET' && request.pathname === downloadPath
    ).length

  return {
    assertNoStartupDownload(control) {
      assert.equal(
        downloads(control),
        0,
        'Wework startup must not download the legacy Smart app runtime'
      )
    },
    async assertRunning(control, installationId) {
      const origin = await control.command('getLocationOrigin', 'body')
      const payload = await requestJson(origin, null, '/wework/electron-host/v1/invoke', {
        method: 'POST',
        body: JSON.stringify({ capability: 'smartApps.list', params: {} }),
      })
      assert.equal(payload.ok, true, 'Reading actual Smart app runtime installations must succeed')
      const installation = payload.result.find(item => item.id === installationId)
      assert.ok(installation, `Running legacy Smart app ${installationId} must be registered`)
      assert.equal(installation.state, 'running')
      assert.equal(installation.manifest.requirements.dsh, LEGACY_VERSION)
      assert.equal(installation.runtimeVersion, LEGACY_VERSION)
      const identity = JSON.parse(await readFile(join(legacyRoot, 'runtime.json'), 'utf8'))
      const dsh = JSON.parse(
        await readFile(
          join(legacyRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
          'utf8'
        )
      )
      assert.equal(identity.sourceFingerprint, legacy.sourceFingerprint)
      assert.equal(identity.dshVersion, LEGACY_VERSION)
      assert.equal(dsh.version, LEGACY_VERSION)
      assert.equal(
        downloads(control),
        1,
        'Legacy Smart apps must reuse their runtime after one download'
      )
      snapshots.push({
        installationId,
        requiredVersion: installation.manifest.requirements.dsh,
        runtimeVersion: installation.runtimeVersion,
        dshPackageVersion: dsh.version,
        sourceFingerprint: identity.sourceFingerprint,
        assetName: legacy.assetName,
        downloadCount: downloads(control),
      })
      await writeFile(
        join(resultDir, 'harness-apps-runtime-compatibility.json'),
        `${JSON.stringify(snapshots, null, 2)}\n`
      )
    },
  }
}
