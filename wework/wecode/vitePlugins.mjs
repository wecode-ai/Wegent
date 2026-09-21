import path from 'node:path'
import { fileURLToPath } from 'node:url'

export async function createWecodeVitePlugins() {
  return []
}

export function createWecodeViteEntries() {
  return {
    'wework-ui-device-desktop': path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      'dsh/ui-device-desktop/src/device-desktop-route.tsx'
    ),
  }
}
