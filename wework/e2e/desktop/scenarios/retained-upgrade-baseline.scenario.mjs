import assert from 'node:assert/strict'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDesktopScenario as createUpgradeScenario } from './app-upgrade.scenario.mjs'
import { assertRetainedSourceOwnership } from '../modules/retained-source-ownership.mjs'

/** Extend the shared real-package flow without repeating its upgrade or rollback. */
export async function createDesktopScenario(options) {
  const scenario = await createUpgradeScenario(options)
  const pairFile = process.env.WEWORK_E2E_UPGRADE_PAIR
  const pair = JSON.parse(await readFile(pairFile, 'utf8'))
  // A retained later installation reproduces the delivered source's pending
  // activation without fabricating component state or changing program bytes.
  if (pair.kind !== 'regression' && !pair.from.installedSource) return scenario
  if (pair.from.installedSource && options.checkpoint === 'app-rollback') {
    const prepareSource = scenario.prepareApp
    scenario.prepareApp = async preparation => {
      if (pair.transport === 'default-update-route') await prepareSource(preparation)
      // Prepare both immutable delivered packages through their own entries.
      // The later installed source supplies the real unstarted-activation slot.
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
    // The delivered updater registers installed-* during ordinary updates too;
    // these ownership assertions also apply to rollback and failure recovery.
    const slots = join(data, 'releases/slots')
    const installed = (await readdir(slots)).filter(id => id.startsWith('installed-'))
    assert.equal(installed.length, 1)
    const baseline = JSON.parse(await readFile(join(slots, installed[0], 'release.json'), 'utf8'))
    const retainsLiveProfile = pair.kind === 'regression' || options.checkpoint === 'app-rollback'
    await assertRetainedSourceOwnership({
      baseline,
      slot: join(slots, installed[0]),
      running,
      original,
      data,
      retainsLiveProfile,
    })
    const stages = await readFile(join(data, 'logs/release-preparation.log'), 'utf8')
    assert.equal(
      stages.includes(installed[0]),
      !retainsLiveProfile,
      retainsLiveProfile
        ? 'The installed source was prepared again'
        : 'The legacy rollback copy was not prepared'
    )
  }
  return scenario
}
