import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function withXvfbErrorLog(
  label,
  run,
  writeDiagnostics = text => process.stderr.write(text)
) {
  const directory = await mkdtemp(join(tmpdir(), 'wework-e2e-xvfb-'))
  const errorFile = join(directory, 'xvfb.log')
  const report = text => {
    try {
      writeDiagnostics(text)
    } catch {
      // Diagnostic output must not replace the checkpoint result.
    }
  }

  try {
    await writeFile(errorFile, '', { mode: 0o600 })
    return await run(errorFile)
  } finally {
    try {
      const diagnostics = await readFile(errorFile, 'utf8')
      if (diagnostics) {
        report(`\n[desktop-e2e] ${label} Xvfb diagnostics:\n${diagnostics}\n`)
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        report(`[desktop-e2e] ${label} could not read Xvfb diagnostics: ${error.message}\n`)
      }
    }
    try {
      await rm(directory, { recursive: true, force: true })
    } catch (error) {
      report(`[desktop-e2e] ${label} could not remove Xvfb diagnostics: ${error.message}\n`)
    }
  }
}
