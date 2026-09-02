import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  PluginDevelopmentManager,
  pluginDevelopmentElectronArguments,
  pluginDevelopmentEnvironment,
  pluginDevelopmentId,
  seedPluginDevelopmentPreferences,
  type PluginDevelopmentSession,
} from './plugin-development-manager.js'

describe('PluginDevelopmentManager', () => {
  test('inherits Electron runtime switches required by an isolated parent process', () => {
    const enabled = new Set(['no-sandbox', 'disable-gpu', 'unrelated-switch'])

    expect(pluginDevelopmentElectronArguments(name => enabled.has(name))).toEqual([
      '--no-sandbox',
      '--disable-gpu',
    ])
  })

  test('creates a stable identifier for each source root', () => {
    const firstRoot = join('/tmp', 'plugin-one')
    const secondRoot = join('/tmp', 'plugin-two')

    expect(pluginDevelopmentId(firstRoot)).toBe(pluginDevelopmentId(firstRoot))
    expect(pluginDevelopmentId(firstRoot)).not.toBe(pluginDevelopmentId(secondRoot))
  })

  test('isolates the child runtime from the parent Wework instance', () => {
    const userDataDirectory = join('/tmp', 'wework-plugin-development')
    const environment = pluginDevelopmentEnvironment(
      {
        CODEX_HOME: '/parent/codex',
        ELECTRON_RUN_AS_NODE: '1',
        WEGENT_CODEX_HOME: '/parent/wegent-codex',
        WEGENT_EXECUTOR_LOG_DIR: '/parent/executor-logs',
        WEWORK_E2E_CONTROL_URL: 'http://127.0.0.1:1234',
        VITE_WEWORK_E2E_MODE: '1',
        WEWORK_NODE_PATH: '/parent/runtime/bin/node',
        WEWORK_NODE_RUNTIME_KIND: 'electron',
        WEWORK_RUNTIME_BIN: '/parent/runtime/bin',
      },
      {
        name: 'dsh-development',
        displayName: 'Development plugin',
        description: 'Development plugin',
        version: '0.1.0',
        sourceRoot: '/plugins/dsh-development',
      },
      'development-id',
      userDataDirectory,
      join(userDataDirectory, '..', 'state.json')
    )

    expect(environment).not.toHaveProperty('CODEX_HOME')
    expect(environment).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(environment).not.toHaveProperty('WEGENT_CODEX_HOME')
    expect(environment).not.toHaveProperty('WEWORK_E2E_CONTROL_URL')
    expect(environment).not.toHaveProperty('VITE_WEWORK_E2E_MODE')
    expect(environment).not.toHaveProperty('WEWORK_NODE_PATH')
    expect(environment).not.toHaveProperty('WEWORK_NODE_RUNTIME_KIND')
    expect(environment).not.toHaveProperty('WEWORK_RUNTIME_BIN')
    expect(environment).toMatchObject({
      WEWORK_INSTANCE_MODE: 'core-dsh-plugin-development',
      WEWORK_PLUGIN_DEVELOPMENT_ROOT: '/plugins/dsh-development',
      WEWORK_APP_IDENTIFIER: 'io.wecode.wework.plugin-dev.pdevelopment-id',
      WEWORK_DEV_DOCK_TITLE: 'Wework Plugin Development · deve',
      WEWORK_DEV_INSTANCE_LABEL: 'development-id',
      WEWORK_DEV_TITLE: 'Wework Plugin Development — Development plugin',
      WEWORK_DEV_WORKTREE: '/plugins/dsh-development',
      WEWORK_USER_DATA_DIR: userDataDirectory,
      WEGENT_EXECUTOR_HOME: join(userDataDirectory, 'executor-home'),
      WEGENT_EXECUTOR_LOG_DIR: join(userDataDirectory, 'executor-logs'),
    })
  })

  test('forwards desktop control only for an explicit plugin development E2E run', () => {
    const userDataDirectory = join('/tmp', 'wework-plugin-development')
    const environment = pluginDevelopmentEnvironment(
      {
        WEWORK_E2E_CONTROL_TOKEN: 'control-token',
        WEWORK_E2E_CONTROL_URL: 'http://127.0.0.1:1234',
        WEWORK_PLUGIN_DEVELOPMENT_E2E: '1',
      },
      {
        name: 'dsh-development',
        displayName: 'Development plugin',
        description: 'Development plugin',
        version: '0.1.0',
        sourceRoot: '/plugins/dsh-development',
      },
      'development-id',
      userDataDirectory,
      join(userDataDirectory, '..', 'state.json')
    )

    expect(environment).toMatchObject({
      WEWORK_E2E_CONTROL_TOKEN: 'control-token',
      WEWORK_E2E_CONTROL_URL: 'http://127.0.0.1:1234',
      WEWORK_PLUGIN_DEVELOPMENT_E2E: '1',
      WEWORK_PLUGIN_DEVELOPMENT_E2E_WINDOW_LABEL: 'plugin-development-development-id',
    })
  })

  test('inherits only safe global preferences into the isolated development instance', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wework-plugin-development-preferences-'))
    const child = join(parent, 'plugin-development', 'development-id', 'user-data')

    try {
      await writeFile(
        join(parent, 'app-preferences.json'),
        JSON.stringify({
          appearanceMode: 'dark',
          language: 'en',
          telemetryConsentAsked: true,
          telemetryEnabled: false,
          cloudConnection: { accessToken: 'must-not-be-copied' },
          quickPhrases: [{ id: 'private', content: 'must-not-be-copied' }],
        })
      )

      await seedPluginDevelopmentPreferences(parent, child)

      await expect(
        readFile(join(child, 'app-preferences.json'), 'utf8').then(JSON.parse)
      ).resolves.toEqual({
        appearanceMode: 'dark',
        language: 'en',
        telemetryConsentAsked: true,
        telemetryEnabled: false,
      })
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  test('initializes and caches a Wework plugin project classification', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wework-plugin-project-'))
    const root = join(parent, 'example-plugin')
    const manager = new PluginDevelopmentManager({
      command: process.execPath,
      args: [],
      environment: {},
      userDataDirectory: parent,
    })

    try {
      const plugin = await manager.initialize(root)
      expect(plugin).toMatchObject({
        kind: 'wework-core-dsh-plugin',
        name: '@wework/example-plugin',
        sourceRoot: root,
      })
      expect(
        JSON.parse(await readFile(join(root, '.wework/plugin-development.json'), 'utf8'))
      ).toEqual({
        schemaVersion: 1,
        kind: 'wework-core-dsh-plugin',
      })
      expect(await readFile(join(root, 'index.js'), 'utf8')).toContain('export function apply() {}')

      const first = manager.classify(root)
      const second = manager.classify(root)
      expect(second).toBe(first)
      await expect(first).resolves.toMatchObject({
        kind: 'wework-core-dsh-plugin',
        sourceRoot: root,
      })
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  test('does not restore stale child state after the development instance stops', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wework-plugin-development-state-'))
    const instanceRoot = join(parent, 'plugin-development', 'development-id')
    const userDataDirectory = join(instanceRoot, 'user-data')
    const manager = new PluginDevelopmentManager({
      command: process.execPath,
      args: [],
      environment: {},
      userDataDirectory: parent,
    })
    const session: PluginDevelopmentSession = {
      id: 'development-id',
      name: '@wework/example-plugin',
      displayName: 'Example plugin',
      description: 'Example plugin',
      version: '0.1.0',
      sourceRoot: join(parent, 'example-plugin'),
      status: 'stopped',
      electronPid: null,
      coreDshPid: null,
      hmrGeneration: 1,
      lastError: null,
      userDataDirectory,
      logDirectory: join(instanceRoot, 'logs'),
    }
    Object.assign(manager, { session })

    try {
      await mkdir(instanceRoot, { recursive: true })
      await writeFile(
        join(instanceRoot, 'state.json'),
        JSON.stringify({ status: 'starting', hmrGeneration: 0 })
      )

      await expect(manager.list()).resolves.toEqual([session])
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})
