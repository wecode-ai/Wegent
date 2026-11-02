import { readFile, realpath, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join, relative } from 'node:path'
import { tmpdir } from 'node:os'

export interface PluginPythonInterpreter {
  path: string
  version: string
  source: 'managed' | 'system'
}

export type PythonProbe = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; cwd?: string }
) => Promise<{ stdout: string; stderr: string }>

const PROBE = [
  'import ensurepip, json, ssl, sys, venv, zlib',
  'print(json.dumps({"path": sys.executable, "version": sys.version.split()[0]}))',
].join('; ')

async function compatibleMinor(pluginRoot: string): Promise<string | null> {
  if (!isAbsolute(pluginRoot)) return null
  for (const marker of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) {
    try {
      const manifest = JSON.parse(await readFile(join(pluginRoot, marker), 'utf8'))
      const python = manifest.runtimeRequirements?.python?.systemFallback
      if (
        typeof manifest.name === 'string' &&
        python &&
        /^3\.\d+$/.test(python.version) &&
        Array.isArray(python.dependencies) &&
        python.dependencies.length === 0
      )
        return python.version
      return null
    } catch {
      // Packages may use either of the supported plugin manifests.
    }
  }
  return null
}

export async function findCompatibleSystemPython(
  pluginRoot: string,
  managedRoot: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  probe: PythonProbe
): Promise<PluginPythonInterpreter | null> {
  const minor = await compatibleMinor(pluginRoot)
  if (!minor) return null
  managedRoot = await realpath(managedRoot).catch(() => managedRoot)
  const candidates = await systemCandidates(environment, platform, minor)
  for (const path of candidates) {
    const inside = relative(managedRoot, path)
    if (!inside || (!inside.startsWith('..') && !isAbsolute(inside))) continue
    try {
      const result = await probe(path, ['-I', '-S', '-B', '-c', PROBE], {
        env: probeEnvironment(environment),
        cwd: tmpdir(),
        timeout: 3_000,
      })
      const details = JSON.parse(result.stdout.trim())
      if (
        typeof details.version === 'string' &&
        details.version.split('.').slice(0, 2).join('.') === minor &&
        details.path &&
        isAbsolute(details.path)
      )
        return { path: await realpath(details.path), version: details.version, source: 'system' }
    } catch {
      // An unavailable or incompatible candidate cannot satisfy plugin readiness.
    }
  }
  return null
}

async function systemCandidates(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  minor: string
): Promise<string[]> {
  const paths = Object.entries(environment).find(([key]) => key.toUpperCase() === 'PATH')?.[1]
  const suffix = platform === 'win32' ? '.exe' : ''
  const candidates = new Set<string>()
  const directories = (paths ?? '').split(platform === 'win32' ? ';' : delimiter).filter(isAbsolute)
  for (const name of [`python${minor}`, 'python3', 'python']) {
    for (const directory of directories) {
      try {
        const path = await realpath(join(directory, `${name}${suffix}`))
        if ((await stat(path)).isFile()) candidates.add(path)
        if (candidates.size >= 3) return [...candidates]
      } catch {
        // Only existing absolute executable candidates are probed.
      }
    }
  }
  return [...candidates].slice(0, 3)
}

function probeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL'])
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => allowed.has(key.toUpperCase()))
  )
}
