import { execFile } from 'node:child_process'
import { hostname } from 'node:os'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

interface DesktopDeviceNameOptions {
  environment: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  readHostname?: () => string
  readMacComputerName?: () => Promise<string>
}

export async function resolveDesktopDeviceName(options: DesktopDeviceNameOptions): Promise<string> {
  const configured = options.environment.DEVICE_NAME?.trim()
  if (configured) return configured

  if ((options.platform ?? process.platform) === 'darwin') {
    const computerName = await readMacComputerName(options.readMacComputerName)
    if (computerName) return computerName
  }

  const host = (options.readHostname ?? hostname)().trim()
  if (host) return host

  throw new Error('Unable to resolve the desktop device name')
}

async function readMacComputerName(reader?: () => Promise<string>): Promise<string | null> {
  try {
    const value = reader
      ? await reader()
      : (
          await execFileAsync('/usr/sbin/scutil', ['--get', 'ComputerName'], {
            encoding: 'utf8',
          })
        ).stdout
    return value.trim() || null
  } catch {
    return null
  }
}
