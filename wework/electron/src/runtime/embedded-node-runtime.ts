import { existsSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

export interface EmbeddedNodeEnvironmentOptions {
  electronExecutable: string
  dataDirectory: string
  environment: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

export async function prepareEmbeddedNodeEnvironment(
  options: EmbeddedNodeEnvironmentOptions
): Promise<NodeJS.ProcessEnv> {
  const platform = options.platform ?? process.platform
  const binDirectory = join(options.dataDirectory, 'managed-runtimes', 'electron-node', 'bin')
  await mkdir(binDirectory, { recursive: true, mode: 0o700 })
  if (platform === 'win32') {
    await writeWindowsLauncher(join(binDirectory, 'node.cmd'), options.electronExecutable)
  } else {
    await writeUnixLauncher(join(binDirectory, 'node'), options.electronExecutable)
  }
  return {
    ...options.environment,
    ELECTRON_RUN_AS_NODE: '1',
    WEWORK_NODE_PATH: options.electronExecutable,
    WEWORK_NODE_BIN: binDirectory,
    NODE: options.electronExecutable,
    npm_node_execpath: options.electronExecutable,
    PATH: prependPath(binDirectory, options.environment.PATH),
  }
}

export function embeddedNodeArguments(
  environment: NodeJS.ProcessEnv,
  args: readonly string[]
): string[] {
  return environment.ELECTRON_RUN_AS_NODE === '1' ? ['--expose-internals', ...args] : [...args]
}

async function writeUnixLauncher(path: string, electronExecutable: string): Promise<void> {
  await writeFile(
    path,
    `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${shellQuote(electronExecutable)} "$@"\n`,
    { mode: 0o700 }
  )
  await chmod(path, 0o700)
}

async function writeWindowsLauncher(path: string, electronExecutable: string): Promise<void> {
  const escaped = electronExecutable.replaceAll('%', '%%').replaceAll('"', '""')
  await writeFile(path, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${escaped}" %*\r\n`, {
    mode: 0o600,
  })
}

function prependPath(entry: string, current: string | undefined): string {
  if (!current) return entry
  const entries = current.split(delimiter)
  if (entries.some(candidate => candidate === entry && existsSync(candidate))) return current
  return [entry, current].join(delimiter)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
