import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)

export async function assertCodexHomeCanMove(command: string, home: string): Promise<void> {
  let response: unknown
  try {
    // --version makes older binaries exit without initializing any user data.
    const { stdout } = await execute(
      command,
      ['--workbench-codex-migration-check', home, '--version'],
      {
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
        },
        timeout: 5_000,
        killSignal: 'SIGKILL',
        maxBuffer: 16 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      }
    )
    response = JSON.parse(stdout)
  } catch {
    throw new Error('Codex credential storage verification failed; Home was not moved')
  }
  if (!response || typeof response !== 'object') {
    throw new Error('Invalid Codex Home migration verification response')
  }
  const result = response as Record<string, unknown>
  if (result.codex_home_migration !== 1 || result.allowed !== true) {
    throw new Error(
      'Codex Home migration blocked: verify Home-bound credential storage before moving Home'
    )
  }
}
