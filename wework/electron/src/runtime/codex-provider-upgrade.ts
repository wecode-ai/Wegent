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
  options: Pick<ManagedExecutorRuntimeOptions, 'environment' | 'dataDirectory'>,
  signal?: AbortSignal,
  waitForWriters = false
): Promise<void> {
  const { environment } = options
  const command = environment.WEWORK_EXECUTOR_PATH?.trim()
  const home = environment.WEGENT_CODEX_HOME?.trim() || join(managedExecutorHome(options), 'codex')
  const { agents } = resolveWorkbenchPaths({ environment, metadata: {}, homeDirectory: homedir() })
  if (!command || !isAbsolute(home))
    throw new Error('Codex session upgrade requires the selected executor and Workbench Homes')
  let result: unknown
  try {
    const execution = execute(
      command,
      [
        '--workbench-codex-providers-migrate',
        JSON.stringify({
          codex_home: home,
          agents_root: agents,
          ...(waitForWriters ? { wait_for_writers: true } : {}),
        }),
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
        // Work is proportional to history bytes; only lifecycle shutdown may
        // interrupt it, never a fixed deadline that prevents eventual progress.
        timeout: 0,
        signal,
        maxBuffer: 16 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      }
    )
    const closed = new Promise<void>(resolve => execution.child.once('close', () => resolve()))
    try {
      const { stdout } = await execution
      result = JSON.parse(stdout)
    } finally {
      // Abort rejects before exit. Do not admit another owner until leases close.
      await closed
    }
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
