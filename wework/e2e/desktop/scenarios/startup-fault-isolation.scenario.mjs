import assert from 'node:assert/strict'
import { access, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  seedInstalledRelease,
  verifyStartupFaultIsolation,
} from '../modules/startup-fault-isolation.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'

export async function createDesktopScenario({
  resultDir,
  electronUserDataDirectory,
  workbenchReadyTimeoutMs,
}) {
  let appBinary
  let environment
  let replacement
  const metadata = JSON.parse(
    await readFile(new URL('../../../electron/package.json', import.meta.url), 'utf8')
  )
  return {
    async prepareApp(input) {
      appBinary = input.appBinary
      environment = input.appEnvironment
      if (process.platform === 'win32') {
        assert.equal(environment.WEWORK_RELEASE_SUPERVISED || '', '')
        replacement = await seedInstalledRelease({
          data: electronUserDataDirectory,
          appBinary,
          version: '0.0.0',
          id: 'installed-before-manual-replacement',
        })
      }
    },
    async verify(control) {
      await control.command('waitFor', '[data-testid="app-shell"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      if (replacement) {
        const current = await waitForValue(
          async () => {
            const id = (await readFile(join(replacement.releases, 'active'), 'utf8')).trim()
            return JSON.parse(
              await readFile(join(replacement.releases, 'slots', id, 'release.json'), 'utf8')
            )
          },
          release => release.version === metadata.version,
          'The manually replaced host did not reconcile its actual installed release',
          workbenchReadyTimeoutMs
        )
        assert.equal(current.executable, appBinary)
        assert.equal(current.retainedRelease, replacement.descriptor.id)
        assert.equal(
          current.profileRoot,
          await realpath(join(electronUserDataDirectory, 'dsh-core', 'profiles', 'wework-core'))
        )
        assert.equal(await readFile(replacement.descriptorPath, 'utf8'), replacement.original)
        const prepared = JSON.parse(
          await readFile(join(replacement.releases, 'slots', current.id, 'prepared.json'), 'utf8')
        )
        assert.ok(prepared.components.executor)
        assert.ok(prepared.components.codex)
        for (const [id, path] of Object.entries(prepared.components)) {
          if (id !== 'contentSha256') await access(path)
        }
        await writeFile(
          join(resultDir, 'manual-install-reconciliation.json'),
          JSON.stringify({ current, prepared })
        )
      }
      await verifyStartupFaultIsolation({
        appBinary,
        environment,
        resultDir,
        version: metadata.version,
      })
      const durableState = join(electronUserDataDirectory, 'renderer-local-storage.json')
      const original = await readFile(durableState)
      const damaged = '{damaged-durable-state'
      try {
        await writeFile(durableState, damaged)
        const before = control.readyCount
        await control.command('reloadApp', 'body')
        await control.awaitReadyAfter(before, workbenchReadyTimeoutMs)
        await control.command('waitFor', '[data-testid="app-shell"]', {
          timeoutMs: workbenchReadyTimeoutMs,
        })
        assert.equal(
          await readFile(durableState, 'utf8'),
          damaged,
          'Opening the UI replaced damaged user data'
        )
        await writeFile(
          join(resultDir, 'startup-read-only-result.json'),
          JSON.stringify({ workbenchAvailable: true, originalDataPreserved: true })
        )
      } finally {
        await writeFile(durableState, original)
      }
    },
  }
}
