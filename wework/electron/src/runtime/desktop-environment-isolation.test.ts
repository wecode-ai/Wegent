import { describe, expect, it } from 'vitest'

import { isolateInheritedDesktopEnvironment } from './desktop-environment-isolation.js'

const home = '/Users/tester'
const production = `${home}/.wegent/workbench/wework/com.weibo.wework`
const testInstallation = `${home}/.wegent/workbench/wework/io.wecode.wework.test`

function isolate(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  isolateInheritedDesktopEnvironment(environment, {
    homeDirectory: home,
    namespace: 'io.wecode.wework.test',
  })
  return environment
}

describe('isolateInheritedDesktopEnvironment', () => {
  it('drops parent execution identity and handshake state', () => {
    const environment = isolate({
      WEGENT_APP_IPC_DEVICE_ID: 'electron-production',
      WEGENT_APP_IPC_ENDPOINT: '/tmp/production.sock',
      WEGENT_APP_IPC_TOKEN: 'token',
      WEGENT_RUNTIME_AUTH_TOKEN: 'runtime',
      WEGENT_TASK_ID: 'runtime-1',
      WEWORK_EMBEDDED_BROWSER_BRIDGE_URL: 'http://127.0.0.1:1',
      WEWORK_EMBEDDED_BROWSER_BRIDGE_TOKEN: 'bridge',
      DEVICE_ID: 'legacy',
    })

    expect(environment).toEqual({})
  })

  it('preserves explicitly configured cloud endpoints', () => {
    const environment = isolate({
      WEWORK_BACKEND_URL: 'https://wegent.example.com/api',
      WEGENT_SOCKET_URL: 'wss://socket.example.com',
      WEGENT_BACKEND_URL: 'https://override.example.com/api',
      WEWORK_SOCKET_URL: 'wss://override-socket.example.com',
      UNRELATED: 'kept',
    })

    expect(environment).toEqual({
      WEWORK_BACKEND_URL: 'https://wegent.example.com/api',
      WEGENT_SOCKET_URL: 'wss://socket.example.com',
      WEGENT_BACKEND_URL: 'https://override.example.com/api',
      WEWORK_SOCKET_URL: 'wss://override-socket.example.com',
      UNRELATED: 'kept',
    })
  })

  it('drops homes and binaries owned by another installation', () => {
    const environment = isolate({
      WEGENT_CODEX_HOME: `${production}/codex`,
      WEGENT_EXECUTOR_HOME: `${production}`,
      CODEX_HOME: `${production}/codex`,
      WEWORK_EXECUTOR_PATH: `${production}/user-data/executor/wegent-executor`,
      WEWORK_USER_DATA_DIR: `${production}/user-data`,
    })

    expect(environment).toEqual({})
  })

  it('keeps this installation and explicit isolated paths', () => {
    const environment = isolate({
      WEGENT_CODEX_HOME: `${testInstallation}/codex`,
      WEGENT_CAPABILITIES_HOME: `${testInstallation}/capabilities`,
      WEWORK_EXECUTOR_PATH: '/tmp/e2e/wegent-executor',
      WEWORK_USER_DATA_DIR: '/tmp/e2e/user-data',
      WEGENT_WORKBENCH_HOME: `${home}/.wegent/workbench`,
      PATH: '/usr/bin:/bin',
    })

    expect(environment).toEqual({
      WEGENT_CODEX_HOME: `${testInstallation}/codex`,
      WEGENT_CAPABILITIES_HOME: `${testInstallation}/capabilities`,
      WEWORK_EXECUTOR_PATH: '/tmp/e2e/wegent-executor',
      WEWORK_USER_DATA_DIR: '/tmp/e2e/user-data',
      WEGENT_WORKBENCH_HOME: `${home}/.wegent/workbench`,
      PATH: '/usr/bin:/bin',
    })
  })
})
