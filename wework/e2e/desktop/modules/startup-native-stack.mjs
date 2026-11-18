import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/** Inspect only the failed probe's synthetic child, before its cleanup. */
export async function captureStartupNativeStack(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform !== 'linux' && process.platform !== 'darwin') return
  let command = process.platform === 'linux' ? 'gdb' : '/usr/bin/sample'
  const args =
    process.platform === 'linux'
      ? [
          '--quiet',
          '--nx',
          '--batch',
          '-ex',
          'set pagination off',
          '-ex',
          'set debuginfod enabled off',
          '-ex',
          'set print frame-arguments none',
          '-ex',
          'thread apply all bt',
          '-p',
          String(child.pid),
        ]
      : [String(child.pid), '1', '-file', '/dev/stdout']
  if (process.platform === 'linux' && process.getuid?.() !== 0) {
    args.unshift('-n', command)
    command = 'sudo'
  }
  try {
    const { stdout, stderr } = await promisify(execFile)(command, args, {
      timeout: 5_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    console.error('Isolated startup native stack:', stdout, stderr)
  } catch (error) {
    console.error('Isolated startup native stack unavailable:', {
      code: error.code,
      stdout: error.stdout,
      stderr: error.stderr,
    })
  }
}
