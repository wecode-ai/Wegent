import { ZipArchive } from 'archiver'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import extractZip from 'extract-zip'
import semver from 'semver'
import type { WorkbenchRuntimeLaunch } from '../runtime/workbench-runtime.js'
import {
  prepareWorkbenchDshLaunch,
  WORKBENCH_DSH_VERSION,
  type WorkbenchAppManifest,
} from '../runtime/workbench-dsh-runtime.js'

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 250 * 1024 * 1024

export interface SmartAppInstallation {
  id: string
  manifest: WorkbenchAppManifest
  packagePath: string
  sha256: string
  modelKey: string | null
  resident: boolean
  runtimeVersion: string | null
  state: 'installed' | 'running' | 'failed'
  webUrl: string | null
  error: string | null
  smartAppId?: number | null
  releaseId?: number | null
  source: 'managed' | 'linked' | 'market'
}

export interface SmartAppPreview {
  valid: boolean
  archivePath: string
  sha256: string
  manifest: WorkbenchAppManifest | null
  issues: string[]
}

export interface SmartAppExport {
  archivePath: string
  sha256: string
  sizeBytes: number
  manifest: WorkbenchAppManifest
}

export interface SmartAppSavedExport extends SmartAppExport {
  destinationPath: string
}

export interface SmartAppRuntimeHost {
  open(launch: WorkbenchRuntimeLaunch): Promise<void>
  close(tabId: string): Promise<void>
  runningTabIds(): ReadonlySet<string>
}

export interface SmartAppManagerOptions {
  dataDirectory: string
  downloadsDirectory: string
  logDirectory: string
  runtimeRoot: string
  environment: NodeJS.ProcessEnv
  runtimeHost: () => SmartAppRuntimeHost | null
  ensureWorkbenchRuntime?: () => Promise<void>
}

export class SmartAppManager {
  private readonly proxyTokens = new Map<string, string>()
  private readonly contextTokens = new Map<string, string>()
  private operation = Promise.resolve()

  constructor(private readonly options: SmartAppManagerOptions) {}

  async list(): Promise<SmartAppInstallation[]> {
    return this.serial(async () => {
      const installations = await this.readRegistry()
      const running = this.options.runtimeHost()?.runningTabIds() ?? new Set()
      let changed = false
      for (const installation of installations) {
        if (!installation.source) {
          installation.source = installation.smartAppId == null ? 'managed' : 'market'
          changed = true
        }
        if (installation.source === 'linked') {
          changed = (await refreshLinkedInstallation(installation)) || changed
        }
        const active = running.has(tabId(installation.id))
        const state = active ? 'running' : installation.state === 'failed' ? 'failed' : 'installed'
        if (
          installation.state !== state ||
          (!active && installation.webUrl !== null && state !== 'failed')
        ) {
          installation.state = state
          installation.webUrl = active ? installation.webUrl : null
          if (state !== 'failed') installation.error = null
          changed = true
        }
      }
      if (changed) await this.writeRegistry(installations)
      return installations
    })
  }

