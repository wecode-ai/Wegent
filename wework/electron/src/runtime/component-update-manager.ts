import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as tar from 'tar'

export const MANAGED_COMPONENT_IDS = [
  'coreDsh',
  'weworkCorePlugins',
  'bundledPlugins',
  'executor',
  'codex',
  'dws',
] as const

export type ManagedComponentId = (typeof MANAGED_COMPONENT_IDS)[number]

interface PackagedComponent {
  version: string
  path: string
  sha256: string
}

interface PackagedComponentManifest {
  schemaVersion: number
  appVersion: string
  channel?: string
  components: Record<ManagedComponentId, PackagedComponent>
}

interface RemoteComponent {
  version: string
  contentSha256: string
  archiveSha256: string
  archiveBytes: number
  downloadUrl: string
  entryPath: string
}

interface RemoteComponentManifest {
  schemaVersion: number
  appVersion: string
  channel: string
  platform: string
  arch: string
  components: Record<ManagedComponentId, RemoteComponent>
}

interface ComponentSet {
  appVersion: string
  components: Record<ManagedComponentId, RemoteComponent>
}

interface ComponentState {
  schemaVersion: 1
  current?: ComponentSet
  previous?: ComponentSet
  pending?: ComponentSet
  activationInProgress?: boolean
}

export interface ComponentPaths {
  coreDsh: string
  weworkCorePlugins: string
  bundledPlugins: string
  executor: string
  codex: string
  dws: string
  contentSha256: Record<ManagedComponentId, string>
}

export interface ComponentUpdateManagerOptions {
  resourcesRoot: string
  dataDirectory: string
  updateBaseUrl: string
  currentAppVersion: string
  platform?: NodeJS.Platform
  arch?: string
  fetch?: typeof fetch
}

export class ComponentUpdateManager {
  private readonly resourcesRoot: string
  private readonly root: string
  private readonly updateBaseUrl: string
  private readonly currentAppVersion: string
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly fetch: typeof fetch
  private packaged: PackagedComponentManifest | null = null

  constructor(options: ComponentUpdateManagerOptions) {
    this.resourcesRoot = resolve(options.resourcesRoot)
    this.root = join(resolve(options.dataDirectory), 'managed-components')
    this.updateBaseUrl = options.updateBaseUrl.replace(/\/+$/, '')
    this.currentAppVersion = options.currentAppVersion
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.fetch = options.fetch ?? globalThis.fetch
  }

  async prepareStartup(): Promise<ComponentPaths> {
    const packaged = await this.packagedManifest()
    let state = await this.readState()
    if (
      [state.current, state.previous, state.pending].some(
        componentSet => componentSet && componentSet.appVersion !== this.currentAppVersion
      )
    ) {
      state = { schemaVersion: 1 }
      await this.writeState(state)
    } else if (state.activationInProgress) {
      state = {
        schemaVersion: 1,
        ...(state.previous ? { current: state.previous } : {}),
      }
      await this.writeState(state)
    }

    if (state.pending?.appVersion === this.currentAppVersion) {
      state = {
        schemaVersion: 1,
        ...(state.current ? { previous: state.current } : {}),
        current: state.pending,
        activationInProgress: true,
      }
      await this.writeState(state)
    }

    try {
      return await this.resolvePaths(packaged, state.current)
    } catch (error) {
      console.error('[components] active component set is invalid; using packaged resources', error)
      await this.writeState({ schemaVersion: 1 })
      return this.resolvePaths(packaged)
    }
  }

  async confirmStartup(): Promise<void> {
    const state = await this.readState()
    if (!state.activationInProgress) return
    await this.writeState({
      schemaVersion: 1,
      ...(state.current ? { current: state.current } : {}),
    })
  }

  async rollbackStartup(): Promise<boolean> {
    const state = await this.readState()
    if (!state.activationInProgress) return false
    await this.writeState({
      schemaVersion: 1,
      ...(state.previous ? { current: state.previous } : {}),
    })
    return true
  }

