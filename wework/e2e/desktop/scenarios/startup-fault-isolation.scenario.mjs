import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { verifyStartupFaultIsolation } from '../modules/startup-fault-isolation.mjs'

export async function createDesktopScenario({
  resultDir,
  electronUserDataDirectory,
  workbenchReadyTimeoutMs,
}) {
  let appBinary
  let environment
  return {
    async prepareApp(input) {
      appBinary = input.appBinary
      environment = input.appEnvironment
    },
    async verify(control) {
      await control.command('waitFor', '[data-testid="app-shell"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      const metadata = JSON.parse(
        await readFile(new URL('../../../electron/package.json', import.meta.url), 'utf8')
      )
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