  async preview(archivePath: string): Promise<SmartAppPreview> {
    const absolutePath = resolve(archivePath)
    const sha256 = await fileSha256(absolutePath)
    const staging = join(this.root(), `.preview-${process.pid}-${Date.now()}`)
    try {
      await extractArchive(absolutePath, staging)
      const manifest = await readManifest(staging)
      validateManifest(manifest)
      return {
        valid: true,
        archivePath: absolutePath,
        sha256,
        manifest,
        issues: [],
      }
    } catch (error) {
      return {
        valid: false,
        archivePath: absolutePath,
        sha256,
        manifest: null,
        issues: [error instanceof Error ? error.message : String(error)],
      }
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  async createDirectory(input: {
    parentPath: string
    name: string
    displayName: string
    description: string
  }): Promise<SmartAppInstallation> {
    return this.serial(async () => {
      const name = validEditableName(input.name)
      const displayName = requiredText(input.displayName)
      const parent = await requiredDirectory(input.parentPath, 'Smart app parent')
      const target = join(parent, name)
      await mkdir(target).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error('Smart app destination already exists')
        }
        throw error
      })
      try {
        await scaffoldWebSmartApp(
          target,
          name,
          displayName,
          input.description.trim(),
          WORKBENCH_DSH_VERSION
        )
        return await this.registerLinkedDirectory(target)
      } catch (error) {
        await rm(target, { recursive: true, force: true })
        throw error
      }
    })
  }

  async linkDirectory(directoryPath: string): Promise<SmartAppInstallation> {
    return this.serial(() => this.registerLinkedDirectory(directoryPath))
  }

  async copyToDirectory(
    installationId: string,
    input: { parentPath: string; name: string; displayName: string }
  ): Promise<SmartAppInstallation> {
    return this.serial(async () => {
      const installations = await this.readRegistry()
      const source = requiredInstallation(installations, installationId)
      if (source.source !== 'market' && source.smartAppId == null) {
        throw new Error('Only marketplace Smart apps need to be copied before editing')
      }
      const name = validEditableName(input.name)
      const parent = await requiredDirectory(input.parentPath, 'Smart app parent')
      const target = join(parent, name)
      await mkdir(target).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error('Smart app destination already exists')
        }
        throw error
      })
      try {
        await copyDirectorySafe(source.packagePath, target)
        const manifestPath = join(target, 'plugin-manifest.json')
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as WorkbenchAppManifest
        manifest.name = name
        manifest.displayName = requiredText(input.displayName)
        manifest.version = '0.1.0'
        await writeJson(manifestPath, manifest)
        return await this.registerLinkedDirectory(target)
      } catch (error) {
        await rm(target, { recursive: true, force: true })
        throw error
      }
    })
  }

  async addPlugin(installationId: string, pluginSpec: string): Promise<SmartAppInstallation> {
    return this.serial(async () => {
      const spec = pluginSpec.trim()
      if (!spec || spec.startsWith('-') || spec.length > 2048) {
        throw new Error('Enter a valid DSH plugin package, URL, or directory')
      }
      const installations = await this.readRegistry()
      const installation = requiredInstallation(installations, installationId)
      if (installation.source === 'market') {
        throw new Error('Copy the marketplace Smart app before editing its plugins')
      }
      if (this.options.runtimeHost()?.runningTabIds().has(tabId(installationId))) {
        throw new Error('Stop the Smart app before adding a DSH plugin')
      }
      const packageRoot = await requiredDirectory(installation.packagePath, 'Smart app package')
      const manifestPath = join(packageRoot, 'plugin-manifest.json')
      const originalManifest = await readFile(manifestPath)
      const manifest = JSON.parse(originalManifest.toString('utf8')) as WorkbenchAppManifest
      const localDirectory = await optionalDirectory(spec)
      let copiedDirectory: string | null = null
      const plugin: { spec: string; path?: string } = localDirectory
        ? await localPluginDescriptor(localDirectory, packageRoot)
        : { spec }
      manifest.plugins ??= []
      if (manifest.plugins.some(existing => existing.spec === plugin.spec)) {
        throw new Error('This DSH plugin is already included')
      }
      manifest.plugins.push(plugin)
      try {
        if (localDirectory && plugin.path) {
          copiedDirectory = join(packageRoot, plugin.path)
          await copyDirectorySafe(localDirectory, copiedDirectory)
        }
        await writeJson(manifestPath, manifest)
        const refreshed = await validatePackageDirectory(packageRoot)
        installation.manifest = refreshed.manifest
        installation.sha256 = refreshed.sha256
        installation.error = null
        await this.writeRegistry(installations)
        return installation
      } catch (error) {
        await writeFile(manifestPath, originalManifest)
        if (copiedDirectory) await rm(copiedDirectory, { recursive: true, force: true })
        throw error
      }
    })
  }

  async download(input: {
    downloadUrl: string
    sha256: string
    sizeBytes: number
    smartAppId: number
    releaseId: number
  }): Promise<SmartAppPreview> {
    const url = new URL(input.downloadUrl)
    if (!isSecureTransferUrl(url)) {
      throw new Error('Smart app download must use HTTPS')
    }
    if (
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes <= 0 ||
      input.sizeBytes > MAX_ARCHIVE_BYTES
    ) {
      throw new Error('Smart app download size is invalid')
    }
    const directory = join(this.root(), 'downloads')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(
      directory,
      `market-${input.smartAppId}-${input.releaseId}-${input.sha256}.zip`
    )
    const response = await fetch(url)
    if (!response.ok || !response.body) {
      throw new Error(`Smart app download failed with HTTP ${response.status}`)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength !== input.sizeBytes) {
      throw new Error('Smart app download size does not match its descriptor')
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (sha256 !== input.sha256.toLowerCase()) {
      throw new Error('Smart app download checksum does not match its descriptor')
    }
    await writeFile(path, bytes, { mode: 0o600 })
    return this.preview(path)
  }

  async install(input: {
    archivePath: string
    expectedSha256: string
    modelKey?: string | null
    smartAppId?: number | null
    releaseId?: number | null
  }): Promise<SmartAppInstallation> {
    return this.serial(async () => {
      const preview = await this.preview(input.archivePath)
      if (!preview.valid || !preview.manifest) {
        throw new Error(preview.issues.join('\n') || 'Smart app package is invalid')
      }
      if (preview.sha256 !== input.expectedSha256.toLowerCase()) {
        throw new Error('Smart app package changed after preview')
      }
      const id =
        input.smartAppId === null || input.smartAppId === undefined
          ? preview.manifest.name
          : `market-${input.smartAppId}`
      const target = join(this.root(), 'packages', safeName(id), preview.manifest.version)
      const staging = join(this.root(), `.install-${process.pid}-${Date.now()}`)
      await extractArchive(preview.archivePath, staging)
      const packageRoot = await manifestRoot(staging)
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      if (await exists(target)) {
        await rm(staging, { recursive: true, force: true })
      } else {
        await rename(packageRoot, target)
        await rm(staging, { recursive: true, force: true })
      }
      const installations = await this.readRegistry()
      const previous = installations.find(item => item.id === id)
      const installation: SmartAppInstallation = {
        id,
        manifest: preview.manifest,
        packagePath: target,
        sha256: preview.sha256,
        modelKey: normalizedOptional(input.modelKey) ?? previous?.modelKey ?? null,
        resident: previous?.resident ?? false,
        runtimeVersion: null,
        state: 'installed',
        webUrl: null,
        error: null,
        smartAppId: input.smartAppId ?? null,
        releaseId: input.releaseId ?? null,
        source: input.smartAppId == null ? 'managed' : 'market',
      }
      await this.writeRegistry([...installations.filter(item => item.id !== id), installation])
      return installation
    })
  }

  async start(input: {
    installationId: string
    modelBaseUrl?: string | null
    contextBaseUrl?: string | null
    contextToken?: string | null
  }): Promise<SmartAppInstallation> {
    return this.serial(async () => {
      const runtimeHost = this.requiredRuntimeHost()
      const installations = await this.readRegistry()
      const installation = requiredInstallation(installations, input.installationId)
      const id = tabId(installation.id)
      if (runtimeHost.runningTabIds().has(id)) {
        return installation
      }
      const port = await freePort()
      try {
        await this.options.ensureWorkbenchRuntime?.()
        const prepared = await prepareWorkbenchDshLaunch({
          runtimeRoot: this.options.runtimeRoot,
          dataDirectory: this.options.dataDirectory,
          installationId: installation.id,
          packagePath: installation.packagePath,
          manifest: installation.manifest,
          environment: this.options.environment,
          port,
          modelBaseUrl: input.modelBaseUrl,
          contextBaseUrl: input.contextBaseUrl,
          contextToken: input.contextToken,
        })
        await runtimeHost.open({
          tabId: id,
          url: prepared.url,
          command: prepared.command,
          args: prepared.args,
          cwd: prepared.cwd,
          environment: prepared.environment,
          logDirectory: this.options.logDirectory,
        })
        installation.state = 'running'
        installation.webUrl = prepared.url
        installation.runtimeVersion = prepared.version
        installation.error = null
        await this.writeRegistry(installations)
        return installation
      } catch (error) {
        installation.state = 'failed'
        installation.webUrl = null
        installation.error = error instanceof Error ? error.message : String(error)
        await this.writeRegistry(installations)
        throw error
      }
    })
  }

  async stop(installationId: string): Promise<void> {
    return this.serial(async () => {
      await this.options.runtimeHost()?.close(tabId(installationId))
      const installations = await this.readRegistry()
      const installation = installations.find(item => item.id === installationId)
      if (!installation) return
      installation.state = 'installed'
      installation.webUrl = null
      installation.error = null
      await this.writeRegistry(installations)
    })
  }

  async update(
    installationId: string,
    updates: { modelKey?: string; resident?: boolean }
  ): Promise<SmartAppInstallation> {
    return this.serial(async () => {
      const installations = await this.readRegistry()
      const installation = requiredInstallation(installations, installationId)
      if (
        updates.modelKey !== undefined &&
        this.options.runtimeHost()?.runningTabIds().has(tabId(installationId))
      ) {
        throw new Error('Stop the Smart app before changing its model')
      }
      if (updates.modelKey !== undefined) {
        const modelKey = normalizedOptional(updates.modelKey)
        if (!modelKey) throw new Error('Smart app model cannot be empty')
        installation.modelKey = modelKey
      }
      if (updates.resident !== undefined) installation.resident = updates.resident
      await this.writeRegistry(installations)
      return installation
    })
  }

  async delete(installationId: string, deleteData: boolean): Promise<void> {
    await this.stop(installationId)
    return this.serial(async () => {
      const installations = await this.readRegistry()
      const installation = requiredInstallation(installations, installationId)
      await this.writeRegistry(installations.filter(item => item.id !== installationId))
      if (installation.source !== 'linked') {
        await rm(dirname(installation.packagePath), { recursive: true, force: true })
      }
      if (deleteData) {
        await rm(join(this.root(), 'instances', safeName(installationId)), {
          recursive: true,
          force: true,
        })
      }
      this.proxyTokens.delete(installationId)
      this.contextTokens.delete(installationId)
    })
  }

  async export(installationId: string): Promise<SmartAppExport> {
    const installation = requiredInstallation(await this.readRegistry(), installationId)
    const directory = join(this.root(), 'exports')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const archivePath = join(
      directory,
      `${safeName(installation.manifest.name)}-${installation.manifest.version}.zip`
    )
    await archiveDirectory(installation.packagePath, archivePath)
    const metadata = await stat(archivePath)
    return {
      archivePath,
      sha256: await fileSha256(archivePath),
      sizeBytes: metadata.size,
      manifest: installation.manifest,
    }
  }

  async exportToDownloads(installationId: string): Promise<SmartAppSavedExport> {
    const exported = await this.export(installationId)
    await mkdir(this.options.downloadsDirectory, { recursive: true })
    const filename = `${safeName(exported.manifest.name)}-${exported.manifest.version}.zip`
    const destinationPath = await uniquePath(this.options.downloadsDirectory, filename)
    await copyFile(exported.archivePath, destinationPath)
    return { ...exported, destinationPath }
  }

  async upload(archivePath: string, uploadUrl: string): Promise<void> {
    const url = new URL(uploadUrl)
    if (!isSecureTransferUrl(url)) throw new Error('Smart app upload must use HTTPS')
    const bytes = await readFile(resolve(archivePath))
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/zip' },
      body: bytes,
    })
    if (!response.ok) throw new Error(`Smart app upload failed with HTTP ${response.status}`)
  }

  storeProxyToken(installationId: string, token: string): void {
    this.proxyTokens.set(requiredText(installationId), requiredText(token))
  }

  takeProxyToken(installationId: string): string | null {
    return takeToken(this.proxyTokens, installationId)
  }

  storeContextToken(installationId: string, token: string): void {
    this.contextTokens.set(requiredText(installationId), requiredText(token))
  }

  takeContextToken(installationId: string): string | null {
    return takeToken(this.contextTokens, installationId)
  }

  private root(): string {
    return join(this.options.dataDirectory, 'harness-apps')
  }

  private registryPath(): string {
    return join(this.root(), 'installations.json')
  }

  private async readRegistry(): Promise<SmartAppInstallation[]> {
    try {
      return JSON.parse(await readFile(this.registryPath(), 'utf8')) as SmartAppInstallation[]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private async writeRegistry(installations: SmartAppInstallation[]): Promise<void> {
    const path = this.registryPath()
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(installations, null, 2)}\n`, {
      mode: 0o600,
    })
    await rename(temporary, path)
  }

  private requiredRuntimeHost(): SmartAppRuntimeHost {
    const host = this.options.runtimeHost()
    if (!host) throw new Error('Smart app runtime host is unavailable')
    return host
  }

  private async registerLinkedDirectory(directoryPath: string): Promise<SmartAppInstallation> {
    const validated = await validatePackageDirectory(directoryPath)
    const installations = await this.readRegistry()
    if (installations.some(item => item.id === validated.manifest.name)) {
      throw new Error(`A Smart app named ${validated.manifest.name} is already registered`)
    }
    const installation: SmartAppInstallation = {
      id: validated.manifest.name,
      manifest: validated.manifest,
      packagePath: validated.path,
      sha256: validated.sha256,
      modelKey: null,
      resident: false,
      runtimeVersion: null,
      state: 'installed',
      webUrl: null,
      error: null,
      smartAppId: null,
      releaseId: null,
      source: 'linked',
    }
    await this.writeRegistry([...installations, installation])
    return installation
  }

  private serial<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.operation.then(operation, operation)
    this.operation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

async function validatePackageDirectory(directoryPath: string): Promise<{
  path: string
  manifest: WorkbenchAppManifest
  sha256: string
}> {
  const path = await requiredDirectory(directoryPath, 'Smart app package')
  const manifest = JSON.parse(
    await readFile(join(path, 'plugin-manifest.json'), 'utf8')
  ) as WorkbenchAppManifest
  validateManifest(manifest)
  const files: string[] = []
  await walk(path, async filePath => {
    files.push(filePath)
  })
  files.sort()
  const hash = createHash('sha256')
  let totalBytes = 0
  for (const filePath of files) {
    const bytes = await readFile(filePath)
    totalBytes += bytes.byteLength
    if (totalBytes > MAX_EXTRACTED_BYTES) {
      throw new Error('Smart app directory exceeds 250 MB')
    }
    hash.update(
      filePath
        .slice(path.length + 1)
        .split(sep)
        .join('/')
    )
    hash.update('\0')
    hash.update(bytes)
  }
  return { path, manifest, sha256: hash.digest('hex') }
}

async function refreshLinkedInstallation(installation: SmartAppInstallation): Promise<boolean> {
  try {
    const validated = await validatePackageDirectory(installation.packagePath)
    if (validated.manifest.name !== installation.id) {
      return setInstallationFailure(
        installation,
        'Linked Smart app name changed; remove and link the folder again'
      )
    }
    const changed =
      installation.manifest.name !== validated.manifest.name ||
      installation.manifest.version !== validated.manifest.version ||
      installation.sha256 !== validated.sha256 ||
      installation.error !== null
    installation.manifest = validated.manifest
    installation.sha256 = validated.sha256
    installation.error = null
    if (installation.state === 'failed') installation.state = 'installed'
    return changed
  } catch (error) {
    return setInstallationFailure(
      installation,
      error instanceof Error ? error.message : String(error)
    )
  }
}

function setInstallationFailure(installation: SmartAppInstallation, error: string): boolean {
  const changed = installation.state !== 'failed' || installation.error !== error
  installation.state = 'failed'
  installation.webUrl = null
  installation.error = error
  return changed
}

async function scaffoldWebSmartApp(
  path: string,
  name: string,
  displayName: string,
  description: string,
  dshVersion: string
): Promise<void> {
  const bundle = join(path, 'packages', 'bundle', name)
  await mkdir(join(bundle, 'src'), { recursive: true, mode: 0o700 })
  const manifest: WorkbenchAppManifest = {
    name,
    displayName,
    version: '0.1.0',
    type: 'deepseek-harness-plugin-bundle',
    description,
    packages: [
      {
        name: `@wework-smart-app/${name}`,
        role: 'profile-bundle',
        path: `packages/bundle/${name}`,
      },
    ],
    entry: {
      installPackage: `packages/bundle/${name}`,
      profile: 'web',
    },
    requirements: {
      dsh: dshVersion,
      node: '>=22',
    },
    plugins: [],
  }
  await writeJson(join(path, 'plugin-manifest.json'), manifest)
  await writeJson(join(bundle, 'package.json'), {
    name: `@wework-smart-app/${name}`,
    version: '0.1.0',
    private: true,
    type: 'module',
    files: ['cordis.patch.yml', 'src'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  await writeFile(join(bundle, 'cordis.patch.yml'), '[]\n')
  await writeFile(
    join(bundle, 'src', 'index.ts'),
    "export const smartApp = { preset: 'web' as const }\n"
  )
  await writeFile(
    join(path, 'PLUGIN.md'),
    `# ${displayName}\n\n${description}\n\nThis Smart app uses the DeepSeek Harness Web preset.\n`
  )
  await writeFile(
    join(path, 'INSTALL.zh-CN.md'),
    '# 安装\n\n可在 Wework 中直接关联此目录运行，或导出 ZIP 后安装。\n'
  )
}

