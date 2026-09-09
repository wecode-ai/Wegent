import { describe, expect, test } from 'vitest'
import path from 'node:path'
import {
  buildAiVerifyEnvironment,
  isolateAiVerifyRuntimeEnvironment,
} from './ai-verify-environment.mjs'

describe('buildAiVerifyEnvironment', () => {
  test('removes inherited packaged runtime overrides before a source build', () => {
    expect(
      isolateAiVerifyRuntimeEnvironment({
        PATH: '/usr/bin',
        WEGENT_EXECUTOR_BINARY: '/tmp/installed-executor',
        WEWORK_EXECUTOR_PATH: '/Applications/WeWork.app/Contents/Resources/bin/wegent-executor',
      })
    ).toEqual({ PATH: '/usr/bin' })
  })

  test('isolates Codex, executor, stdio gateway, and Wework app preferences', () => {
    const environment = buildAiVerifyEnvironment(
      {
        CODEX_BINARY_PATH: '/Applications/WeWork.app/Contents/Resources/codex',
        DWS_BINARY_PATH: '/Applications/WeWork.app/Contents/Resources/dws',
        PATH: '/usr/bin',
        WEGENT_APP_LIFECYCLE_FD: '3',
        WEGENT_EXECUTOR_APP_IPC_ADDR: '127.0.0.1:7777',
        WEGENT_EXECUTOR_APP_IPC_ADDR_FILE: '/tmp/foreign.addr',
        WEGENT_EXECUTOR_APP_IPC_SOCKET: '/tmp/legacy.sock',
        WEGENT_EXECUTOR_BINARY: '/tmp/foreign-executor',
        WEGENT_EXECUTOR_SOURCE_DIR: '/tmp/foreign-source',
        WEGENT_APP_IPC_ENDPOINT: '/tmp/foreign-app-ipc.sock',
        WEGENT_APP_IPC_TOKEN: 'foreign-app-ipc-token',
        WEGENT_TASK_ID: 'runtime-parent-task',
        WEGENT_TASK_WORKSPACE: '/tmp/parent-workspace',
        ELECTRON_RUN_AS_NODE: '1',
        WEWORK_APP_HOT_RELOAD: '1',
        WEWORK_COMPONENT_RESOURCES_ROOT: '/tmp/foreign-components',
        WEWORK_DEV_DOCK_TITLE: 'Parent task · 1234',
        WEWORK_DEV_INSTANCE_LABEL: '123456',
        WEWORK_DEV_TITLE: 'Parent task',
        WEWORK_DEV_WORKTREE: '/tmp/worktrees/runtime-123456/project',
        WEWORK_EXECUTOR_PATH: '/Applications/WeWork.app/Contents/Resources/bin/wegent-executor',
        WEWORK_EXECUTOR_SIDECAR: '/tmp/foreign-sidecar',
        WEWORK_HARNESS_RUNTIME_ROOT: '/tmp/foreign-harness-runtime',
        WEWORK_NODE_PATH: '/Applications/WeWork.app/Contents/MacOS/WeWork',
        WEWORK_NODE_RUNTIME_KIND: 'electron',
        WEWORK_PARENT_TITLE: 'Parent task',
        WEWORK_RUNTIME_BIN: '/tmp/foreign-runtime/bin',
        WEWORK_SHARED_EXECUTOR_HOME: '/tmp/shared-home',
      },
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
    expect(environment.WEWORK_E2E_CONTROL_TOKEN).toBe('control-token')
    expect(environment.WEWORK_E2E_CONTROL_URL).toBe('http://127.0.0.1:9999')
    expect(environment.WEGENT_APP_LIFECYCLE_FD).toBeUndefined()
    expect(environment.DEVICE_SESSION_GATEWAY_HOST).toBe('127.0.0.1')
    expect(environment.DEVICE_SESSION_GATEWAY_PORT).toBe('0')
    expect(environment.WEGENT_EXECUTOR_HOME).toBe('/tmp/session/executor-home')
    expect(environment.WEGENT_EXECUTOR_PROJECTS_DIR).toBe(
      path.join('/tmp/session/executor-home', 'workspace', 'projects')
    )
    expect(environment.WEWORK_EXECUTOR_ISOLATION_OVERRIDE).toBe('true')
    expect(environment.WEWORK_DISABLE_BACKGROUND_THROTTLING).toBe('1')
    expect(environment.WEGENT_EXECUTOR_APP_IPC_ADDR).toBeUndefined()
    expect(environment.WEGENT_EXECUTOR_APP_IPC_ADDR_FILE).toBeUndefined()
    expect(environment.WEGENT_EXECUTOR_APP_IPC_SOCKET).toBeUndefined()
    expect(environment.WEGENT_EXECUTOR_BINARY).toBeUndefined()
    expect(environment.WEGENT_EXECUTOR_SOURCE_DIR).toBeUndefined()
    expect(environment.WEGENT_APP_IPC_ENDPOINT).toBeUndefined()
    expect(environment.WEGENT_APP_IPC_TOKEN).toBeUndefined()
    expect(environment.WEGENT_TASK_ID).toBeUndefined()
    expect(environment.WEGENT_TASK_WORKSPACE).toBeUndefined()
    expect(environment.CODEX_BINARY_PATH).toBeUndefined()
    expect(environment.DWS_BINARY_PATH).toBeUndefined()
    expect(environment.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(environment.WEWORK_APP_HOT_RELOAD).toBeUndefined()
    expect(environment.WEWORK_COMPONENT_RESOURCES_ROOT).toBeUndefined()
    expect(environment.WEWORK_DEV_DOCK_TITLE).toBeUndefined()
    expect(environment.WEWORK_DEV_INSTANCE_LABEL).toBeUndefined()
    expect(environment.WEWORK_DEV_TITLE).toBeUndefined()
    expect(environment.WEWORK_DEV_WORKTREE).toBeUndefined()
    expect(environment.WEWORK_EXECUTOR_PATH).toBeUndefined()
    expect(environment.WEWORK_EXECUTOR_SIDECAR).toBeUndefined()
    expect(environment.WEWORK_HARNESS_RUNTIME_ROOT).toBeUndefined()
    expect(environment.WEWORK_NODE_PATH).toBeUndefined()
    expect(environment.WEWORK_NODE_RUNTIME_KIND).toBeUndefined()
    expect(environment.WEWORK_PARENT_TITLE).toBeUndefined()
    expect(environment.WEWORK_RUNTIME_BIN).toBeUndefined()
    expect(environment.WEWORK_SHARED_EXECUTOR_HOME).toBeUndefined()
    expect(environment.WEWORK_APP_CONFIG_DIR).toBe(path.join('/tmp/session', 'app-config'))
    expect(environment.PATH).toBe('/usr/bin')
  })
})
