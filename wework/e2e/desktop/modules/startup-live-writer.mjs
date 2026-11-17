import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { startUpgradeWriter } from './upgrade-writer-wait.mjs'

/** Opening the workbench must not require exclusive ownership of native history. */
export function createStartupLiveWriter({ resultDir, timeoutMs }) {
  let writer
  let assertMigrationBlocked
  return {
    async prepareApp({ appEnvironment, codexHome }) {
      const workspace = join(resultDir, 'startup-live-writer')
      await mkdir(workspace, { recursive: true })
      writer = await startUpgradeWriter({
        binary: appEnvironment.CODEX_BINARY_PATH,
        home: codexHome,
        workspace,
        timeoutMs,
      })
      assertMigrationBlocked = () =>
        assert.rejects(
          promisify(execFile)(
            appEnvironment.WEWORK_EXECUTOR_PATH,
            [
              '--workbench-codex-providers-migrate',
              JSON.stringify({ codex_home: codexHome, agents_root: join(workspace, 'agents') }),
              '--executor-stopped',
              '--version',
            ],
            { env: { PATH: appEnvironment.PATH }, timeout: timeoutMs }
          ),
          /blocked by a live writer/
        )
      await assertMigrationBlocked()
    },
    async verify(control) {
      await control.command('waitFor', '[data-testid="app-shell"]', { timeoutMs })
      await assertMigrationBlocked()
      await writer.stop()
      writer = undefined
    },
    async cleanup() {
      await writer?.stop()
    },
  }
}
