import { app, shell } from 'electron'
import { mkdir } from 'node:fs/promises'

/**
 * Opens the application log directory, creating it when it does not exist.
 *
 * Throws when the platform shell cannot open the directory so each caller can
 * decide how to surface the failure.
 */
export async function openApplicationLogDirectory(): Promise<void> {
  const logDirectory = app.getPath('logs')
  await mkdir(logDirectory, { recursive: true })
  const error = await shell.openPath(logDirectory)
  if (error) throw new Error(error)
}
