import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join, win32 } from 'node:path'

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
    const runtimeBin = runtimeDirectory(configuredNodePath, options.platform)
    const environment: NodeJS.ProcessEnv = {
      ...withPrependedPath(options.environment, runtimeBin, options.platform),
      WEWORK_NODE_PATH: configuredNodePath,
      WEWORK_RUNTIME_BIN: runtimeBin,
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
      ...withPrependedPath(options.environment, runtimeBin, options.platform),
      ELECTRON_RUN_AS_NODE: '1',
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
  await rm(launcherPath, { force: true })
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

function withPrependedPath(
  environment: NodeJS.ProcessEnv,
  directory: string,
  platform: NodeJS.Platform
): NodeJS.ProcessEnv {
  const normalized = { ...environment }
  const currentPath =
    environment.PATH ??
    (platform === 'win32'
      ? Object.entries(environment).find(([key]) => key.toLowerCase() === 'path')?.[1]
      : undefined)
  if (platform === 'win32') {
    for (const key of Object.keys(normalized)) {
      if (key !== 'PATH' && key.toLowerCase() === 'path') delete normalized[key]
    }
  }
  normalized.PATH = prependPath(directory, currentPath, platform)
  return normalized
}

function prependPath(
  directory: string,
  currentPath: string | undefined,
  platform: NodeJS.Platform
): string {
  if (!currentPath) return directory
  const separator = platform === 'win32' ? win32.delimiter : delimiter
  const entries = currentPath.split(separator).filter(Boolean)
  return [directory, ...entries.filter(entry => entry !== directory)].join(separator)
}

function runtimeDirectory(path: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? win32.dirname(path) : dirname(path)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