  async stageAvailableUpdate(): Promise<boolean> {
    const packaged = await this.packagedManifest()
    const channel = packaged.channel
    if (channel !== 'stable' && channel !== 'beta') return false

    const target = platformTarget(this.platform, this.arch)
    const manifestUrl = `${this.updateBaseUrl}/components-${channel}-${target.platform}-${target.arch}.json`
    const response = await this.fetch(manifestUrl, { cache: 'no-store' })
    if (!response.ok) {
      throw new Error(`Component manifest request failed: HTTP ${response.status}`)
    }
    const remote = validateRemoteManifest(
      (await response.json()) as unknown,
      this.currentAppVersion,
      channel,
      target.platform,
      target.arch
    )
    const state = await this.readState()
    const effective = state.current?.components
    const changed = MANAGED_COMPONENT_IDS.some(
      id =>
        remote.components[id].contentSha256 !==
        (effective?.[id].contentSha256 ?? packaged.components[id].sha256)
    )
    if (!changed) return false

    for (const id of MANAGED_COMPONENT_IDS) {
      const component = remote.components[id]
      if (component.contentSha256 === packaged.components[id].sha256) continue
      await this.ensureComponent(id, component)
    }
    await this.writeState({
      ...state,
      schemaVersion: 1,
      pending: {
        appVersion: remote.appVersion,
        components: remote.components,
      },
    })
    return true
  }

  private async packagedManifest(): Promise<PackagedComponentManifest> {
    if (this.packaged) return this.packaged
    const path = join(this.resourcesRoot, 'components.json')
    const parsed = JSON.parse(await readFile(path, 'utf8')) as PackagedComponentManifest
    if (parsed.schemaVersion !== 1 || parsed.appVersion !== this.currentAppVersion) {
      throw new Error(`Packaged component manifest is incompatible: ${path}`)
    }
    for (const id of MANAGED_COMPONENT_IDS) {
      const component = parsed.components?.[id]
      if (
        !component ||
        !isText(component.version) ||
        !isSafeRelativePath(component.path) ||
        !isSha256(component.sha256)
      ) {
        throw new Error(`Packaged component metadata is invalid: ${id}`)
      }
    }
    this.packaged = parsed
    return parsed
  }

  private async resolvePaths(
    packaged: PackagedComponentManifest,
    current?: ComponentSet
  ): Promise<ComponentPaths> {
    const resolved = await Promise.all(
      MANAGED_COMPONENT_IDS.map(async id => {
        const packagedComponent = packaged.components[id]
        const active = current?.components[id]
        const contentSha256 = active?.contentSha256 ?? packagedComponent.sha256
        let path: string
        if (!active || active.contentSha256 === packagedComponent.sha256) {
          path = join(this.resourcesRoot, packagedComponent.path)
          await stat(path)
        } else {
          const root = this.componentRoot(id, active.archiveSha256)
          path = active.entryPath === '.' ? root : join(root, active.entryPath)
          if (!(await componentMatches(path, active.contentSha256))) {
            throw new Error(`Managed component checksum mismatch: ${id}`)
          }
        }
        return { id, path, contentSha256 }
      })
    )
    const paths = {} as Record<ManagedComponentId, string>
    const fingerprints = {} as Record<ManagedComponentId, string>
    for (const entry of resolved) {
      paths[entry.id] = entry.path
      fingerprints[entry.id] = entry.contentSha256
    }
    return {
      coreDsh: paths.coreDsh,
      weworkCorePlugins: paths.weworkCorePlugins,
      bundledPlugins: paths.bundledPlugins,
      executor: paths.executor,
      codex: paths.codex,
      dws: paths.dws,
      contentSha256: fingerprints,
    }
  }

  private async ensureComponent(id: ManagedComponentId, component: RemoteComponent): Promise<void> {
    const target = this.componentRoot(id, component.archiveSha256)
    const componentPath = component.entryPath === '.' ? target : join(target, component.entryPath)
    if (await componentMatches(componentPath, component.contentSha256)) return

    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    const archive = `${target}.${process.pid}.tar.gz`
    const temporary = `${target}.${process.pid}.tmp`
    await rm(archive, { force: true })
    await rm(temporary, { recursive: true, force: true })
    try {
      const response = await this.fetch(component.downloadUrl, { cache: 'no-store' })
      if (!response.ok || !response.body) {
        throw new Error(`Component download failed for ${id}: HTTP ${response.status}`)
      }
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        createWriteStream(archive, { mode: 0o600 })
      )
      const archiveMetadata = await stat(archive)
      if (archiveMetadata.size !== component.archiveBytes) {
        throw new Error(`Component archive size mismatch: ${id}`)
      }
      if ((await sha256(archive)) !== component.archiveSha256) {
        throw new Error(`Component archive checksum mismatch: ${id}`)
      }
      await mkdir(temporary, { recursive: true, mode: 0o700 })
      await tar.x({ cwd: temporary, file: archive, gzip: true, strict: true })
      if (
        !(await componentMatches(
          component.entryPath === '.' ? temporary : join(temporary, component.entryPath),
          component.contentSha256
        ))
      ) {
        throw new Error(`Extracted component checksum mismatch: ${id}`)
      }
      await rm(target, { recursive: true, force: true })
      await rename(temporary, target)
    } finally {
      await rm(archive, { force: true })
      await rm(temporary, { recursive: true, force: true })
    }
  }

  private componentRoot(id: ManagedComponentId, archiveSha256: string): string {
    return join(this.root, 'blobs', id, archiveSha256)
  }

  private async readState(): Promise<ComponentState> {
    try {
      const parsed = JSON.parse(await readFile(join(this.root, 'state.json'), 'utf8')) as unknown
      return validateState(parsed)
    } catch {
      return { schemaVersion: 1 }
    }
  }

  private async writeState(state: ComponentState): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const path = join(this.root, 'state.json')
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  }
}

