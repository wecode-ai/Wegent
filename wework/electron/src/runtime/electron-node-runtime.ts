import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'

export interface ElectronNodeRuntimeOptions {
  dataDirectory: string
  environment: NodeJS.ProcessEnv
  helperExecPath: string
  nodeVersion: string
  platform: NodeJS.Platform
}

export interface ElectronNodeRuntimeStatus {
  id: 'node'
  managed: false
  autoInstall: false
  state: 'installed'
  version: string
  downloadedBytes: 0
  totalBytes: 0
  installedBytes: 0
  path: string
  error: null
  source: 'electron' | 'configured'
}

export interface ElectronNodeRuntime {
  environment: NodeJS.ProcessEnv
  status: ElectronNodeRuntimeStatus
}

export async function prepareElectronNodeRuntime(
  options: ElectronNodeRuntimeOptions
): Promise<ElectronNodeRuntime> {
  const configuredNodePath = options.environment.WEWORK_NODE_PATH?.trim()
  if (configuredNodePath) {
    const environment: NodeJS.ProcessEnv = {
      ...options.environment,
      PATH: prependPath(dirname(configuredNodePath), options.environment.PATH),
      WEWORK_NODE_PATH: configuredNodePath,
      WEWORK_RUNTIME_BIN: dirname(configuredNodePath),
    }
    delete environment.ELECTRON_RUN_AS_NODE
    delete environment.WEWORK_NODE_RUNTIME_KIND
    return {
      environment,
      status: createStatus(configuredNodePath, options.nodeVersion, 'configured'),
    }
  }

  const runtimeBin = join(options.dataDirectory, 'runtime', 'bin')
  const launcherPath = join(runtimeBin, options.platform === 'win32' ? 'node.cmd' : 'node')
  await materializeNodeLauncher(launcherPath, options.helperExecPath, options.platform)
  const nodePath = options.platform === 'win32' ? options.helperExecPath : launcherPath

  return {
    environment: {
      ...options.environment,
      ELECTRON_RUN_AS_NODE: '1',
      PATH: prependPath(runtimeBin, options.environment.PATH),
      WEWORK_NODE_PATH: nodePath,
      WEWORK_NODE_RUNTIME_KIND: 'electron',
      WEWORK_RUNTIME_BIN: runtimeBin,
    },
    status: createStatus(nodePath, options.nodeVersion, 'electron'),
  }
}

export function runtimeNodeArgs(environment: NodeJS.ProcessEnv, args: string[]): string[] {
  return environment.WEWORK_NODE_RUNTIME_KIND === 'electron'
    ? ['--expose-internals', ...args]
    : args
}

export function resolveConfiguredNodePath(
  preferences: Record<string, unknown>,
  environment: NodeJS.ProcessEnv
): string | null {
  const value = preferences.nodeExecutablePath
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (Object.hasOwn(preferences, 'nodeExecutablePath')) return null
  return environment.WEWORK_NODE_PATH?.trim() || null
}

function createStatus(
  path: string,
  version: string,
  source: ElectronNodeRuntimeStatus['source']
): ElectronNodeRuntimeStatus {
  return {
    id: 'node',
    managed: false,
    autoInstall: false,
    state: 'installed',
    version,
    downloadedBytes: 0,
    totalBytes: 0,
    installedBytes: 0,
    path,
    error: null,
    source,
  }
}

async function materializeNodeLauncher(
  launcherPath: string,
  helperExecPath: string,
  platform: NodeJS.Platform
): Promise<void> {
  await mkdir(dirname(launcherPath), { recursive: true, mode: 0o700 })
  if (platform === 'win32') {
    const escaped = helperExecPath.replaceAll('%', '%%').replaceAll('"', '""')
    await writeFile(
      launcherPath,
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${escaped}" %*\r\n`,
      { mode: 0o600 }
    )
    return
  }

  await writeFile(
    launcherPath,
    `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${shellQuote(helperExecPath)} "$@"\n`,
    { mode: 0o700 }
  )
  await chmod(launcherPath, 0o700)
}

function prependPath(directory: string, currentPath: string | undefined): string {
  if (!currentPath) return directory
  const entries = currentPath.split(delimiter).filter(Boolean)
  return [directory, ...entries.filter(entry => entry !== directory)].join(delimiter)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
