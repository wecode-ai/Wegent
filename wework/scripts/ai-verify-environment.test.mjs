import { describe, expect, test } from 'vitest'
import path from 'node:path'
import { buildAiVerifyEnvironment } from './ai-verify-environment.mjs'

describe('buildAiVerifyEnvironment', () => {
  test('isolates Codex, executor, and Wework app preferences in the session', () => {
    const environment = buildAiVerifyEnvironment(
      { PATH: '/usr/bin' },
      {
        controlUrl: 'http://127.0.0.1:9999',
        token: 'control-token',
        codexHome: '/tmp/session/executor-home/codex',
        nativeCodexHome: '/tmp/session/native-codex',
        verifyCodexHomeInitialization: true,
        deviceId: 'device-1',
        appIdentifier: 'io.wecode.wework.ai-verify.test',
        executorHome: '/tmp/session/executor-home',
        sessionDirectory: '/tmp/session',
      }
    )

    expect(environment.CODEX_HOME).toBe('/tmp/session/executor-home/codex')
    expect(environment.WEGENT_CODEX_HOME).toBe('/tmp/session/executor-home/codex')
    expect(environment.WEWORK_E2E_NATIVE_CODEX_HOME).toBe('/tmp/session/native-codex')
    expect(environment.VITE_WEWORK_E2E_CODEX_HOME_INITIALIZATION).toBe('true')
    expect(environment.WEWORK_APP_IDENTIFIER).toBe('io.wecode.wework.ai-verify.test')
    expect(environment.WEGENT_EXECUTOR_HOME).toBe('/tmp/session/executor-home')
    expect(environment.WEGENT_EXECUTOR_PROJECTS_DIR).toBe(
      path.join('/tmp/session/executor-home', 'workspace', 'projects')
    )
    expect(environment.WEWORK_EXECUTOR_ISOLATION_OVERRIDE).toBe('true')
    expect(environment.WEWORK_APP_CONFIG_DIR).toBe(path.join('/tmp/session', 'app-config'))
    expect(environment.PATH).toBe('/usr/bin')
  })
})