function platformTarget(
  platform: NodeJS.Platform,
  arch: string
): { platform: string; arch: string } {
  const targetPlatform =
    platform === 'darwin'
      ? 'macos'
      : platform === 'win32'
        ? 'windows'
        : platform === 'linux'
          ? 'linux'
          : null
  if (!targetPlatform || (arch !== 'arm64' && arch !== 'x64')) {
    throw new Error(`Unsupported component update target: ${platform}-${arch}`)
  }
  return { platform: targetPlatform, arch }
}

function validateRemoteManifest(
  input: unknown,
  appVersion: string,
  channel: string,
  platform: string,
  arch: string
): RemoteComponentManifest {
  if (!isRecord(input)) throw new Error('Component manifest must be an object')
  if (
    input.schemaVersion !== 1 ||
    input.appVersion !== appVersion ||
    input.channel !== channel ||
    input.platform !== platform ||
    input.arch !== arch ||
    !isRecord(input.components)
  ) {
    throw new Error('Component manifest is incompatible with this application')
  }
  for (const id of MANAGED_COMPONENT_IDS) validateRemoteComponent(input.components[id], id)
  return input as unknown as RemoteComponentManifest
}

function validateRemoteComponent(input: unknown, id: ManagedComponentId): void {
  if (
    !isRecord(input) ||
    !isText(input.version) ||
    !isSha256(input.contentSha256) ||
    !isSha256(input.archiveSha256) ||
    typeof input.archiveBytes !== 'number' ||
    !Number.isSafeInteger(input.archiveBytes) ||
    input.archiveBytes <= 0 ||
    !isText(input.downloadUrl) ||
    !isSafeEntryPath(input.entryPath)
  ) {
    throw new Error(`Component manifest entry is invalid: ${id}`)
  }
}

function validateState(input: unknown): ComponentState {
  if (!isRecord(input) || input.schemaVersion !== 1) return { schemaVersion: 1 }
  for (const key of ['current', 'previous', 'pending'] as const) {
    const value = input[key]
    if (value === undefined) continue
    if (!isRecord(value) || !isText(value.appVersion) || !isRecord(value.components)) {
      return { schemaVersion: 1 }
    }
    for (const id of MANAGED_COMPONENT_IDS) {
      try {
        validateRemoteComponent(value.components[id], id)
      } catch {
        return { schemaVersion: 1 }
      }
    }
  }
  if (input.activationInProgress !== undefined && typeof input.activationInProgress !== 'boolean') {
    return { schemaVersion: 1 }
  }
  return input as unknown as ComponentState
}

async function componentMatches(path: string, expectedSha256: string): Promise<boolean> {
  try {
    return (await hashComponentPath(path)) === expectedSha256
  } catch {
    return false
  }
}

export async function hashComponentPath(path: string): Promise<string> {
  const metadata = await lstat(path)
  if (metadata.isFile()) return sha256(path)
  if (!metadata.isDirectory()) throw new Error(`Unsupported component entry: ${path}`)
  return hashTree(path)
}

async function hashTree(root: string, relative = ''): Promise<string> {
  const hash = createHash('sha256')
  const entries = await readdir(join(root, relative), { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = join(relative, entry.name)
    if (entry.isDirectory()) {
      hash.update(`directory:${child}\0${await hashTree(root, child)}\0`)
    } else if (entry.isFile()) {
      hash.update(`file:${child}\0${await sha256(join(root, child))}\0`)
    } else {
      throw new Error(`Unsupported component tree entry: ${child}`)
    }
  }
  return hash.digest('hex')
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function isSafeRelativePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
  )
}

function isSafeEntryPath(value: unknown): value is string {
  return value === '.' || isSafeRelativePath(value)
}
