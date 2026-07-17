import { describe, expect, test } from 'vitest'
import { buildAiVerifyEnvironment } from './ai-verify-environment.mjs'

describe('buildAiVerifyEnvironment', () => {
  test('uses the same isolated Codex home for Wework and its executor', () => {
    const environment = buildAiVerifyEnvironment(
      { PATH: '/usr/bin' },
      {
        controlUrl: 'http://127.0.0.1:9999',
        token: 'control-token',
        codexHome: '/tmp/session/executor-home/codex',
        deviceId: 'device-1',
        socketPath: '/tmp/wework.sock',
        executorHome: '/tmp/session/executor-home',
        sessionDirectory: '/tmp/session',
      }
    )

    expect(environment.CODEX_HOME).toBe('/tmp/session/executor-home/codex')
    expect(environment.WEGENT_CODEX_HOME).toBe('/tmp/session/executor-home/codex')
    expect(environment.PATH).toBe('/usr/bin')
  })
})
