import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, join, normalize } from 'node:path'

import type { CoreDshPluginManager } from './core-dsh-plugin-manager.js'

export type WorkbenchMode = 'focus' | 'developer'

export const MODE_MANAGED_GIT_PLUGIN = '@wegent/dsh-ui-git'
export const MODE_MANAGED_FOCUS_HOME_PLUGIN = '@wegent/dsh-ui-home-focus'
export const MODE_MANAGED_DEVELOPER_HOME_PLUGIN = '@wegent/dsh-ui-home-developer'

const DEVELOPMENT_COMMANDS = [
  'git',
  'node',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'deno',
  'go',
  'cargo',
  'rustc',
  'docker',
  'kubectl',
  'code',
] as const

interface WorkbenchModePreferences {
  read(): Promise<Record<string, unknown>>
  update(patch: Record<string, unknown>): Promise<Record<string, unknown>>
}

interface InitializeWorkbenchModeOptions {
  environment: NodeJS.ProcessEnv
  homeDirectory: string
  platform?: NodeJS.Platform
  probeCommand?: (
    command: string,
    environment: NodeJS.ProcessEnv,
    signal?: AbortSignal
  ) => Promise<boolean>
}

export function normalizeWorkbenchMode(value: unknown): WorkbenchMode {
  return value === 'focus' ? 'focus' : 'developer'
}

export async function initializeWorkbenchModePreference(
  preferences: WorkbenchModePreferences,
  options: InitializeWorkbenchModeOptions
): Promise<WorkbenchMode> {
  const stored = await preferences.read()
  if (Object.hasOwn(stored, 'workbenchMode')) {
    return normalizeWorkbenchMode(stored.workbenchMode)
  }

  const platform = options.platform ?? process.platform
  const environment = developmentCommandEnvironment(
    options.environment,
    options.homeDirectory,
    platform
  )
  const probeCommand =
    options.probeCommand ??
    ((command, commandEnvironment, signal) =>
      probeDevelopmentCommand(command, commandEnvironment, platform, signal))
  const controller = new AbortController()
  const results = await Promise.all(
    DEVELOPMENT_COMMANDS.map(async command => {
      const found = await probeCommand(command, environment, controller.signal)
      if (found) controller.abort()
      return found
    })
  )
  const mode: WorkbenchMode = results.some(Boolean) ? 'developer' : 'focus'
  try {
    await preferences.update({ workbenchMode: mode })
  } catch (error) {
    console.warn('[workbench-mode] Could not persist the detected mode', error)
  }
  return mode
}

export async function applyWorkbenchModeToCorePlugins(
  mode: WorkbenchMode,
  plugins: Pick<CoreDshPluginManager, 'enabledStates' | 'setEnabled'>
): Promise<void> {
  const desiredStates = new Map([
    [MODE_MANAGED_GIT_PLUGIN, mode === 'developer'],
    [MODE_MANAGED_FOCUS_HOME_PLUGIN, mode === 'focus'],
    [MODE_MANAGED_DEVELOPER_HOME_PLUGIN, mode === 'developer'],
  ])
  const enabledStates = await plugins.enabledStates([...desiredStates.keys()])
  for (const [name, shouldEnable] of desiredStates) {
    const enabled = enabledStates.get(name)
    if (enabled !== undefined && enabled !== shouldEnable) {
      await plugins.setEnabled(name, shouldEnable)
    }
  }
}

function developmentCommandEnvironment(
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
  platform: NodeJS.Platform
): NodeJS.ProcessEnv {
  if (platform === 'win32') return environment
  const currentPath = environment.PATH?.split(delimiter).filter(Boolean) ?? []
  const commonPaths = [
    join(homeDirectory, '.local', 'bin'),
    join(homeDirectory, 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/opt/local/bin',
    '/Library/Developer/CommandLineTools/usr/bin',
    '/Applications/Xcode.app/Contents/Developer/usr/bin',
    '/usr/bin',
    '/bin',
  ]
  return {
    ...environment,
    PATH: [...new Set([...currentPath, ...commonPaths])].join(delimiter),
  }
}

export async function probeDevelopmentCommand(
  command: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  signal?: AbortSignal
): Promise<boolean> {
  const pathValue =
    environment.PATH ??
    (platform === 'win32'
      ? Object.entries(environment).find(([key]) => key.toLowerCase() === 'path')?.[1]
      : undefined)
  if (!pathValue) return false

  const extensions =
    platform === 'win32'
      ? (environment.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean)
          .map(extension => extension.toLowerCase())
      : ['']
  for (const directory of pathValue.split(platform === 'win32' ? ';' : delimiter)) {
    if (signal?.aborted) return false
    const unquotedDirectory = directory.trim().replace(/^"(.*)"$/, '$1')
    if (!unquotedDirectory) continue
    for (const extension of extensions) {
      if (signal?.aborted) return false
      const candidate = normalize(join(unquotedDirectory, `${command}${extension}`))
      if (platform === 'darwin' && command === 'git' && candidate === '/usr/bin/git') {
        continue
      }
      try {
        await access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK)
        if ((await stat(candidate)).isFile()) return true
      } catch {
        // Continue searching the remaining PATH entries.
      }
    }
  }
  return false
}
