import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'

export function desktopApplicationDataDirectory() {
  if (process.platform === 'darwin') return join(homedir(), 'Library/Application Support')
  if (process.platform === 'win32') {
    if (!process.env.APPDATA || !isAbsolute(process.env.APPDATA))
      throw new Error('Default-layout verification requires the system APPDATA directory')
    return process.env.APPDATA
  }
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
}

export async function resolveUpgradeUserHome(
  resultDirectory,
  applicationData = desktopApplicationDataDirectory(),
  readStat = stat
) {
  const [result, native] = await Promise.all([readStat(resultDirectory), readStat(applicationData)])
  const external = result.dev !== native.dev
  return {
    applicationData,
    external,
    homePath: external
      ? join(applicationData, 'wework-upgrade-test-homes', basename(resultDirectory))
      : join(resultDirectory, 'home'),
  }
}
