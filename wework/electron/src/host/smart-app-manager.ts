import { ZipArchive } from 'archiver'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve, sep } from 'node:path'
import type { WorkbenchRuntimeLaunch } from '../runtime/workbench-runtime.js'
import {
  prepareWorkbenchDshLaunch,
  WORKBENCH_DSH_VERSION,
  type WorkbenchAppManifest,
} from '../runtime/workbench-dsh-runtime.js'
import {
  copySmartAppDirectorySafe,
  extractSmartAppArchive,
  findSmartAppManifestRoot,
  isSafeSmartAppRelativePath,
  MAX_SMART_APP_ARCHIVE_BYTES,
  requiredSmartAppDirectory,
  validateSmartAppPackageDirectory,
} from './smart-app-package-validator.js'
import {
  scaffoldSmartApp,
  SMART_APP_TEMPLATES,
  type SmartAppTemplate,
} from './smart-app-scaffold.js'
import { SmartAppVerifier, type SmartAppPackResult } from './smart-app-verifier.js'
import type { SmartAppVerificationReport } from './smart-app-verification-types.js'

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
  verificationService?: SmartAppVerificationService
}

export interface SmartAppVerificationService {
  verify(projectRoot: string): Promise<SmartAppVerificationReport>
  inspect(projectRoot: string): Promise<SmartAppVerificationReport | null>
  pack(projectRoot: string, archivePath: string): Promise<SmartAppPackResult>
}

export class SmartAppManager {
  private readonly proxyTokens = new Map<string, string>()
  private readonly contextTokens = new Map<string, string>()
  private readonly verificationService: SmartAppVerificationService
  private operation = Promise.resolve()

  constructor(private readonly options: SmartAppManagerOptions) {
    this.verificationService =
      options.verificationService ??
      new SmartAppVerifier({
        runtimeRoot: options.runtimeRoot,
        environment: options.environment,
      })
  }

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
      await extractSmartAppArchive(absolutePath, staging)
      const packageRoot = await findSmartAppManifestRoot(staging)
      const { manifest } = await validateSmartAppPackageDirectory(packageRoot)
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
    template: string
  }): Promise<SmartAppInstallation> {
    return this.serial(async () => {
      const name = validEditableName(input.name)
      const displayName = requiredText(input.displayName)
      const template = validSmartAppTemplate(input.template)
      const parent = await requiredSmartAppDirectory(input.parentPath, 'Smart app parent')
      const target = join(parent, name)
      await mkdir(target).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error('Smart app destination already exists')
        }
        throw error
      })
      try {
        await scaffoldSmartApp({
          path: target,
          name,
          displayName,
          description: input.description.trim(),
          dshVersion: WORKBENCH_DSH_VERSION,
          template,
        })
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
      const parent = await requiredSmartAppDirectory(input.parentPath, 'Smart app parent')
      const target = join(parent, name)
      await mkdir(target).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error('Smart app destination already exists')
        }
        throw error
      })
      try {
        await copySmartAppDirectorySafe(source.packagePath, target)
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
      const packageRoot = await requiredSmartAppDirectory(
        installation.packagePath,
        'Smart app package'
      )
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
          await copySmartAppDirectorySafe(localDirectory, copiedDirectory)
        }
        await writeJson(manifestPath, manifest)
        const refreshed = await validateLinkedSmartAppDirectory(packageRoot)
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
      input.sizeBytes > MAX_SMART_APP_ARCHIVE_BYTES
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
      await extractSmartAppArchive(preview.archivePath, staging)
      const packageRoot = await findSmartAppManifestRoot(staging)
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
    if (installation.source === 'linked') {
      const packed = await this.verificationService.pack(installation.packagePath, archivePath)
      return {
        archivePath: packed.archivePath,
        sha256: packed.sha256,
        sizeBytes: packed.sizeBytes,
        manifest: packed.manifest,
      }
    }
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

  async verify(installationId: string): Promise<SmartAppVerificationReport> {
    const installation = requiredLinkedInstallation(await this.readRegistry(), installationId)
    return this.verificationService.verify(installation.packagePath)
  }

  async inspectVerification(installationId: string): Promise<SmartAppVerificationReport | null> {
    const installation = requiredLinkedInstallation(await this.readRegistry(), installationId)
    return this.verificationService.inspect(installation.packagePath)
  }

  async verifyProject(projectRoot: string): Promise<SmartAppVerificationReport> {
    const installation = await this.linkedInstallationByProject(projectRoot)
    return this.verificationService.verify(installation.packagePath)
  }

  async inspectProject(projectRoot: string): Promise<SmartAppVerificationReport | null> {
    const installation = await this.linkedInstallationByProject(projectRoot)
    return this.verificationService.inspect(installation.packagePath)
  }

  async packProject(projectRoot: string, outputPath: string): Promise<SmartAppPackResult> {
    const installation = await this.linkedInstallationByProject(projectRoot)
    return this.verificationService.pack(installation.packagePath, outputPath)
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

  private async linkedInstallationByProject(projectRoot: string): Promise<SmartAppInstallation> {
    const root = await requiredSmartAppDirectory(projectRoot, 'Smart app project')
    const installation = (await this.readRegistry()).find(
      item => item.source === 'linked' && item.packagePath === root
    )
    if (!installation) throw new Error('Smart app project is not a linked project root')
    return installation
  }

  private async registerLinkedDirectory(directoryPath: string): Promise<SmartAppInstallation> {
    const validated = await validateLinkedSmartAppDirectory(directoryPath)
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

async function refreshLinkedInstallation(installation: SmartAppInstallation): Promise<boolean> {
  try {
    const validated = await validateLinkedSmartAppDirectory(installation.packagePath)
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

function validateLinkedSmartAppDirectory(directoryPath: string) {
  return validateSmartAppPackageDirectory(directoryPath, { developmentSource: true })
}

function setInstallationFailure(installation: SmartAppInstallation, error: string): boolean {
  const changed = installation.state !== 'failed' || installation.error !== error
  installation.state = 'failed'
  installation.webUrl = null
  installation.error = error
  return changed
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
  if (!isSafeSmartAppRelativePath(patch) || !(await exists(join(source, patch)))) {
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

function validSmartAppTemplate(value: string): SmartAppTemplate {
  if (SMART_APP_TEMPLATES.includes(value as SmartAppTemplate)) return value as SmartAppTemplate
  throw new Error('Smart app template is invalid')
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function isSecureTransferUrl(url: URL): boolean {
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
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

function requiredLinkedInstallation(
  installations: SmartAppInstallation[],
  installationId: string
): SmartAppInstallation {
  const installation = requiredInstallation(installations, installationId)
  if (installation.source !== 'linked') {
    throw new Error('Smart app verification is only available for linked projects')
  }
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
