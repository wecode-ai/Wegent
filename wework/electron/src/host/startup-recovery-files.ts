import { readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { resetCoreDshRuntime } from '../runtime/core-dsh-runtime.js'

export async function clearStartupRuntimeFiles(dataDirectory: string): Promise<void> {
  await resetCoreDshRuntime(dataDirectory)
  await rm(join(dataDirectory, 'managed-components'), { recursive: true, force: true })
}

export interface StartupUserDataPaths {
  dataDirectory: string
  codexHome: string
  claudeHome: string
  capabilitiesHome: string
  protectedAgentHomes?: readonly string[]
}

export async function clearStartupUserFiles(paths: StartupUserDataPaths): Promise<void> {
  await assertAgentHomesAreIsolated(paths)
  // Shared package stores and authored marketplace sources are not installations.
  // Keep agent Homes themselves: they contain task sessions and transcripts.
  await clearPluginManifest(join(paths.capabilitiesHome, 'manifest-v2.json'))
  const targets = [
    join(paths.dataDirectory, 'dsh-core'),
    join(paths.dataDirectory, 'secure-values.json'),
    join(paths.dataDirectory, 'secure-values.key'),
    join(paths.codexHome, 'plugins'),
    join(paths.codexHome, 'config.toml'),
    join(paths.codexHome, 'auth.json'),
    join(paths.claudeHome, 'plugins'),
    join(paths.claudeHome, 'settings.json'),
    join(paths.claudeHome, '.credentials.json'),
  ]
  for (const path of targets) await rm(path, { recursive: true, force: true })
}

async function clearPluginManifest(path: string): Promise<void> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  let manifest: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(content)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Invalid capability manifest')
    }
    manifest = value as Record<string, unknown>
  } catch {
    // An explicit reset must also repair a damaged registry. Retain the original
    // for diagnosis instead of treating unreadable skill entries as deletable.
    await rename(path, `${path}.corrupt-${Date.now()}`)
    manifest = { version: 2, skills: {}, mcps: {} }
  }
  manifest.plugins = {}
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

async function assertAgentHomesAreIsolated(paths: StartupUserDataPaths): Promise<void> {
  for (const home of [paths.codexHome, paths.claudeHome]) {
    const actual = await canonicalPath(home)
    for (const protectedHome of paths.protectedAgentHomes ?? []) {
      const offset = relative(await canonicalPath(protectedHome), actual)
      if (!offset || (!offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset))) {
        throw new Error('Personal agent Homes cannot be cleared by Wework startup recovery')
      }
    }
  }
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolve(path)
    throw error
  }
}
