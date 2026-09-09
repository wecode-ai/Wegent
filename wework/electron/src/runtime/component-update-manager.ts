import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import type { ComponentDownloadProgress } from '../host/app-update-progress.js'
import { pipeline } from 'node:stream/promises'
import * as tar from 'tar'

export const MANAGED_COMPONENT_IDS = [
  'coreDsh',
  'weworkCorePlugins',
  'weworkAppStatic',
  'bundledPlugins',
  'executor',
  'codex',
  'dws',
] as const

const WEWORK_APP_STATIC_DIRECTORIES = ['vendor', 'wasm'] as const

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
  stagedFromAppVersion?: string
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

interface ResolvedComponent {
  id: ManagedComponentId
  path: string
  contentSha256: string
}

export interface ComponentUpdateManagerOptions {
  resourcesRoot: string
  dataDirectory: string
  updateBaseUrl: string
  currentAppVersion: string
  platform?: NodeJS.Platform
  arch?: string
  fetch?: typeof fetch
  log?: (event: Record<string, unknown>) => void
}

export class ComponentUpdateManager {
  private readonly resourcesRoot: string
  private readonly root: string
  private readonly updateBaseUrl: string
  private readonly currentAppVersion: string
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly fetch: typeof fetch
  private readonly log: (event: Record<string, unknown>) => void
  private activeStage: {
    id: string
    key: string
    promise: Promise<boolean>
    listeners: Set<(progress: ComponentDownloadProgress) => void>
    progress?: ComponentDownloadProgress
  } | null = null
  private packaged: PackagedComponentManifest | null = null

