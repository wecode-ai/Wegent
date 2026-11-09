import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import {
  managedExecutorHome,
  type ManagedExecutorRuntimeOptions,
} from './managed-executor-runtime.js'
import { resolveWorkbenchPaths } from './workbench-environment.js'

const execute = promisify(execFile)

/** Target-owned upgrade/recovery step. Run before any executor or Goal recovery starts. */
export async function migrateCodexProviderState(
  options: Pick<ManagedExecutorRuntimeOptions, 'environment' | 'dataDirectory'>
): Promise<void> {
  const { environment } = options
  const command = environment.WEWORK_EXECUTOR_PATH?.trim()
  const home = environment.WEGENT_CODEX_HOME?.trim() || join(managedExecutorHome(options), 'codex')
  const { agents } = resolveWorkbenchPaths({ environment, metadata: {}, homeDirectory: homedir() })
  if (!command || !isAbsolute(home))
    throw new Error('Codex session upgrade requires the selected executor and Workbench Homes')
  let result: unknown
  try {
    const { stdout } = await execute(
      command,
      [
        '--workbench-codex-providers-migrate',
        JSON.stringify({ codex_home: home, agents_root: agents }),
        '--executor-stopped',
        // An older binary must exit without initializing or opening any Home.
        '--version',
      ],
      {
        env: {
          PATH: environment.PATH,
          SystemRoot: environment.SystemRoot,
          WINDIR: environment.WINDIR,
        },
        timeout: 120_000,
        killSignal: 'SIGKILL',
        maxBuffer: 16 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      }
    )
    result = JSON.parse(stdout)
  } catch {
    // Child output can contain private session details; never forward it to the UI.
    throw new Error(
      'Codex session upgrade is incomplete; its journal will resume on the next start'
    )
  }
  if (
    !result ||
    typeof result !== 'object' ||
    (result as Record<string, unknown>).codex_provider_migration !== 1 ||
    (result as Record<string, unknown>).complete !== true
  )
    throw new Error('The selected executor did not complete the Codex session upgrade')
}