async function localPluginDescriptor(
  source: string,
  packageRoot: string
): Promise<{ spec: string; path: string }> {
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as {
    name?: unknown
    dsh?: { bundle?: { patch?: unknown } }
  }
  const name = typeof manifest.name === 'string' ? manifest.name.trim() : ''
  if (!name) throw new Error('DSH plugin package has no name')
  const patch =
    typeof manifest.dsh?.bundle?.patch === 'string' ? manifest.dsh.bundle.patch.trim() : ''
  if (!safeRelative(patch) || !(await exists(join(source, patch)))) {
    throw new Error('Selected package does not declare a valid dsh.bundle.patch')
  }
  const directoryName = name.replace(/[^0-9A-Za-z_-]/g, '-').replace(/^-+|-+$/g, '')
  if (!directoryName) throw new Error('DSH plugin package name cannot be used as a directory')
  const relativePath = join('plugins', directoryName)
  if (await exists(join(packageRoot, relativePath))) {
    throw new Error('This local DSH plugin is already included')
  }
  const path = relativePath.split(sep).join('/')
  return { spec: `file:${path}`, path }
}

async function copyDirectorySafe(sourcePath: string, destinationPath: string): Promise<void> {
  const source = await requiredDirectory(sourcePath, 'Source')
  await mkdir(destinationPath, { recursive: true, mode: 0o700 })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error('Smart app package contains a symbolic link')
    }
    const sourceEntry = join(source, entry.name)
    const destinationEntry = join(destinationPath, entry.name)
    if (entry.isDirectory()) {
      await copyDirectorySafe(sourceEntry, destinationEntry)
    } else if (entry.isFile()) {
      await cp(sourceEntry, destinationEntry)
    }
  }
}

