import type { WebContents } from 'electron'
import { e2eErrorLog, recordE2ERendererError } from './e2e-error-log.js'

export function installE2EWebContentsErrors(contents: WebContents): void {
  if (process.env.VITE_WEWORK_E2E !== 'true') return
  const webContentsId = contents.id
  e2eErrorLog.record('renderer', 'created', 'info', { webContentsId })
  contents.on('render-process-gone', (_event, details) => {
    e2eErrorLog.record(
      'renderer',
      'process-gone',
      details.reason === 'clean-exit' ? 'info' : 'error',
      {
        webContentsId,
        ...details,
      }
    )
  })
  contents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
    e2eErrorLog.record('renderer', 'load-failed', 'error', {
      webContentsId,
      errorCode,
      errorDescription,
      isMainFrame,
    })
  })
  contents.on('console-message', (_event, level, message, lineNumber, sourceId) => {
    const diagnosticPrefix = '[wework-e2e-diagnostic] '
    if (level < 2 && message.startsWith(diagnosticPrefix)) {
      try {
        const diagnostic = JSON.parse(message.slice(diagnosticPrefix.length))
        if (
          typeof diagnostic?.type !== 'string' ||
          !diagnostic.details ||
          typeof diagnostic.details !== 'object'
        )
          throw new Error('Invalid diagnostic payload')
        e2eErrorLog.record('renderer', 'diagnostic', 'info', { webContentsId, diagnostic })
      } catch {
        e2eErrorLog.record('renderer', 'diagnostic-protocol-failed', 'error', { webContentsId })
      }
      return
    }
    if (level !== 2 && level !== 3) return
    recordE2ERendererError(
      message,
      {
        webContentsId,
        lineNumber,
        sourcePath: URL.canParse(sourceId) ? new URL(sourceId).pathname : undefined,
      },
      level
    )
  })
}
