import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const internalExtensionPath = resolve(
  import.meta.dirname,
  '../../wecode/e2e/desktop/remote-device-extension.mjs'
)

const publicRemoteDeviceE2EExtension = {
  backendEnv: {},
  commandMarker: 'DEVICE_SESSION_GATEWAY_PORT="${DEVICE_SESSION_GATEWAY_PORT:-17888}"',
  supportsStatusRecovery: false,
  assertCommand({ assert, command, backendUrl, socketUrl }) {
    assert.ok(command.includes('ghcr.io/wecode-ai/wegent-device:latest'))
    assert.ok(command.includes(`WEGENT_BACKEND_URL=${backendUrl}`))
    assert.ok(command.includes(`WEGENT_SOCKET_URL=${socketUrl}`))
    assert.ok(
      command.includes('DEVICE_SESSION_GATEWAY_PORT="${DEVICE_SESSION_GATEWAY_PORT:-17888}"')
    )
    assert.ok(command.includes('-e DEVICE_SESSION_GATEWAY_PORT="$DEVICE_SESSION_GATEWAY_PORT"'))
    assert.ok(command.includes('-p "$DEVICE_SESSION_GATEWAY_PORT:$DEVICE_SESSION_GATEWAY_PORT"'))
    assert.equal(
      command.includes('DEVICE_PUBLIC_BASE_URL='),
      false,
      'The public remote Docker command still requires a manually configured IDE URL'
    )
  },
}

export const remoteDeviceE2EExtension = existsSync(internalExtensionPath)
  ? (await import(pathToFileURL(internalExtensionPath).href)).remoteDeviceE2EExtension
  : publicRemoteDeviceE2EExtension
