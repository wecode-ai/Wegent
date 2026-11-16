import { app, shell } from 'electron'
import { mkdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

/**
 * Opens the application log directory, creating it when it does not exist.
 *
 * Throws when the platform shell cannot open the directory so each caller can
 * decide how to surface the failure.
 */
export async function openApplicationLogDirectory(): Promise<void> {
  const logDirectory = app.getPath('logs')
  await mkdir(logDirectory, { recursive: true })
  if (process.platform === 'linux') {
    // Electron 43's Linux openPath never settles (electron/electron#53738).
    // The public URL opener reports the native launch result correctly.
    await shell.openExternal(pathToFileURL(logDirectory).href)
    return
  }
  const error = await shell.openPath(logDirectory)
  if (error) throw new Error(error)
}
