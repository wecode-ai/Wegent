import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createDesktopScenario } from '../e2e/desktop/scenarios/component-update.scenario.mjs'
import { validateUpgradeCatalog } from '../electron/src/runtime/upgrade-policy.mjs'
import { extractRuntimeArchive } from './lib/extract-runtime-archive.mjs'

for (const packageChannel of ['stable', 'beta']) {
  test(`${packageChannel} package fixture serves both user-selected update channels`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'wework-component-channel-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const binary =
      process.platform === 'darwin' ? join(root, 'MacOS', 'WeWork') : join(root, 'WeWork.exe')
    // macOS resolves Resources relative to the executable's Contents directory.
    const resourceRoot = join(root, process.platform === 'darwin' ? 'Resources' : 'resources')
    await mkdir(join(resourceRoot, 'plugins'), { recursive: true })
    await writeFile(join(resourceRoot, 'plugins', 'plugin.json'), '{}')
    await writeFile(
      join(resourceRoot, 'components.json'),
      JSON.stringify({
        channel: packageChannel,
        appVersion: packageChannel === 'beta' ? '1.0.0-beta.1' : '1.0.0',
        components: {
          weworkCorePlugins: { path: 'plugins', version: '1', sha256: 'a'.repeat(64) },
        },
      })
    )
    // Exercise GNU tar's remote-host parsing on POSIX as well as Windows drives.
    const resultDir = join(root, process.platform === 'win32' ? 'results' : 'local:results')
    await mkdir(resultDir)
    const originalBinary = process.env.WEWORK_E2E_APP_BIN
    const originalRequireRelease = process.env.WEWORK_E2E_REQUIRE_RELEASE_PACKAGE
    process.env.WEWORK_E2E_APP_BIN = binary
    delete process.env.WEWORK_E2E_REQUIRE_RELEASE_PACKAGE
    let scenario
    try {
      scenario = await createDesktopScenario({
        electronUserDataDirectory: join(root, 'user-data'),
        resultDir,
        workbenchReadyTimeoutMs: 1000,
      })
    } finally {
      for (const [key, value] of [
        ['WEWORK_E2E_APP_BIN', originalBinary],
        ['WEWORK_E2E_REQUIRE_RELEASE_PACKAGE', originalRequireRelease],
      ]) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    t.after(() => scenario.cleanup())
    const platform =
      process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
    const origin = scenario.appEnvironment.WEWORK_UPDATE_BASE_URL
    for (const channel of ['stable', 'beta']) {
      const response = await fetch(
        `${origin}/components-${channel}-${platform}-${process.arch}.json`
      )
      assert.equal(response.status, 200)
      const manifest = await response.json()
      assert.equal(manifest.channel, channel)
      const catalog = validateUpgradeCatalog(manifest.upgradePolicy)
      assert.equal(catalog.channel, channel)
      assert.equal(catalog.platform, platform)
      assert.equal(catalog.arch, process.arch)
      assert.deepEqual(catalog.releases, [])
      assert.deepEqual(catalog.edges, [])
      const archive = await fetch(manifest.components.weworkCorePlugins.downloadUrl)
      assert.equal(archive.status, 200)
      const archiveBytes = Buffer.from(await archive.arrayBuffer())
      assert.equal(archiveBytes.byteLength, manifest.components.weworkCorePlugins.archiveBytes)
      const archivePath = join(resultDir, `downloaded-${channel}.tar.gz`)
      const extracted = join(resultDir, `extracted-${channel}`)
      await writeFile(archivePath, archiveBytes)
      await mkdir(extracted)
      await extractRuntimeArchive(archivePath, extracted)
      assert.equal(await readFile(join(extracted, 'plugin.json'), 'utf8'), '{}')
      assert.equal(
        await readFile(join(extracted, 'e2e-component-update', 'nested', 'marker.txt'), 'utf8'),
        'component update activated\n'
      )
    }
    assert.equal(
      (await fetch(`${origin}/components-stable-unknown-${process.arch}.json`)).status,
      404
    )
  })
}
