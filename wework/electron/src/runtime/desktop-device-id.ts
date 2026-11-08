import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { system } from 'systeminformation'

export async function resolveDesktopDeviceId(options: {
  applicationId: string
  dataDirectory: string
  environment: NodeJS.ProcessEnv
}): Promise<string> {
  const configured = options.environment.WEGENT_APP_IPC_DEVICE_ID?.trim()
  if (configured) return configured

  const applicationId = options.applicationId.trim()
  if (!applicationId) throw new Error('Desktop application identifier is empty')

  const path = join(options.dataDirectory, 'desktop-device-id')
  const persisted = await readDesktopDeviceId(path)
  if (persisted) return persisted

  const hardwareUuid = (await system()).uuid.trim().toLowerCase()
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(hardwareUuid) ||
    /^(0{8}-0{4}-0{4}-0{4}-0{12}|f{8}-f{4}-f{4}-f{4}-f{12})$/.test(hardwareUuid)
  ) {
    throw new Error('Cannot resolve a valid hardware UUID for desktop device identity')
  }

  const digest = createHash('sha256')
    .update(JSON.stringify([applicationId, hardwareUuid]))
    .digest('hex')
  const deviceId = `electron-${digest}`

  await mkdir(options.dataDirectory, { recursive: true, mode: 0o700 })
  try {
    const file = await open(path, 'wx', 0o600)
    try {
      await file.writeFile(`${deviceId}\n`)
    } finally {
      await file.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = await readDesktopDeviceId(path)
    if (!existing)
      throw new Error('Desktop device identity disappeared during initialization', { cause: error })
    return existing
  }
  return deviceId
}

async function readDesktopDeviceId(path: string): Promise<string | null> {
  try {
    const value = (await readFile(path, 'utf8')).trim()
    if (!value) throw new Error(`Desktop device identity is empty: ${path}`)
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
