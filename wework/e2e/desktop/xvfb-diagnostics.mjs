import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Capture Xvfb diagnostics in a real file; older launchers cannot reopen Node's stderr socket. */
export async function withXvfbDiagnostics(
  run,
  label,
  report = message => process.stderr.write(message)
) {
  const directory = await mkdtemp(join(tmpdir(), 'wework-xvfb-'))
  try {
    const result = await run(join(directory, 'xvfb.log'))
    if (result.code === 0) return result
    let diagnostics
    try {
      diagnostics = await readFile(join(directory, 'xvfb.log'), 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') {
        report(`[desktop-e2e] ${label} Xvfb diagnostics unavailable: ${error.message}\n`)
      }
      return result
    }
    if (!diagnostics.trim()) return result
    report(`[desktop-e2e] ${label} Xvfb diagnostics:\n${diagnostics}\n`)
    return { ...result, stderrTail: `${diagnostics}\n${result.stderrTail ?? ''}`.slice(-12_000) }
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(error => {
      report(`[desktop-e2e] ${label} Xvfb diagnostic cleanup failed: ${error.message}\n`)
    })
  }
}