async function requiredDirectory(path: string, label: string): Promise<string> {
  const resolved = await realpath(requiredText(path)).catch(error => {
    throw new Error(`Failed to resolve ${label} directory: ${String(error)}`)
  })
  if (!(await stat(resolved)).isDirectory()) throw new Error(`${label} path must be a directory`)
  return resolved
}

async function optionalDirectory(path: string): Promise<string | null> {
  try {
    const resolved = await realpath(path)
    return (await stat(resolved)).isDirectory() ? resolved : null
  } catch {
    return null
  }
}

function validEditableName(value: string): string {
  const name = value.trim()
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error('Smart app name must use lowercase letters, numbers, and hyphens')
  }
  return name
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function isSecureTransferUrl(url: URL): boolean {
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
}

async function extractArchive(archivePath: string, destination: string): Promise<void> {
  const metadata = await stat(archivePath)
  if (metadata.size > MAX_ARCHIVE_BYTES) throw new Error('Smart app ZIP exceeds 50 MB')
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true, mode: 0o700 })
  let extractedBytes = 0
  await extractZip(archivePath, {
    dir: destination,
    onEntry: entry => {
      extractedBytes += entry.uncompressedSize
      if (extractedBytes > MAX_EXTRACTED_BYTES) {
        throw new Error('Smart app ZIP expands beyond 250 MB')
      }
    },
  })
}

