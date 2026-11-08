import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, rm } from 'node:fs/promises'
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
  return persistDesktopDeviceId(path, deviceId)
}

async function persistDesktopDeviceId(path: string, deviceId: string): Promise<string> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(`${deviceId}\n`)
      await file.sync()
    } finally {
      await file.close()
    }
    await link(temporary, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = await readDesktopDeviceId(path)
    if (!existing)
      throw new Error('Desktop device identity disappeared during initialization', { cause: error })
    return existing
  } finally {
    await rm(temporary, { force: true })
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
