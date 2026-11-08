import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
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

  // Keep the diagnostic file, but never use profile-local state as identity input.
  await mkdir(options.dataDirectory, { recursive: true, mode: 0o700 })
  await writeFile(join(options.dataDirectory, 'desktop-device-id'), `${deviceId}\n`, {
    mode: 0o600,
  })
  return deviceId
}
