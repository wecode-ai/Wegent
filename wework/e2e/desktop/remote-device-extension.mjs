import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const internalExtensionPath = resolve(
  import.meta.dirname,
  '../../wecode/e2e/desktop/remote-device-extension.mjs'
)

const publicRemoteDeviceE2EExtension = {
  backendEnv: {},
  commandMarker: '-p 17888:17888',
  supportsStatusRecovery: false,
  assertCommand({ assert, command, backendUrl, socketUrl }) {
    assert.ok(command.includes('ghcr.io/wecode-ai/wegent-device:latest'))
    assert.ok(command.includes(`WEGENT_BACKEND_URL=${backendUrl}`))
    assert.ok(command.includes(`WEGENT_SOCKET_URL=${socketUrl}`))
    assert.match(command, /(?:^|\s)-p\s+17888:17888(?:\s|\\|$)/m)
  },
}

export const remoteDeviceE2EExtension = existsSync(internalExtensionPath)
  ? (await import(pathToFileURL(internalExtensionPath).href)).remoteDeviceE2EExtension
  : publicRemoteDeviceE2EExtension
