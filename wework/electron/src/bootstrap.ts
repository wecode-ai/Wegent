import { app } from 'electron'
import { readFile } from 'node:fs/promises'
import { showStartupRecovery } from './host/startup-recovery-window.js'
import { isInstalledPreparationRequest } from './runtime/installed-preparation-contract.mjs'

const pendingUrls: string[] = []
const captureUrl = (event: Electron.Event, url: string): void => {
  event.preventDefault()
  pendingUrls.push(url)
}
app.on('open-url', captureUrl)
const forwardedArguments = (): string[] => [...process.argv.slice(1), ...pendingUrls]

try {
  const recovery = process.env.WEWORK_STARTUP_RECOVERY
  delete process.env.WEWORK_STARTUP_RECOVERY
  if (recovery) throw new Error(recovery)
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  if (app.isPackaged && isInstalledPreparationRequest(process.argv)) {
    const { prepareInstallation } = await import(
      './runtime/installed-preparation-bootstrap.js'
    )
    await prepareInstallation(metadata)
  } else {
    const { routeRelease } = await import('./release-bootstrap.js')
    if (await routeRelease(metadata, forwardedArguments, failStartup)) {
      app.removeListener('open-url', captureUrl)
      process.argv.push(...pendingUrls)
      await import('./main.js')
    }
  }
} catch (error) {
  failStartup(error)
}

function failStartup(error: unknown): void {
  console.error('[release-bootstrap]', error instanceof Error ? error.message : 'Startup failed')
  void import('./runtime/release-diagnostics.js')
    .then(({ recordReleaseDiagnostic }) =>
      recordReleaseDiagnostic(
        'bootstrap-failed',
        { message: error instanceof Error ? error.message : 'Startup failed' },
        true
      )
    )
    .catch(diagnosticError => {
      console.warn('[startup-recovery] Cannot record startup diagnostics', {
        errorType: diagnosticError instanceof Error ? diagnosticError.name : typeof diagnosticError,
      })
    })
  // Electron ready is emitted only after this ESM entry finishes evaluating.
  void showStartupRecovery(error).catch(recoveryError => {
    console.error('[startup-recovery] Cannot open recovery window', recoveryError)
  })
}
