import { describe, expect, test } from 'vitest'
import { workbenchShortcutLaunch } from './workbench-shortcut-launch.js'

describe('owning workbench shortcut launch', () => {
  test('keeps the exact development command, arguments and owning profile', () => {
    const args = ['/source project/electron', '--disable-gpu']
    const launch = workbenchShortcutLaunch({
      command: '/cache/Development.app/Contents/MacOS/Development',
      args,
      userDataDirectory: '/profiles/development',
      development: true,
      environment: {
        WEWORK_USER_DATA_DIR: '/profiles/other',
        WEWORK_APP_IDENTIFIER: 'io.wecode.wework.dev.fixture',
        WEGENT_WORKBENCH_HOME: '/development/workbench',
        WEWORK_DEV_INSTANCE_ID: 'fixture',
        WEWORK_COMPONENT_RESOURCES_ROOT: '/source resources',
        WEWORK_CORE_PLUGINS_SHA256: 'composition-sha',
        WEWORK_EXECUTOR_PATH: '/source executor',
        VITE_WEGENT_BACKEND_URL: 'http://127.0.0.1:9100',
      },
    })
    args.push('unrelated later mutation')
    expect(launch).toEqual({
      command: '/cache/Development.app/Contents/MacOS/Development',
      args: ['/source project/electron', '--disable-gpu'],
      environment: {
        WEWORK_USER_DATA_DIR: '/profiles/development',
        WEWORK_APP_IDENTIFIER: 'io.wecode.wework.dev.fixture',
        WEGENT_WORKBENCH_HOME: '/development/workbench',
        WEWORK_DEV_INSTANCE_ID: 'fixture',
        WEWORK_COMPONENT_RESOURCES_ROOT: '/source resources',
        WEWORK_CORE_PLUGINS_SHA256: 'composition-sha',
        WEWORK_EXECUTOR_PATH: '/source executor',
        VITE_WEGENT_BACKEND_URL: 'http://127.0.0.1:9100',
      },
    })
  })

  test.each([true, false])(
    'does not serialize credentials, child-Node or release state (development=%s)',
    development => {
      const launch = workbenchShortcutLaunch({
        command: '/Applications/Wework.app/Contents/MacOS/Wework',
        args: [],
        userDataDirectory: '/profiles/owner',
        development,
        environment: {
          OPENAI_API_KEY: 'secret',
          WEWORK_ELECTRON_HOST_TOKEN: 'host-secret',
          WEWORK_RELEASE_ROOT: '/old-release',
          WEWORK_RELEASE_SUPERVISED: 'old-release-id',
          WEWORK_ACTIVE_RELEASE_ID: 'old-release-id',
          WEWORK_COMPONENT_DATA_DIRECTORY: '/old-components',
          ELECTRON_RUN_AS_NODE: '1',
          WEWORK_NODE_PATH: '/child-runtime',
          WEWORK_NODE_RUNTIME_KIND: 'electron',
          WEWORK_RUNTIME_BIN: '/child-runtime-bin',
          PATH: '/inherited-task-bin',
        },
      })
      expect(launch.environment).toEqual({ WEWORK_USER_DATA_DIR: '/profiles/owner' })
    }
  )

  test('a packaged shortcut does not pin development resources or a prior release composition', () => {
    const launch = workbenchShortcutLaunch({
      command: '/Applications/Wework.app/Contents/MacOS/Wework',
      args: [],
      userDataDirectory: '/profiles/owner',
      development: false,
      environment: {
        WEWORK_APP_IDENTIFIER: 'io.wecode.wework',
        WEWORK_EXECUTOR_PATH: '/old-release/executor',
        WEWORK_HARNESS_RESOURCE_ROOT: '/old-release/dsh',
        CODEX_BINARY_PATH: '/old-release/codex',
        DWS_BINARY_PATH: '/old-release/dws',
        WEWORK_DEV_INSTANCE_ID: 'other',
      },
    })
    expect(launch.environment).toEqual({
      WEWORK_APP_IDENTIFIER: 'io.wecode.wework',
      WEWORK_USER_DATA_DIR: '/profiles/owner',
    })
  })

  test('rejects relative launch identities', () => {
    expect(() =>
      workbenchShortcutLaunch({
        command: 'wework',
        args: [],
        environment: {},
        userDataDirectory: '/profile',
        development: true,
      })
    ).toThrow('absolute')
    expect(() =>
      workbenchShortcutLaunch({
        command: '/wework',
        args: [],
        environment: {},
        userDataDirectory: 'profile',
        development: true,
      })
    ).toThrow('absolute')
  })
})
