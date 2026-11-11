import {
  rejectOversizedPublishArchive,
  optionalDirectory,
  isDirectoryPermissionError,
  writeJson,
  isSecureTransferUrl,
  fileSha256,
  archiveDirectory,
  exists,
  uniquePath,
  localPluginDescriptor,
} from './smart-app-package-io.js'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type {
  WorkbenchRuntimeLaunch,
  WorkbenchRuntimeSnapshot,
} from '../runtime/workbench-runtime.js'
import { cloudFetch } from './cloud-http.js'
import {
  materializeManifestPackages,
  prepareWorkbenchDshLaunch,
  WORKBENCH_DSH_VERSION,
  type WorkbenchAppManifest,
} from '../runtime/workbench-dsh-runtime.js'
import {
  copySmartAppDirectorySafe,
  extractSmartAppArchive,
  findSmartAppManifestRoot,
  MAX_SMART_APP_ARCHIVE_BYTES,
  readSmartAppManifest,
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
import { ensureDirectory } from './ensure-directory.js'
import { decideDecisionModelGrant } from './smart-app-capability-policy.js'

export interface SmartAppInstallation {
  id: string
  manifest: WorkbenchAppManifest
  packagePath: string
  sha256: string
  modelKey: string | null
  resident: boolean
  background?: boolean
  presentation?: 'window' | 'tab'
  shortcut?: string | null
  runtimeVersion: string | null
  state: 'installed' | 'running' | 'failed'
  webUrl: string | null
  error: string | null
  smartAppId?: number | null
  releaseId?: number | null
  source: 'managed' | 'linked' | 'market'
  /** False until a newly linked project passes native installation confirmation. */
  authorized?: boolean
  /**
   * Capabilities Wework has authorized for this installation. Declaring the
   * capability in the manifest is the whole contract: install provenance
   * (managed / linked / market) does not gate it.
   */
  grantedCapabilities: {
    decisionModel: boolean
    native?: string[]
  }
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
  open(launch: WorkbenchRuntimeLaunch): Promise<WorkbenchRuntimeSnapshot>
  close(tabId: string): Promise<void>
  runningTabIds(): ReadonlySet<string>
}

export interface SmartAppManagerOptions {
  dataDirectory: string
  documentsDirectory: () => string
  downloadsDirectory: () => string
  logDirectory: string
  runtimeRoot: string
  environment: NodeJS.ProcessEnv
  runtimeHost: () => SmartAppRuntimeHost | null
  verificationService?: SmartAppVerificationService
}

export interface SmartAppVerificationService {
  verify(projectRoot: string): Promise<SmartAppVerificationReport>
  inspect(projectRoot: string): Promise<SmartAppVerificationReport | null>
  pack(projectRoot: string, archivePath: string): Promise<SmartAppPackResult>
}

import { authorizeDecisionRoute, validateAdditionalModelRoute } from './smart-app-runtime-routes.js'

export class SmartAppManager {
  private readonly startingVersions = new Map<string, number>()
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
        changed = this.syncGrantedCapabilities(installation) || changed
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
      const stagedManifest = await readSmartAppManifest(packageRoot)
      await materializeManifestPackages(stagedManifest, packageRoot)
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
    flavor?: 'lightweight' | 'extended'
  }): Promise<SmartAppInstallation> {
    return this.serial(async () => {
      const name = validEditableName(input.name)
      const displayName = requiredText(input.displayName)
      const template = validSmartAppTemplate(input.template)
      const parent = input.parentPath.trim()
        ? await requiredSmartAppDirectory(input.parentPath, 'Smart app parent')
        : await this.defaultCreationParent()
      const target = join(parent, name)
      await mkdir(target).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error('Smart app destination already exists')
        }
        if (isDirectoryPermissionError(error)) {
          throw new Error('Smart app save location is not writable', { cause: error })
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
          flavor: input.flavor,
        })
        return await this.registerLinkedDirectory(target)
      } catch (error) {
        await rm(target, { recursive: true, force: true })
        throw error
      }
    })
  }

  private async defaultCreationParent(): Promise<string> {
    try {
      const parent = join(this.options.documentsDirectory(), 'WeworkSmartApps')
      await mkdir(parent, { recursive: true, mode: 0o700 })
      return await requiredSmartAppDirectory(parent, 'Smart app default parent')
    } catch (error) {
      throw new Error('Smart app default save location is unavailable', { cause: error })
    }
  }

  async linkDirectory(directoryPath: string): Promise<SmartAppInstallation> {
    return this.serial(() => this.registerLinkedDirectory(directoryPath))
  }

  async get(installationId: string): Promise<SmartAppInstallation> {
    return requiredInstallation(await this.list(), installationId)
  }

  async scaffold(input: {
    projectPath: string
    name: string
    displayName: string
    flavor: 'lightweight' | 'extended'
  }): Promise<{ projectPath: string }> {
    const target = resolve(input.projectPath)
    await mkdir(target)
    try {
      await scaffoldSmartApp({
        path: target,
        name: validEditableName(input.name),
        displayName: requiredText(input.displayName),
        description: '',
        dshVersion: WORKBENCH_DSH_VERSION,
        template: 'web',
        flavor: input.flavor,
      })
      return { projectPath: target }
    } catch (error) {
      await rm(target, { recursive: true, force: true })
      throw error
    }
  }

  async grantNativeCapabilities(installationId: string, native: string[]): Promise<void> {
    await this.serial(async () => {
      const installations = await this.readRegistry()
      const installation = requiredInstallation(installations, installationId)
      installation.grantedCapabilities = {
        ...installation.grantedCapabilities,
        native: [...native],
      }
      installation.authorized = true
      await this.writeRegistry(installations)
    })
  }

  async installDirectory(
    projectPath: string,
    native: string[],
    previousSha256: string | null,
    shortcut?: string | null
  ): Promise<SmartAppInstallation> {
    const validated = await validateSmartAppPackageDirectory(projectPath)
    return this.serial(async () => {
      const installations = await this.readRegistry()
      const previous = installations.find(item => item.id === validated.manifest.name)
      if ((previous?.sha256 ?? null) !== previousSha256)
        throw new Error('Workbench changed while installation was being confirmed; install again')
      if (this.options.runtimeHost()?.runningTabIds().has(tabId(validated.manifest.name)))
        throw new Error('Stop the workbench before installing a new version')
      const target = join(
        this.root(),
        'packages',
        safeName(validated.manifest.name),
        validated.sha256
      )
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      if (!(await exists(target))) await rename(validated.path, target)
      const installation: SmartAppInstallation = {
        id: validated.manifest.name,
        manifest: validated.manifest,
        packagePath: target,
        sha256: validated.sha256,
        modelKey: previous?.modelKey ?? null,
        resident: previous?.resident ?? false,
        background: previous?.background ?? true,
        presentation: previous?.presentation ?? 'window',
        shortcut: shortcut === undefined ? (previous?.shortcut ?? null) : shortcut,
        runtimeVersion: null,
        state: 'installed',
        webUrl: null,
        error: null,
        source: 'managed',
        authorized: true,
        grantedCapabilities: {
          decisionModel: decideDecisionModelGrant(validated.manifest),
          native: [...native],
        },
      }
      await this.writeRegistry([
        ...installations.filter(item => item.id !== installation.id),
        installation,
      ])
      return installation
    })
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
        this.syncGrantedCapabilities(installation)
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
    const response = await cloudFetch(url)
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
    authorizedNative?: string[]
    expectedPreviousSha256?: string | null
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
      if (this.options.runtimeHost()?.runningTabIds().has(tabId(id))) {
        throw new Error('Stop the Smart app before installing a new version')
      }
      const target = join(this.root(), 'packages', safeName(id), preview.sha256)
      const staging = join(this.root(), `.install-${process.pid}-${Date.now()}`)
      try {
        await extractSmartAppArchive(preview.archivePath, staging)
        const packageRoot = await findSmartAppManifestRoot(staging)
        await materializeManifestPackages(preview.manifest, packageRoot)
        await validateSmartAppPackageDirectory(packageRoot)
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        if (!(await exists(target))) await rename(packageRoot, target)
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
      const installations = await this.readRegistry()
      const previous = installations.find(item => item.id === id)
      if (
        input.expectedPreviousSha256 !== undefined &&
        (previous?.sha256 ?? null) !== input.expectedPreviousSha256
      )
        throw new Error('Workbench changed while installation was being confirmed; install again')
      const installation: SmartAppInstallation = {
        id,
        manifest: preview.manifest,
        packagePath: target,
        sha256: preview.sha256,
        modelKey: normalizedOptional(input.modelKey) ?? previous?.modelKey ?? null,
        resident: previous?.resident ?? false,
        background: previous?.background ?? true,
        presentation: previous?.presentation ?? 'window',
        shortcut: previous?.shortcut ?? null,
        runtimeVersion: null,
        state: 'installed',
        webUrl: null,
        error: null,
        smartAppId: input.smartAppId ?? null,
        releaseId: input.releaseId ?? null,
        source: input.smartAppId == null ? 'managed' : 'market',
        authorized: true,
        grantedCapabilities: { decisionModel: false, native: input.authorizedNative ?? [] },
      }
      this.syncGrantedCapabilities(installation)
      await this.writeRegistry([...installations.filter(item => item.id !== id), installation])
      return installation
    })
  }

  async start(input: {
    installationId: string
    modelBaseUrl?: string | null
    additionalModels?: Array<{ modelKey: string; displayName: string; baseUrl: string }>
    contextBaseUrl?: string | null
    contextToken?: string | null
    decisionBaseUrl?: string | null
    decisionProtocolVersion?: number | null
  }): Promise<SmartAppInstallation> {
    const version = (this.startingVersions.get(input.installationId) ?? 0) + 1
    this.startingVersions.set(input.installationId, version)
    const runtimeHost = this.requiredRuntimeHost()
    const installation = await this.get(input.installationId)
    if (installation.authorized === false)
      throw new Error('Complete native installation confirmation before running this workbench')
    const additionalModels = (input.additionalModels ?? []).map(validateAdditionalModelRoute)
    const modelKeys = additionalModels.map(model => model.modelKey)
    if (new Set(modelKeys).size !== modelKeys.length) {
      throw new Error('Wework model router contains duplicate models')
    }
    if (additionalModels.length && !input.modelBaseUrl?.trim()) {
      throw new Error('Wework model router requires a default model route')
    }
    // The Host owns the lease; validate its URL and manifest grant before launch.
    const decisionRoute = authorizeDecisionRoute(
      installation.manifest,
      input.decisionBaseUrl,
      input.decisionProtocolVersion
    )
    const id = tabId(installation.id)
    if (runtimeHost.runningTabIds().has(id)) {
      return installation
    }
    try {
      const validated = await validateSmartAppPackageDirectory(installation.packagePath, {
        developmentSource: installation.source === 'linked',
      })
      if (
        installation.source === 'linked' &&
        ((validated.manifest.flavor ?? 'extended') !==
          (installation.manifest.flavor ?? 'extended') ||
          validated.manifest.name !== installation.id)
      )
        throw new Error(
          'Workbench identity or type changed; remove and link the folder again to confirm its execution permissions'
        )
      if (validated.sha256 !== installation.sha256 && installation.source === 'linked') {
        installation.manifest = validated.manifest
      }
      const prepared = await prepareWorkbenchDshLaunch({
        runtimeRoot: this.options.runtimeRoot,
        dataDirectory: this.options.dataDirectory,
        installationId: installation.id,
        packagePath: installation.packagePath,
        manifest: installation.manifest,
        environment: this.options.environment,
        port: 0,
        modelBaseUrl: input.modelBaseUrl,
        additionalModels,
        contextBaseUrl: input.contextBaseUrl,
        contextToken: input.contextToken,
        decisionBaseUrl: decisionRoute?.baseUrl ?? null,
        decisionProtocolVersion: decisionRoute?.protocolVersion ?? null,
      })
      if (this.startingVersions.get(input.installationId) !== version)
        throw new Error('Workbench startup was canceled')
      const runtime = await runtimeHost.open({
        tabId: id,
        url: prepared.url,
        command: prepared.command,
        args: prepared.args,
        cwd: prepared.cwd,
        environment: prepared.environment,
        logDirectory: this.options.logDirectory,
      })
      return await this.serial(async () => {
        if (this.startingVersions.get(input.installationId) !== version)
          throw new Error('Workbench startup was canceled')
        const installations = await this.readRegistry()
        const current = requiredInstallation(installations, input.installationId)
        current.state = 'running'
        current.webUrl = runtime.url
        current.runtimeVersion = prepared.version
        current.error = null
        await this.writeRegistry(installations)
        return current
      })
    } catch (error) {
      await this.serial(async () => {
        if (this.startingVersions.get(input.installationId) !== version) return
        const installations = await this.readRegistry()
        const current = installations.find(item => item.id === input.installationId)
        if (!current) return
        current.state = 'failed'
        current.webUrl = null
        current.error = error instanceof Error ? error.message : String(error)
        await this.writeRegistry(installations)
      })
      throw error
    }
  }

  async stop(installationId: string): Promise<void> {
    this.startingVersions.set(installationId, (this.startingVersions.get(installationId) ?? 0) + 1)
    await this.options.runtimeHost()?.close(tabId(installationId))
    return this.serial(async () => {
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
    updates: {
      modelKey?: string
      resident?: boolean
      background?: boolean
      presentation?: 'window' | 'tab'
      shortcut?: string | null
    }
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
      if (updates.background !== undefined) installation.background = updates.background
      if (updates.presentation !== undefined) installation.presentation = updates.presentation
      if (updates.shortcut !== undefined) installation.shortcut = updates.shortcut
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
      await rejectOversizedPublishArchive(packed.archivePath, packed.sizeBytes)
      return {
        archivePath: packed.archivePath,
        sha256: packed.sha256,
        sizeBytes: packed.sizeBytes,
        manifest: packed.manifest,
      }
    }
    await archiveDirectory(installation.packagePath, archivePath)
    const metadata = await stat(archivePath)
    await rejectOversizedPublishArchive(archivePath, metadata.size)
    return {
      archivePath,
      sha256: await fileSha256(archivePath),
      sizeBytes: metadata.size,
      manifest: installation.manifest,
    }
  }

  async exportToDownloads(installationId: string): Promise<SmartAppSavedExport> {
    const exported = await this.export(installationId)
    const downloadsDirectory = this.options.downloadsDirectory()
    await ensureDirectory(downloadsDirectory)
    const filename = `${safeName(exported.manifest.name)}-${exported.manifest.version}.zip`
    const destinationPath = await uniquePath(downloadsDirectory, filename)
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
    return this.verificationService.verify(projectRoot)
  }

  async inspectProject(projectRoot: string): Promise<SmartAppVerificationReport | null> {
    return this.verificationService.inspect(projectRoot)
  }

  async packProject(projectRoot: string, outputPath: string): Promise<SmartAppPackResult> {
    return this.verificationService.pack(projectRoot, outputPath)
  }

  async upload(archivePath: string, uploadUrl: string): Promise<void> {
    const url = new URL(uploadUrl)
    if (!isSecureTransferUrl(url)) throw new Error('Smart app upload must use HTTPS')
    const bytes = await readFile(resolve(archivePath))
    const response = await cloudFetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/zip' },
      body: bytes,
      // The link is scoped to one submission, and a 307 or 308 would resend the archive to another
      // host, so refuse redirects instead of following them.
      redirect: 'error',
    })
    if (!response.ok) throw new Error(`Smart app upload failed with HTTP ${response.status}`)
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
      background: true,
      runtimeVersion: null,
      state: 'installed',
      webUrl: null,
      error: null,
      smartAppId: null,
      releaseId: null,
      source: 'linked',
      authorized: false,
      grantedCapabilities: { decisionModel: false },
    }
    this.syncGrantedCapabilities(installation)
    await this.writeRegistry([...installations, installation])
    return installation
  }

  /**
   * Recomputes the trusted capability grants for an installation and reports
   * whether the stored record changed.
   */
  private syncGrantedCapabilities(installation: SmartAppInstallation): boolean {
    const decisionModel = decideDecisionModelGrant(installation.manifest)
    if (installation.grantedCapabilities?.decisionModel === decisionModel) return false
    installation.grantedCapabilities = { ...installation.grantedCapabilities, decisionModel }
    return true
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
    if (
      (installation.manifest.flavor ?? 'extended') !== (validated.manifest.flavor ?? 'extended')
    ) {
      return setInstallationFailure(
        installation,
        'Workbench type changed; remove and link the folder again to confirm its execution permissions'
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
