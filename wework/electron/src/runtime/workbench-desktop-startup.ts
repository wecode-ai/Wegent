import type { App } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export function initializeWorkbenchDesktopData(
  app: Pick<App, 'setPath' | 'setAppLogsPath' | 'requestSingleInstanceLock'>,
  userData: string,
  additionalData: Record<string, unknown>,
  logs = join(userData, 'logs')
): boolean {
  mkdirSync(userData, { recursive: true, mode: 0o700 })
  app.setPath('userData', userData)
  app.setPath('sessionData', userData)
  if (!app.requestSingleInstanceLock(additionalData)) return false
  app.setAppLogsPath(logs)
  return true
}
