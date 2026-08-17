const INTERNAL_DEVICE_IMAGE = 'registry.api.weibo.com/ci/wegent-device:1.8.6'

export const remoteDeviceE2EExtension = {
  backendEnv: {
    REMOTE_DEVICE_DOCKER_IMAGE: INTERNAL_DEVICE_IMAGE,
  },
  commandMarker: '--network host',
  supportsStatusRecovery: true,
  assertCommand({ assert, command, backendUrl, socketUrl }) {
    assert.ok(command.includes(INTERNAL_DEVICE_IMAGE))
    assert.ok(command.includes(`WEGENT_BACKEND_URL=${backendUrl}`))
    assert.ok(command.includes(`WEGENT_SOCKET_URL=${socketUrl}`))
    assert.ok(command.includes('--network host'))
    assert.ok(command.includes('--pull always'))
    assert.ok(command.includes('-v wegent-remote-device-home:/home/wegent/.wecode/wegent-executor'))
    assert.equal(
      command.includes('DEVICE_PUBLIC_BASE_URL='),
      false,
      'The internal remote Docker command still requires a manually configured IDE URL'
    )
    assert.equal(
      /(?:^|\s)-p\s+17888:17888(?:\s|$)/m.test(command),
      false,
      'The host-network remote Docker command still published port 17888'
    )
  },
}