async function readManifest(root: string): Promise<WorkbenchAppManifest> {
  const path = join(await manifestRoot(root), 'plugin-manifest.json')
  return JSON.parse(await readFile(path, 'utf8')) as WorkbenchAppManifest
}

async function manifestRoot(root: string): Promise<string> {
  const matches: string[] = []
  await walk(root, async path => {
    if (basename(path) === 'plugin-manifest.json') matches.push(dirname(path))
  })
  if (matches.length !== 1) {
    throw new Error(
      matches.length
        ? 'Smart app ZIP contains multiple plugin-manifest.json files'
        : 'plugin-manifest.json is missing'
    )
  }
  return matches[0] as string
}

async function walk(root: string, visit: (path: string) => Promise<void>): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) throw new Error('Smart app package contains a symbolic link')
    if (entry.isDirectory()) await walk(path, visit)
    else if (entry.isFile()) await visit(path)
  }
}

function validateManifest(manifest: WorkbenchAppManifest): void {
  if (manifest.type !== 'deepseek-harness-plugin-bundle') {
    throw new Error('Unsupported Smart app package type')
  }
  if (!semver.valid(manifest.version)) throw new Error('Smart app version is invalid')
  if (
    !manifest.name?.trim() ||
    !/^[0-9A-Za-z_-]+$/.test(manifest.name) ||
    !manifest.entry?.profile?.trim() ||
    !safeRelative(manifest.entry.installPackage)
  ) {
    throw new Error('Smart app manifest has incomplete identity or entry fields')
  }
  if (
    !manifest.requirements?.dsh ||
    !semver.validRange(manifest.requirements.dsh, { includePrerelease: true }) ||
    !manifest.requirements.node ||
    !semver.validRange(manifest.requirements.node, { includePrerelease: true })
  ) {
    throw new Error('Smart app runtime requirements are invalid')
  }
  const packages = manifest.packages ?? []
  const names = new Set<string>()
  const paths = new Set<string>()
  const profileBundles: string[] = []
  for (const item of packages) {
    if (
      !item.name?.trim() ||
      !item.role?.trim() ||
      !safeRelative(item.path) ||
      names.has(item.name) ||
      paths.has(item.path)
    ) {
      throw new Error('Smart app package declaration is invalid')
    }
    names.add(item.name)
    paths.add(item.path)
    if (item.role === 'profile-bundle') profileBundles.push(item.path)
  }
  if (
    packages.length &&
    (profileBundles.length !== 1 || profileBundles[0] !== manifest.entry.installPackage)
  ) {
    throw new Error('Smart app must declare installPackage as its only profile-bundle')
  }
  const pluginSpecs = new Set<string>()
  for (const plugin of manifest.plugins ?? []) {
    const spec = plugin.spec?.trim()
    if (!spec || spec.startsWith('-') || pluginSpecs.has(spec)) {
      throw new Error('Smart app plugin declaration is invalid')
    }
    if (plugin.path && (!safeRelative(plugin.path) || spec !== `file:${plugin.path}`)) {
      throw new Error('Smart app local plugin declaration is invalid')
    }
    pluginSpecs.add(spec)
  }
}

