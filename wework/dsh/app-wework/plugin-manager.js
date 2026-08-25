import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const PROFILE_NAME = 'wework-core'
const IMMUTABLE_PLUGINS = new Set([
  '@wegent/dsh-app-wework',
  '@wegent/dsh-electron-host',
  '@wegent/dsh-executor-runtime',
  '@wegent/dsh-terminal-runtime',
])

export class CoreDshPluginManager {
  constructor(options = {}) {
    const dshHome = options.dshHome ?? process.env.DSH_HOME
    if (!dshHome) throw new Error('DSH_HOME is required to manage Core DSH plugins')
    this.profileRoot = join(dshHome, 'profiles', PROFILE_NAME)
    this.command = options.command ?? 'pnpm'
    this.runCommand = options.runCommand ?? runCommand
  }

  async inventory() {
    const manifest = await this.readManifest()
    const dependencies = manifest.dependencies ?? {}
    const bundles = new Set(manifest.dsh?.profile?.bundles ?? [])
    return Promise.all(
      Object.entries(dependencies).map(async ([name, spec]) => {
        const installed = await readJson(
          join(this.profileRoot, 'node_modules', ...name.split('/'), 'package.json')
        )
        const repository =
          typeof installed?.repository === 'string'
            ? installed.repository
            : typeof installed?.repository?.url === 'string'
              ? installed.repository.url
              : ''
        return {
          name,
          displayName: installed?.displayName || installed?.name || name,
          description: installed?.description || '',
          version: installed?.version || '',
          spec: String(spec),
          active: bundles.has(name),
          immutable: IMMUTABLE_PLUGINS.has(name),
          bundle: Boolean(installed?.dsh?.bundle?.patch),
          client: Boolean(installed?.dsh?.client),
          homepage: typeof installed?.homepage === 'string' ? installed.homepage : '',
          repository,
        }
      })
    )
  }

  async install(spec) {
    validateSpec(spec)
    await this.runPnpm(['add', spec])
    await this.reconcileBundles()
    return this.inventory()
  }

  async setActive(name, active) {
    validateName(name)
    if (IMMUTABLE_PLUGINS.has(name)) throw new Error(`${name} is a built-in Core DSH plugin`)
    const manifest = await this.readManifest()
    if (!manifest.dependencies?.[name]) throw new Error(`${name} is not installed`)
    const installed = await readJson(
      join(this.profileRoot, 'node_modules', ...name.split('/'), 'package.json')
    )
    if (!installed?.dsh?.bundle?.patch) throw new Error(`${name} does not declare dsh.bundle`)
    const bundles = new Set(manifest.dsh?.profile?.bundles ?? [])
    if (active) bundles.add(name)
    else bundles.delete(name)
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles] } }
    await this.writeManifest(manifest)
    return this.inventory()
  }

  async uninstall(name) {
    validateName(name)
    if (IMMUTABLE_PLUGINS.has(name)) throw new Error(`${name} is a built-in Core DSH plugin`)
    await this.runPnpm(['remove', name])
    await this.reconcileBundles()
    return this.inventory()
  }

  async runPnpm(args) {
    try {
      await this.runCommand(this.command, args, { cwd: this.profileRoot })
    } catch (error) {
      const output = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`
      const matcher = parseBlockedBuildMatcher(output)
      if (!matcher) throw error
      await allowBuild(this.profileRoot, matcher)
      await this.runCommand(this.command, args, { cwd: this.profileRoot })
    }
  }

  async reconcileBundles() {
    const manifest = await this.readManifest()
    const dependencies = Object.keys(manifest.dependencies ?? {})
    const bundles = new Set(manifest.dsh?.profile?.bundles ?? [])
    for (const name of dependencies) {
      const installed = await readJson(
        join(this.profileRoot, 'node_modules', ...name.split('/'), 'package.json')
      )
      if (installed?.dsh?.bundle?.patch) bundles.add(name)
      else bundles.delete(name)
    }
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles] } }
    await this.writeManifest(manifest)
  }

  readManifest() {
    return readJson(join(this.profileRoot, 'package.json'))
  }

  writeManifest(manifest) {
    return writeFile(
      join(this.profileRoot, 'package.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 }
    )
  }
}

export function parseBlockedBuildMatcher(output) {
  if (!output.includes('ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED')) return null
  const matches = [...output.matchAll(/^\s{2}("[^"]+"|'[^']+'|[^:\n]+):\s*(?:true|false)\s*$/gm)]
  const raw = matches.at(-1)?.[1]?.trim()
  return raw ? raw.replace(/^(['"])(.*)\1$/, '$2') : null
}

async function allowBuild(profileRoot, matcher) {
  const path = join(profileRoot, 'pnpm-workspace.yaml')
  let workspace = await readFile(path, 'utf8')
  if (workspace.includes(`${JSON.stringify(matcher)}: true`)) return
  if (!/^allowBuilds:\s*$/m.test(workspace)) {
    workspace = `${workspace.trimEnd()}\n\nallowBuilds:\n`
  }
  workspace = workspace.replace(
    /^allowBuilds:\s*$/m,
    `allowBuilds:\n  ${JSON.stringify(matcher)}: true`
  )
  await writeFile(path, `${workspace.trimEnd()}\n`, { mode: 0o600 })
}

function validateSpec(spec) {
  if (
    typeof spec !== 'string' ||
    !spec.trim() ||
    spec.length > 2048 ||
    spec.startsWith('-') ||
    /[\r\n\0]/.test(spec)
  ) {
    throw new Error('Invalid plugin spec')
  }
}

function validateName(name) {
  if (typeof name !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) {
    throw new Error('Invalid plugin name')
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.once('error', error => reject(Object.assign(error, { stdout, stderr })))
    child.once('exit', code => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(Object.assign(new Error(`pnpm exited with code ${code}`), { stdout, stderr }))
    })
  })
}
