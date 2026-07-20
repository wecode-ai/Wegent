import { describe, expect, test } from 'vitest'
import { buildAiVerifyEnvironment } from './ai-verify-environment.mjs'

describe('buildAiVerifyEnvironment', () => {
  test('isolates Codex, executor, stdio gateway, and Wework app preferences', () => {
    const environment = buildAiVerifyEnvironment(
      {
        PATH: '/usr/bin',
        WEGENT_EXECUTOR_APP_IPC_ADDR_FILE: '/tmp/foreign.addr',
        WEGENT_EXECUTOR_APP_IPC_SOCKET: '/tmp/legacy.sock',
        WEGENT_EXECUTOR_BINARY: '/tmp/foreign-executor',
        WEGENT_EXECUTOR_SOURCE_DIR: '/tmp/foreign-source',
        WEWORK_EXECUTOR_SIDECAR: '/tmp/foreign-sidecar',
        WEWORK_SHARED_EXECUTOR_HOME: '/tmp/shared-home',
      },
      {
        controlUrl: 'http://127.0.0.1:9999',
        token: 'control-token',
        codexHome: '/tmp/session/executor-home/codex',
        deviceId: 'device-1',
        appIdentifier: 'io.wecode.wework.ai-verify.test',
        executorHome: '/tmp/session/executor-home',
        sessionDirectory: '/tmp/session',
      }
    )

    expect(environment.CODEX_HOME).toBe('/tmp/session/executor-home/codex')
    expect(environment.WEGENT_CODEX_HOME).toBe('/tmp/session/executor-home/codex')
    expect(environment.WEWORK_APP_IDENTIFIER).toBe('io.wecode.wework.ai-verify.test')
    expect(environment.DEVICE_SESSION_GATEWAY_HOST).toBe('127.0.0.1')
    expect(environment.DEVICE_SESSION_GATEWAY_PORT).toBe('0')
    expect(environment.WEGENT_EXECUTOR_HOME).toBe('/tmp/session/executor-home')
    expect(environment.WEGENT_EXECUTOR_PROJECTS_DIR).toBe(
      '/tmp/session/executor-home/workspace/projects'
    )
    expect(environment.WEWORK_EXECUTOR_ISOLATION_OVERRIDE).toBe('true')
    expect(environment.WEGENT_EXECUTOR_APP_IPC_ADDR_FILE).toBeUndefined()
    expect(environment.WEGENT_EXECUTOR_APP_IPC_SOCKET).toBeUndefined()
    expect(environment.WEGENT_EXECUTOR_BINARY).toBeUndefined()
    expect(environment.WEGENT_EXECUTOR_SOURCE_DIR).toBeUndefined()
    expect(environment.WEWORK_EXECUTOR_SIDECAR).toBeUndefined()
    expect(environment.WEWORK_SHARED_EXECUTOR_HOME).toBeUndefined()
    expect(environment.WEWORK_APP_CONFIG_DIR).toBe('/tmp/session/app-config')
    expect(environment.PATH).toBe('/usr/bin')
  })
})
