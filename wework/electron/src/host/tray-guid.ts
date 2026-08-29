import { createHash } from 'node:crypto'

const WEWORK_TRAY_NAMESPACE = '69ef5f47-9421-53b7-8c12-5a09a4450863'

function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replaceAll('-', ''), 'hex')
}

function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

export function trayGuidForApplicationId(applicationId: string): string {
  const bytes = createHash('sha1')
    .update(uuidBytes(WEWORK_TRAY_NAMESPACE))
    .update(applicationId)
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return formatUuid(bytes)
}
