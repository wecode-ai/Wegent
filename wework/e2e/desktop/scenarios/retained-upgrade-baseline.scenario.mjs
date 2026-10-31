import assert from 'node:assert/strict'
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createDesktopScenario as createUpgradeScenario } from './app-upgrade.scenario.mjs'

/** Extend the shared real-package flow without repeating its upgrade or rollback. */
export async function createDesktopScenario(options) {
  const scenario = await createUpgradeScenario(options)
  const pairFile = process.env.WEWORK_E2E_UPGRADE_PAIR
  const pair = JSON.parse(await readFile(pairFile, 'utf8'))
  // Delivered older sources keep their shipped updater behavior. The new
  // mechanism assertions apply to independently built regression packages.
  if (pair.kind !== 'regression') return scenario
  if (pair.from.installedSource) {
    scenario.prepareApp = async preparation => {
      // Establish the original full installation, then run the independently
      // packaged thin host with the real components retained in its data cache.
      const installedPairFile = join(options.resultDir, 'installed-source-pair.json')
      await writeFile(
        installedPairFile,
        JSON.stringify({ ...pair, from: pair.from.installedSource })
      )
      let installed
      try {
        process.env.WEWORK_E2E_UPGRADE_PAIR = installedPairFile
        installed = await createUpgradeScenario({ ...options, preparationOnly: true })
      } finally {
        process.env.WEWORK_E2E_UPGRADE_PAIR = pairFile
      }
      try {
        await installed.prepareApp(preparation)
      } finally {
        await installed.cleanup()
      }
      const resources =
        process.platform === 'darwin'
          ? resolve(dirname(pair.from.installedSource.executable), '../Resources')
          : join(dirname(pair.from.installedSource.executable), 'resources')
      const manifest = JSON.parse(await readFile(join(resources, 'components.json'), 'utf8'))
      const components = {}
      const cache = join(options.electronUserDataDirectory, 'managed-components')
      for (const [id, component] of Object.entries(manifest.components)) {
        if (id === 'electron') continue
        const source = join(resources, component.path)
        const directory = (await stat(source)).isDirectory()
        const entryPath = directory ? '.' : component.path.split('/').at(-1)
        const target = join(cache, 'blobs', id, component.sha256)
        await mkdir(dirname(target), { recursive: true })
        if (!directory) await mkdir(target, { recursive: true })
        await cp(source, directory ? target : join(target, entryPath), { recursive: true })
        components[id] = {
          version: component.version,
          contentSha256: component.sha256,
          archiveSha256: component.sha256,
          archiveBytes: 1,
          downloadUrl: 'local://packaged-component',
          entryPath,
        }
      }
      await writeFile(
        join(cache, 'state.json'),
        JSON.stringify({
          schemaVersion: 1,
          current: { appVersion: pair.from.version, components },
        })
      )
      const thinResources =
        process.platform === 'darwin'
          ? resolve(dirname(pair.from.executable), '../Resources')
          : join(dirname(pair.from.executable), 'resources')
      await assert.rejects(stat(join(thinResources, 'harness-runtime')), { code: 'ENOENT' })
    }
  }
  const verify = scenario.verify
  scenario.verify = async client => {
    await client.command('waitFor', '[data-testid="new-chat-button"]', {
      timeoutMs: options.workbenchReadyTimeoutMs,
    })
    const data = options.electronUserDataDirectory
    const original = await stat(join(data, 'dsh-core/profiles/wework-core'), { bigint: true })
    const { release: running } = JSON.parse(
      await client.command('getDesktopRuntimeDiagnostics', 'body')
    )
    await verify(client)
    const slots = join(data, 'releases/slots')
    const installed = (await readdir(slots)).filter(id => id.startsWith('installed-'))
    assert.equal(installed.length, 1)
    const baseline = JSON.parse(await readFile(join(slots, installed[0], 'release.json'), 'utf8'))
    assert.equal(baseline.executable, running.hostExecutable, 'The running host was copied')
    assert.equal(baseline.componentDataDirectory, data, 'The running components were replaced')
    const retained = await stat(baseline.profileRoot, { bigint: true })
    assert.equal(retained.dev, original.dev, 'The retained profile moved to another filesystem')
    assert.equal(
      retained.ino,
      original.ino,
      'Rollback must retain the original stopped profile, rather than prepare a copy'
    )
    const stages = await readFile(join(data, 'logs/release-preparation.log'), 'utf8')
    assert.equal(stages.includes(installed[0]), false, 'The installed source was prepared again')
  }
  return scenario
}