async function fileSha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

async function archiveDirectory(source: string, destination: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const output = createWriteStream(destination, { mode: 0o600 })
    const archive = new ZipArchive({ zlib: { level: 9 } })
    output.once('close', resolvePromise)
    output.once('error', reject)
    archive.once('error', reject)
    archive.pipe(output)
    archive.directory(source, false)
    void archive.finalize()
  })
}

function requiredInstallation(
  installations: SmartAppInstallation[],
  installationId: string
): SmartAppInstallation {
  const installation = installations.find(item => item.id === installationId)
  if (!installation) throw new Error('Smart app installation is missing')
  return installation
}

function tabId(installationId: string): string {
  return `smart-app:${requiredText(installationId)}`
}

function safeName(value: string): string {
  const safe = requiredText(value)
    .replace(/[^0-9A-Za-z.-]/g, '-')
    .slice(0, 80)
  if (!safe) throw new Error('Smart app identifier is invalid')
  return safe
}

function safeRelative(value: string): boolean {
  const path = value?.trim()
  if (!path || isAbsolute(path)) return false
  const normalized = normalize(path)
  return (
    normalized !== '.' &&
    normalized !== '..' &&
    !normalized.startsWith(`..${sep}`) &&
    !normalized.includes('\0')
  )
}

function requiredText(value: string): string {
  const text = value?.trim()
  if (!text) throw new Error('Required Smart app value is missing')
  return text
}

function normalizedOptional(value: string | null | undefined): string | null {
  const text = value?.trim()
  return text || null
}

function takeToken(tokens: Map<string, string>, installationId: string): string | null {
  const id = requiredText(installationId)
  const token = tokens.get(id) ?? null
  tokens.delete(id)
  return token
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function uniquePath(directory: string, filename: string): Promise<string> {
  const path = join(directory, filename)
  if (!(await exists(path))) return path
  const extension = '.zip'
  const stem = filename.endsWith(extension) ? filename.slice(0, -extension.length) : filename
  for (let index = 1; index < 1000; index += 1) {
    const candidate = join(directory, `${stem} (${index})${extension}`)
    if (!(await exists(candidate))) return candidate
  }
  throw new Error('Downloads directory has too many Smart app exports with the same name')
}

function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Failed to allocate a Smart app port'))
        return
      }
      server.close(error => {
        if (error) reject(error)
        else resolvePromise(address.port)
      })
    })
  })
}
