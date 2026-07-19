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
        appIdentifier: 'io.wecode.wework.ai-verify.test',
        socketPath: '/tmp/wework.sock',
        executorHome: '/tmp/session/executor-home',
        sessionDirectory: '/tmp/session',
      }
    )

    expect(environment.CODEX_HOME).toBe('/tmp/session/executor-home/codex')
    expect(environment.WEGENT_CODEX_HOME).toBe('/tmp/session/executor-home/codex')
    expect(environment.WEWORK_APP_IDENTIFIER).toBe('io.wecode.wework.ai-verify.test')
    expect(environment.WEGENT_EXECUTOR_HOME).toBe('/tmp/session/executor-home')
    expect(environment.WEGENT_EXECUTOR_PROJECTS_DIR).toBe(
      '/tmp/session/executor-home/workspace/projects'
    )
    expect(environment.WEGENT_EXECUTOR_APP_IPC_SOCKET).toBe('/tmp/wework.sock')
    expect(environment.WEWORK_EXECUTOR_ISOLATION_OVERRIDE).toBe('true')
    expect(environment.PATH).toBe('/usr/bin')
  })
})