  constructor(options: ComponentUpdateManagerOptions) {
    this.log = event => options.log?.({ stageId: this.activeStage?.id, ...event })
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
    if (state.activationInProgress) {
      const crossedHostVersion =
        state.current?.stagedFromAppVersion !== undefined &&
        state.current.stagedFromAppVersion !== this.currentAppVersion
      if (crossedHostVersion) {
        state = {
          schemaVersion: 1,
          current: state.current,
        }
        await this.writeState(state)
      } else {
        state = {
          schemaVersion: 1,
          ...(state.previous?.appVersion === this.currentAppVersion
            ? { current: state.previous }
            : {}),
          ...(state.pending ? { pending: state.pending } : {}),
        }
        await this.writeState(state)
      }
    } else if (state.pending?.appVersion === this.currentAppVersion) {
      state = {
        schemaVersion: 1,
        ...(state.current ? { previous: state.current } : {}),
        current: state.pending,
        activationInProgress: true,
      }
      await this.writeState(state)
    }

    try {
      const current =
        state.current?.appVersion === this.currentAppVersion ? state.current : undefined
      return await this.resolvePaths(packaged, current)
    } catch (error) {
      console.error('[components] active component set is invalid; using packaged resources', error)
      await this.writeState({
        schemaVersion: 1,
        ...(state.pending ? { pending: state.pending } : {}),
      })
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
    if (
      state.current?.stagedFromAppVersion !== undefined &&
      state.current.stagedFromAppVersion !== this.currentAppVersion
    ) {
      await this.writeState({
        schemaVersion: 1,
        ...(state.current?.appVersion === this.currentAppVersion ? { current: state.current } : {}),
      })
      return false
    }
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
    return this.stageUpdateForApp(this.currentAppVersion, channel, true)
  }

  async stageUpdateForApp(
    appVersion: string,
    channel: string,
    ignoreDifferentAppVersion = false,
    onProgress?: (progress: ComponentDownloadProgress) => void
  ): Promise<boolean> {
    const key = JSON.stringify([appVersion, channel, ignoreDifferentAppVersion])
    if (this.activeStage) {
      if (this.activeStage.key !== key) {
        await this.activeStage.promise.catch(() => undefined)
        return this.stageUpdateForApp(appVersion, channel, ignoreDifferentAppVersion, onProgress)
      }
      const active = this.activeStage
      if (onProgress) {
        active.listeners.add(onProgress)
        if (active.progress) onProgress(active.progress)
      }
      try {
        return await active.promise
      } finally {
        if (onProgress) active.listeners.delete(onProgress)
      }
    }
    const listeners = new Set<(progress: ComponentDownloadProgress) => void>()
    if (onProgress) listeners.add(onProgress)
    const promise = this.performStage(appVersion, channel, ignoreDifferentAppVersion, progress => {
      progress = { ...progress, stageId: this.activeStage?.id }
      if (this.activeStage) this.activeStage.progress = progress
      listeners.forEach(listener => listener(progress))
    })
    this.activeStage = { id: randomUUID(), key, promise, listeners }
    this.log({ event: 'component-stage-started', appVersion, channel })
    try {
      return await promise
    } finally {
      this.activeStage = null
    }
  }

  private async performStage(
    appVersion: string,
    channel: string,
    ignoreDifferentAppVersion: boolean,
    onProgress: (progress: ComponentDownloadProgress) => void
  ): Promise<boolean> {
    const packaged = await this.packagedManifest()
    if (channel !== 'stable' && channel !== 'beta') {
      throw new Error(`Unsupported component update channel: ${channel}`)
    }
    const target = platformTarget(this.platform, this.arch)
    const manifestUrl = `${this.updateBaseUrl}/components-${channel}-${target.platform}-${target.arch}.json`
    const response = await this.fetch(manifestUrl, { cache: 'no-store' })
    if (!response.ok) {
      throw new Error(`Component manifest request failed: HTTP ${response.status}`)
    }
    const manifest = (await response.json()) as unknown
    if (
      ignoreDifferentAppVersion &&
      isRecord(manifest) &&
      manifest.appVersion !== this.currentAppVersion
    ) {
      return false
    }
    const remote = validateRemoteManifest(
      manifest,
      appVersion,
      channel,
      target.platform,
      target.arch
    )
    const state = await this.readState()
    const current = state.current?.appVersion === this.currentAppVersion ? state.current : undefined
    const effective = current?.components
    const changed = MANAGED_COMPONENT_IDS.some(
      id =>
        remote.components[id].contentSha256 !==
        (effective?.[id].contentSha256 ?? packaged.components[id].sha256)
    )
    if (!changed && appVersion === this.currentAppVersion) return false

    const reusable = await this.resolveComponents(packaged, current)
    const reusablePaths = Object.fromEntries(
      reusable.map(component => [component.id, component.path])
    ) as Record<ManagedComponentId, string>
    const stagedComponents = {} as Record<ManagedComponentId, RemoteComponent>

    const downloads: Array<{ id: ManagedComponentId; component: RemoteComponent }> = []
    for (const id of MANAGED_COMPONENT_IDS) {
      const component = remote.components[id]
      const effectiveComponent = effective?.[id]
      const expectedCurrentContentSha256 =
        effectiveComponent?.contentSha256 ?? packaged.components[id].sha256
      if (
        appVersion === this.currentAppVersion &&
        component.contentSha256 === expectedCurrentContentSha256
      ) {
        this.log({ event: 'component-reused', id, reason: 'current-content' })
        stagedComponents[id] =
          effectiveComponent ??
          (await this.packagedComponentDescriptor(
            packaged.components[id].version,
            reusablePaths[id],
            packaged.components[id].sha256
          ))
        continue
      }
      const reusableContentSha256 = await hashComponentPath(reusablePaths[id])
      if (component.contentSha256 === reusableContentSha256) {
        this.log({ event: 'component-reused', id, reason: 'verified-installed-content' })
        const reusable =
          effectiveComponent ??
          (await this.packagedComponentDescriptor(
            packaged.components[id].version,
            reusablePaths[id],
            reusableContentSha256
          ))
        stagedComponents[id] = {
          ...reusable,
          version: component.version,
        }
        if (appVersion === this.currentAppVersion) {
          continue
        }
        await this.ensureReusableComponent(id, stagedComponents[id], reusablePaths[id])
      } else {
        const target = this.componentRoot(id, component.archiveSha256)
        const componentPath =
          component.entryPath === '.' ? target : join(target, component.entryPath)
        if (!(await componentMatches(componentPath, component.contentSha256))) {
          downloads.push({ id, component })
          this.log({
            event: 'component-download-required',
            id,
            version: component.version,
            archiveBytes: component.archiveBytes,
          })
        } else {
          this.log({ event: 'component-reused', id, reason: 'verified-cache' })
        }
        stagedComponents[id] = component
      }
    }
    await this.downloadComponents(downloads, onProgress)
    await this.writeState({
      ...state,
      schemaVersion: 1,
      pending: {
        appVersion: remote.appVersion,
        stagedFromAppVersion: this.currentAppVersion,
        components: stagedComponents,
      },
    })
    return true
  }

  private async packagedComponentDescriptor(
    version: string,
    source: string,
    contentSha256: string
  ): Promise<RemoteComponent> {
    const metadata = await stat(source)
    return {
      version,
      contentSha256,
      archiveSha256: contentSha256,
      archiveBytes: 1,
      downloadUrl: 'local://packaged-component',
      entryPath: metadata.isDirectory() ? '.' : basename(source),
    }
  }

  private async ensureReusableComponent(
    id: ManagedComponentId,
    component: RemoteComponent,
    source: string
  ): Promise<void> {
    const target = this.componentRoot(id, component.archiveSha256)
    const componentPath = component.entryPath === '.' ? target : join(target, component.entryPath)
    if (await componentMatches(componentPath, component.contentSha256)) return

    const temporary = `${target}.${process.pid}.tmp`
    await rm(temporary, { recursive: true, force: true })
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    try {
      if (component.entryPath === '.') {
        await cp(source, temporary, { recursive: true, force: true })
      } else {
        await mkdir(temporary, { recursive: true, mode: 0o700 })
        await cp(source, join(temporary, component.entryPath), {
          recursive: true,
          force: true,
        })
      }
      const stagedPath =
        component.entryPath === '.' ? temporary : join(temporary, component.entryPath)
      if (!(await componentMatches(stagedPath, component.contentSha256))) {
        throw new Error(`Reusable component checksum mismatch: ${id}`)
      }
      await rm(target, { recursive: true, force: true })
      await rename(temporary, target)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
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
    const resolved = await this.resolveComponents(packaged, current)
    const paths = {} as Record<ManagedComponentId, string>
    const fingerprints = {} as Record<ManagedComponentId, string>
    for (const entry of resolved) {
      paths[entry.id] = entry.path
      fingerprints[entry.id] = entry.contentSha256
    }
    const composedCorePlugins = await this.composeCorePlugins(
      paths.weworkCorePlugins,
      paths.weworkAppStatic,
      fingerprints.weworkCorePlugins,
      fingerprints.weworkAppStatic
    )
    fingerprints.weworkCorePlugins = createHash('sha256')
      .update(fingerprints.weworkCorePlugins)
      .update('\0')
      .update(fingerprints.weworkAppStatic)
      .digest('hex')
    return {
      coreDsh: paths.coreDsh,
      weworkCorePlugins: composedCorePlugins,
      bundledPlugins: paths.bundledPlugins,
      executor: paths.executor,
      codex: await this.resolveCodexBinary(paths.codex),
      dws: paths.dws,
      contentSha256: fingerprints,
    }
  }

  private async resolveCodexBinary(componentPath: string): Promise<string> {
    const componentMetadata = await stat(componentPath)
    let binaryPath = componentPath
    if (componentMetadata.isDirectory()) {
      const manifestPath = join(componentPath, 'WEGENT_CODEX_BINARY.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown
      if (!isRecord(manifest) || !isSafeRelativePath(manifest.binaryPath)) {
        throw new Error(`Codex runtime metadata is invalid: ${manifestPath}`)
      }
      binaryPath = join(componentPath, manifest.binaryPath)
    } else if (!componentMetadata.isFile()) {
      throw new Error(`Codex runtime component is invalid: ${componentPath}`)
    }

    const binaryMetadata = await stat(binaryPath)
    if (!binaryMetadata.isFile()) {
      throw new Error(`Codex executable is invalid: ${binaryPath}`)
    }
    const hostName = this.platform === 'win32' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host'
    const hostPath = join(dirname(binaryPath), hostName)
    const hostMetadata = await stat(hostPath)
    if (!hostMetadata.isFile()) {
      throw new Error(`Codex code-mode host is invalid: ${hostPath}`)
    }
    return binaryPath
  }

  private async resolveComponents(
    packaged: PackagedComponentManifest,
    current?: ComponentSet
  ): Promise<ResolvedComponent[]> {
    return Promise.all(
      MANAGED_COMPONENT_IDS.map(async id => {
        const packagedComponent = packaged.components[id]
        const active = current?.components[id]
        const contentSha256 = active?.contentSha256 ?? packagedComponent.sha256
        let path: string
        if (!active) {
          path = join(this.resourcesRoot, packagedComponent.path)
          await stat(path)
        } else {
          const root = this.componentRoot(id, active.archiveSha256)
          const managedPath = active.entryPath === '.' ? root : join(root, active.entryPath)
          if (await componentMatches(managedPath, active.contentSha256)) {
            path = managedPath
          } else if (active.contentSha256 === packagedComponent.sha256) {
            path = join(this.resourcesRoot, packagedComponent.path)
            await stat(path)
          } else {
            throw new Error(`Managed component checksum mismatch: ${id}`)
          }
        }
        return { id, path, contentSha256 }
      })
    )
  }

  private async composeCorePlugins(
    corePlugins: string,
    appStatic: string,
    coreSha256: string,
    staticSha256: string
  ): Promise<string> {
    const fingerprint = createHash('sha256')
      .update(coreSha256)
      .update('\0')
      .update(staticSha256)
      .digest('hex')
    const target = join(this.root, 'composed', 'wework-core-plugins', fingerprint)
    if ((await stat(target).catch(() => null))?.isDirectory()) return target

    const temporary = `${target}.${process.pid}.tmp`
    await rm(temporary, { recursive: true, force: true })
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    try {
      await mkdir(temporary, { recursive: true, mode: 0o700 })
      await this.copyDirectoryEntries(corePlugins, temporary, new Set(['wework-app']))
      const appRoot = join(temporary, 'wework-app')
      await mkdir(appRoot, { recursive: true, mode: 0o700 })
      await this.copyDirectoryEntries(join(corePlugins, 'wework-app'), appRoot, new Set(['web']))
      const webRoot = join(appRoot, 'web')
      await mkdir(webRoot, { recursive: true, mode: 0o700 })
      await this.linkDirectoryEntries(
        join(corePlugins, 'wework-app', 'web'),
        webRoot,
        new Set(WEWORK_APP_STATIC_DIRECTORIES)
      )
      for (const directory of WEWORK_APP_STATIC_DIRECTORIES) {
        await this.linkEntry(join(appStatic, directory), join(webRoot, directory))
      }
      await rm(target, { recursive: true, force: true })
      await rename(temporary, target)
      return target
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }

  private async copyDirectoryEntries(
    source: string,
    destination: string,
    excluded: ReadonlySet<string>
  ): Promise<void> {
    const entries = await readdir(source, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (excluded.has(entry.name)) continue
      await cp(join(source, entry.name), join(destination, entry.name), {
        recursive: true,
        force: true,
      })
    }
  }

  private async linkDirectoryEntries(
    source: string,
    destination: string,
    excluded: ReadonlySet<string>
  ): Promise<void> {
    const entries = await readdir(source, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (excluded.has(entry.name)) continue
      await this.linkEntry(join(source, entry.name), join(destination, entry.name))
    }
  }

  private async linkEntry(source: string, destination: string): Promise<void> {
    const metadata = await lstat(source)
    if (metadata.isDirectory()) {
      await symlink(source, destination, this.platform === 'win32' ? 'junction' : 'dir')
      return
    }
    if (metadata.isFile()) {
      await cp(source, destination)
      return
    }
    throw new Error(`Unsupported Wework app component entry: ${source}`)
  }

  private async downloadComponents(
    downloads: Array<{ id: ManagedComponentId; component: RemoteComponent }>,
    onProgress: (progress: ComponentDownloadProgress) => void
  ): Promise<void> {
    const progress: ComponentDownloadProgress = {
      downloadedBytes: 0,
      totalBytes: downloads.reduce((sum, item) => sum + item.component.archiveBytes, 0),
      completedComponents: 0,
      totalComponents: downloads.length,
    }
    onProgress({ ...progress })
    const controller = new AbortController()
    let next = 0
    let failure: unknown
    const worker = async () => {
      while (!controller.signal.aborted && next < downloads.length) {
        const { id, component } = downloads[next++]!
        try {
          await this.ensureComponent(id, component, controller.signal, bytes => {
            progress.downloadedBytes += bytes
            onProgress({ ...progress })
          })
          progress.completedComponents++
          onProgress({ ...progress })
          this.log({ event: 'component-downloaded', id, archiveBytes: component.archiveBytes })
        } catch (error) {
          if (!controller.signal.aborted) failure = error
          controller.abort()
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, downloads.length) }, worker))
    if (controller.signal.aborted) throw failure
  }

  private async ensureComponent(
    id: ManagedComponentId,
    component: RemoteComponent,
    signal: AbortSignal,
    onBytes: (bytes: number) => void
  ): Promise<void> {
    const target = this.componentRoot(id, component.archiveSha256)
    const componentPath = component.entryPath === '.' ? target : join(target, component.entryPath)
    if (await componentMatches(componentPath, component.contentSha256)) return

    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    const archive = `${target}.${process.pid}.tar.gz`
    const temporary = `${target}.${process.pid}.tmp`
    await rm(archive, { force: true })
    await rm(temporary, { recursive: true, force: true })
    try {
      const response = await this.fetch(component.downloadUrl, { cache: 'no-store', signal })
      if (!response.ok || !response.body) {
        throw new Error(`Component download failed for ${id}: HTTP ${response.status}`)
      }
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            onBytes(chunk.length)
            callback(null, chunk)
          },
        }),
        createWriteStream(archive, { mode: 0o600 }),
        { signal }
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
    if (
      !isRecord(value) ||
      !isText(value.appVersion) ||
      (value.stagedFromAppVersion !== undefined && !isText(value.stagedFromAppVersion)) ||
      !isRecord(value.components)
    ) {
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
