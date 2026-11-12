import { app, globalShortcut, type BrowserWindow, type WebContents } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  WORKBENCH_DSH_VERSION,
  type WorkbenchAppManifest,
} from '../runtime/workbench-dsh-runtime.js'
import {
  importLegacyLightApp,
  readLegacyLightAppData,
  readLegacyLightApps,
} from './legacy-light-app-import.js'
import { SmartAppManager, type SmartAppInstallation } from './smart-app-manager.js'
import {
  copySmartAppDirectorySafe,
  validateSmartAppPackageDirectory,
} from './smart-app-package-validator.js'
import { WorkbenchAppServices } from './workbench-app-services.js'
import { WorkbenchRoutes } from './workbench-routes.js'
import { GlobalShortcutController } from './global-shortcut-controller.js'
import {
  WorkbenchDesktopShortcuts,
  normalizeWorkbenchShortcut,
  type WorkbenchShortcutLaunch,
} from './workbench-shortcuts.js'
import {
  createWorkbenchSurface,
  removeWorkbenchSession,
  type WorkbenchBounds,
  type WorkbenchSurface,
} from './workbench-window.js'
import { confirmWorkbenchInstallation } from './workbench-installation.js'
import {
  workbenchId,
  type WorkbenchConfiguration,
  type WorkbenchInstallation,
  type WorkbenchPresentation,
  type WorkbenchService,
} from './workbench-application-contract.js'

export interface WorkbenchApplicationHostOptions {
  manager: SmartAppManager
  routes: WorkbenchRoutes
  dataDirectory: string
  desktopDirectory: string
  desktopShortcutLaunch: WorkbenchShortcutLaunch
  installationPreloadPath: string
  parent(): BrowserWindow | null
  ensureServices(): Promise<void>
  showTab(
    installation: WorkbenchInstallation,
    signal: AbortSignal,
    activateTab: boolean
  ): Promise<void>
  hideTab(id: string): Promise<void>
  createTodoProject(locale: string): Promise<string>
  confirmInstall?(
    manifest: WorkbenchAppManifest,
    previous: WorkbenchAppManifest | undefined,
    signal: AbortSignal
  ): Promise<boolean>
  createSurface?(installation: SmartAppInstallation, onClose: () => void): WorkbenchSurface
  cloudConnection?: unknown
  report?(error: unknown): void
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  if (signal.aborted) {
    void operation.catch(() => {})
    return Promise.reject(signal.reason)
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** The installation is the identity; tab/window is only its current presentation. */
export class WorkbenchApplicationHost implements WorkbenchService {
  readonly native: WorkbenchAppServices
  private readonly surfaces = new Map<string, WorkbenchSurface>()
  private readonly visibleTabs = new Set<string>()
  private readonly opening = new Map<string, Promise<WorkbenchInstallation>>()
  private readonly openingGenerations = new Map<string, number>()
  private readonly stopping = new Map<string, Promise<void>>()
  private readonly removing = new Set<string>()
  private readonly installing = new Set<string>()
  private readonly requestedPresentation = new Map<string, WorkbenchPresentation>()
  private readonly starting = new Map<
    string,
    { generation: number; operation: Promise<SmartAppInstallation> }
  >()
  private readonly generations = new Map<string, number>()
  private readonly viewRevisions = new Map<string, number>()
  private readonly viewRequests = new Map<string, AbortController>()
  private readonly cancellations = new Map<string, AbortController>()
  private readonly shortcuts = new Map<string, GlobalShortcutController>()
  private readonly shortcutOperations = new Map<string, Promise<void>>()
  private readonly shortcutErrors = new Map<string, string>()
  private readonly desktopShortcuts: WorkbenchDesktopShortcuts
  private readonly consent = new AbortController()
  private disposed = false
  private cloudIdentity: string
  private cloudEpoch = 0
  private readonly cloudBound = new Set<string>()
  private cloudTransition: Promise<void> = Promise.resolve()
  private runtimeTransition: Promise<void> = Promise.resolve()

  constructor(private readonly options: WorkbenchApplicationHostOptions) {
    this.cloudIdentity = connectionIdentity(options.cloudConnection)
    this.desktopShortcuts = new WorkbenchDesktopShortcuts(
      options.desktopDirectory,
      options.desktopShortcutLaunch
    )
    this.native = new WorkbenchAppServices(options.dataDirectory, {
      get: id => options.manager.get(id),
      open: id => this.open(id),
      window: id => this.ownerWindowForId(id),
      hide: id => this.hide(id),
      setAlwaysOnTop: async (id, value) => {
        const installation = await options.manager.get(id)
        const window = installation.presentation === 'window' ? this.windowForId(id) : null
        if (!window) throw new Error('Always on top requires an independent workbench window')
        window.setAlwaysOnTop(value)
      },
      report: error => this.report(error),
    })
  }
  async start(): Promise<void> {
    for (const installation of await this.options.manager.list()) {
      this.assertActive()
      try {
        if (installation.shortcut)
          this.controller(installation.id).configure(
            normalizeWorkbenchShortcut(installation.shortcut)
          )
      } catch (error) {
        this.shortcutErrors.set(
          installation.id,
          error instanceof Error ? error.message : String(error)
        )
        this.report(error)
      }
    }
    this.assertActive()
    void this.resumeResident().catch(error => this.report(error))
  }
  scaffold(input: Parameters<SmartAppManager['scaffold']>[0]) {
    return this.options.manager.scaffold(input)
  }
  async list(): Promise<WorkbenchInstallation[]> {
    return (await this.options.manager.list()).map(item => this.snapshot(item))
  }
  async install(projectPath: string): Promise<WorkbenchInstallation | null> {
    this.assertActive()
    const staging = join(this.options.dataDirectory, 'harness-apps', 'staging', randomUUID())
    await mkdir(join(this.options.dataDirectory, 'harness-apps', 'staging'), {
      recursive: true,
      mode: 0o700,
    })
    let claimedId: string | undefined
    let restoreNative = false
    let rollbackShortcut: { id: string; value: string | null } | undefined
    try {
      const legacy = await isLegacyProject(projectPath)
      if (legacy) await importLegacyLightApp(projectPath, staging, WORKBENCH_DSH_VERSION)
      else await copySmartAppDirectorySafe(projectPath, staging)
      const validated = await validateSmartAppPackageDirectory(staging)
      const installations = await this.options.manager.list()
      const previous = installations.find(item => item.id === validated.manifest.name)
      this.claimInstallation(validated.manifest.name, previous)
      claimedId = validated.manifest.name
      const legacyRecord = legacy
        ? (await readLegacyLightApps(this.options.dataDirectory)).find(
            item => item.manifest.id === validated.manifest.name
          )
        : null
      const legacyData = legacyRecord
        ? await readLegacyLightAppData(this.options.dataDirectory, legacyRecord.manifest.id)
        : null
      const shortcut =
        previous?.shortcut ||
        (legacyRecord?.shortcut ? normalizeWorkbenchShortcut(legacyRecord.shortcut) : null)
      if (
        shortcut &&
        installations.some(
          item =>
            item.id !== claimedId &&
            item.shortcut &&
            normalizeWorkbenchShortcut(item.shortcut) === shortcut
        )
      )
        throw new Error('This shortcut is already used by another workbench')
      if (legacyData) {
        this.native.revoke(claimedId)
        restoreNative = Boolean(previous)
        await this.native.data.checkLegacyImport(claimedId, legacyData)
      }
      if (!(await this.confirm(validated.manifest, previous?.manifest))) return null
      this.assertActive()
      if (shortcut !== (previous?.shortcut ?? null)) {
        this.controller(claimedId).configure(shortcut)
        rollbackShortcut = { id: claimedId, value: previous?.shortcut ?? null }
      }
      if (legacyData) await this.native.data.importLegacy(claimedId, legacyData)
      const installation = await this.options.manager.installDirectory(
        staging,
        validated.manifest.capabilities?.native ?? [],
        previous?.sha256 ?? null,
        shortcut
      )
      rollbackShortcut = undefined
      restoreNative = false
      this.native.activate(installation.id)
      this.installing.delete(installation.id)
      return this.open(installation.id)
    } finally {
      if (rollbackShortcut) {
        try {
          this.controller(rollbackShortcut.id).configure(rollbackShortcut.value)
        } catch (error) {
          this.report(error)
        }
      }
      if (restoreNative && claimedId && !this.disposed) {
        this.native.activate(claimedId)
      }
      if (claimedId) this.installing.delete(claimedId)
      await rm(staging, { recursive: true, force: true })
    }
  }
  async createTodo(): Promise<WorkbenchInstallation | null> {
    const project = await this.options.createTodoProject(app.getLocale())
    try {
      return await this.install(project)
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  }
  async authorizeInstallation(
    installation: SmartAppInstallation
  ): Promise<WorkbenchInstallation | null> {
    this.claimInstallation(installation.id, installation)
    try {
      if (!(await this.confirm(installation.manifest))) {
        if (installation.authorized === false)
          await this.options.manager.delete(installation.id, false)
        return null
      }
      this.assertActive()
      await this.options.manager.grantNativeCapabilities(
        installation.id,
        installation.manifest.capabilities?.native ?? []
      )
      this.native.activate(installation.id)
      return this.snapshot(await this.options.manager.get(installation.id))
    } finally {
      this.installing.delete(installation.id)
    }
  }
  async installArchive(
    input: Parameters<SmartAppManager['install']>[0]
  ): Promise<WorkbenchInstallation | null> {
    const preview = await this.options.manager.preview(input.archivePath)
    if (!preview.valid || !preview.manifest || preview.sha256 !== input.expectedSha256)
      throw new Error('Workbench package changed or is invalid')
    const id = input.smartAppId == null ? preview.manifest.name : `market-${input.smartAppId}`
    const previous = (await this.options.manager.list()).find(item => item.id === id)
    this.claimInstallation(id, previous)
    try {
      if (!(await this.confirm(preview.manifest, previous?.manifest))) return null
      this.assertActive()
      const installation = await this.options.manager.install({
        ...input,
        authorizedNative: preview.manifest.capabilities?.native ?? [],
        expectedPreviousSha256: previous?.sha256 ?? null,
      })
      this.native.activate(id)
      return this.snapshot(installation)
    } finally {
      this.installing.delete(id)
    }
  }
  open(
    id: string,
    presentation?: WorkbenchPresentation,
    activateTab = true
  ): Promise<WorkbenchInstallation> {
    workbenchId(id)
    if (presentation !== undefined && presentation !== 'window' && presentation !== 'tab')
      throw new Error('Invalid workbench presentation')
    if (typeof activateTab !== 'boolean') throw new Error('Invalid workbench tab activation')
    this.assertActive()
    this.assertNotRemoving(id)
    this.assertNotInstalling(id)
    if (!activateTab) {
      const existing = this.opening.get(id)
      if (existing && this.openingGenerations.get(id) === this.generation(id)) return existing
      return this.restoreTab(id)
    }
    return this.requestPresentation(id, presentation, activateTab)
  }
  private async restoreTab(id: string): Promise<WorkbenchInstallation> {
    const generation = this.generation(id)
    const revision = this.viewRevisions.get(id) ?? 0
    const installation = await this.options.manager.get(id)
    this.assertOpening(id, generation)
    if (revision !== (this.viewRevisions.get(id) ?? 0)) {
      return this.opening.get(id) ?? this.snapshot(await this.options.manager.get(id))
    }
    this.assertNotRemoving(id)
    this.assertNotInstalling(id)
    if (installation.presentation !== 'tab') {
      await this.options.hideTab(id)
      return this.snapshot(await this.options.manager.get(id))
    }
    return this.requestPresentation(id, undefined, false)
  }
  private requestPresentation(
    id: string,
    presentation: WorkbenchPresentation | undefined,
    activateTab: boolean
  ): Promise<WorkbenchInstallation> {
    const revision = this.advanceViewRevision(id)
    if (presentation) this.requestedPresentation.set(id, presentation)
    const existing = this.opening.get(id)
    if (existing && this.openingGenerations.get(id) === this.generation(id))
      return existing.then(() => {
        if (this.viewRevisions.get(id) === revision) return this.open(id, presentation, activateTab)
        return this.options.manager.get(id).then(item => this.snapshot(item))
      })
    const generation = this.generation(id)
    const cancellation = new AbortController()
    const viewRequest = new AbortController()
    this.cancellations.set(id, cancellation)
    this.viewRequests.set(id, viewRequest)
    const operation = this.openPresentation(
      id,
      presentation,
      activateTab,
      generation,
      revision,
      cancellation.signal,
      viewRequest.signal
    )
    this.opening.set(id, operation)
    this.openingGenerations.set(id, generation)
    void operation
      .finally(() => {
        if (this.opening.get(id) === operation) {
          this.opening.delete(id)
          this.openingGenerations.delete(id)
          this.cancellations.delete(id)
          this.requestedPresentation.delete(id)
        }
        if (this.viewRequests.get(id) === viewRequest) this.viewRequests.delete(id)
      })
      .catch(() => {})
    return operation
  }
  async preparePreview(id: string): Promise<WorkbenchInstallation> {
    workbenchId(id)
    this.assertActive()
    const generation = this.generation(id)
    const installation = await this.startRuntime(id, generation)
    this.assertOpening(id, generation)
    return this.snapshot(installation)
  }
  async hide(id: string): Promise<void> {
    workbenchId(id)
    this.advanceViewRevision(id)
    this.surfaces.get(id)?.hide()
    this.visibleTabs.delete(id)
    await this.options.hideTab(id)
  }
  stop(id: string): Promise<void> {
    workbenchId(id)
    const existing = this.stopping.get(id)
    if (existing) return existing
    const operation = this.performStop(id)
    this.stopping.set(id, operation)
    void operation
      .finally(() => {
        if (this.stopping.get(id) === operation) this.stopping.delete(id)
      })
      .catch(() => {})
    return operation
  }
  private async performStop(id: string): Promise<void> {
    this.generations.set(id, this.generation(id) + 1)
    this.advanceViewRevision(id)
    this.cancellations.get(id)?.abort(new Error('Workbench opening was canceled'))
    const surface = this.surfaces.get(id)
    this.surfaces.delete(id)
    surface?.dispose()
    this.visibleTabs.delete(id)
    const opening = this.opening.get(id)
    await this.options.hideTab(id)
    try {
      await this.options.manager.stop(id)
      await opening?.catch(() => undefined)
    } finally {
      this.cloudBound.delete(id)
      await this.options.routes.release(id)
    }
  }
  async remove(id: string, deleteData = true): Promise<void> {
    workbenchId(id)
    this.assertNotInstalling(id)
    if (this.removing.has(id)) throw new Error('Workbench removal is already in progress')
    this.removing.add(id)
    this.native.revoke(id)
    try {
      // Finish accepted writes and rollback before deleting their owned resources.
      await this.shortcutOperations.get(id)
      await this.stop(id)
      await this.desktopShortcuts.remove(id)
      if (deleteData) await removeWorkbenchSession(id)
      await this.options.manager.delete(id, deleteData)
      this.shortcuts.get(id)?.dispose()
      this.shortcuts.delete(id)
      this.shortcutErrors.delete(id)
      if (deleteData) await this.native.removeData(id)
    } finally {
      this.removing.delete(id)
    }
  }
  async createShortcut(id: string): Promise<string> {
    return this.mutateShortcut(id, async () => {
      await this.options.manager.get(id)
      return this.desktopShortcuts.create(id)
    })
  }
  async setShortcut(id: string, accelerator: string | null): Promise<void> {
    return this.mutateShortcut(id, async () => {
      const installation = await this.options.manager.get(id)
      const next = accelerator === null ? null : normalizeWorkbenchShortcut(accelerator)
      if (
        next &&
        (await this.options.manager.list()).some(
          other =>
            other.id !== id && other.shortcut && normalizeWorkbenchShortcut(other.shortcut) === next
        )
      )
        throw new Error('This shortcut is already used by another workbench')
      const controller = this.controller(id)
      controller.configure(next)
      try {
        await this.options.manager.update(id, { shortcut: next })
        this.shortcutErrors.delete(id)
      } catch (error) {
        controller.configure(installation.shortcut ?? null)
        throw error
      }
    })
  }
  async configure(id: string, input: WorkbenchConfiguration): Promise<WorkbenchInstallation> {
    if (
      input.presentation !== undefined &&
      input.presentation !== 'tab' &&
      input.presentation !== 'window'
    )
      throw new Error('Invalid workbench presentation')
    const installation = await this.options.manager.update(workbenchId(id), input)
    if (this.isVisible(id) && input.presentation) return this.open(id, input.presentation)
    return this.snapshot(installation)
  }
  windowForId(id: string): BrowserWindow | null {
    return this.surfaces.get(id)?.window() ?? null
  }
  ownerWindowForId(id: string): BrowserWindow | null {
    return this.visibleTabs.has(id) ? this.options.parent() : this.windowForId(id)
  }
  isViewVisible(id: string): boolean {
    return this.surfaces.get(id)?.visible() ?? false
  }
  contentsForId(id: string): WebContents | null {
    return this.surfaces.get(id)?.contents ?? null
  }
  hasVisibleWindows(): boolean {
    return [...this.surfaces.values()].some(surface => surface.visible())
  }
  cloudConnectionChanged(value: string | null): Promise<void> {
    let connection: unknown = null
    try {
      connection = value ? JSON.parse(value) : null
    } catch {
      /* Invalid profiles revoke cloud routes. */
    }
    const next = connectionIdentity(connection)
    if (next === this.cloudIdentity) return this.cloudTransition
    this.cloudIdentity = next
    this.cloudEpoch++
    const stopping = [...this.cloudBound].map(id => this.stop(id))
    this.cloudTransition = this.finishInvalidation(stopping)
    return this.cloudTransition
  }
  invalidateRuntime(): Promise<void> {
    this.options.routes.invalidate()
    const ids = new Set([
      ...this.surfaces.keys(),
      ...this.opening.keys(),
      ...this.starting.keys(),
      ...this.cloudBound,
    ])
    const stopping = [...ids].map(id => this.stop(id))
    const operation = (async () => {
      for (const installation of await this.options.manager.list()) {
        if (installation.state === 'running' && !ids.has(installation.id))
          stopping.push(this.stop(installation.id))
      }
      await this.finishInvalidation(stopping)
    })()
    this.runtimeTransition = operation
    return operation
  }
  async resumeResident(): Promise<void> {
    await this.runtimeTransition
    if (this.disposed) return
    await Promise.all(
      (await this.options.manager.list())
        .filter(item => item.resident)
        .map(async item => {
          try {
            await this.startRuntime(item.id)
          } catch (error) {
            this.report(error)
          }
        })
    )
  }
  private async finishInvalidation(stopping: Promise<void>[]): Promise<void> {
    const failures = (await Promise.allSettled(stopping)).filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (failures.length)
      throw new AggregateError(
        failures.map(result => result.reason),
        'Workbench runtimes could not be invalidated'
      )
  }
  async layout(id: string, bounds: WorkbenchBounds, visible: boolean): Promise<void> {
    workbenchId(id)
    const revision = this.viewRevisions.get(id) ?? 0
    const installation = await this.options.manager.get(id)
    if (installation.presentation !== 'tab' || revision !== (this.viewRevisions.get(id) ?? 0))
      return
    const parent = this.options.parent()
    if (!parent || parent.isDestroyed()) throw new Error('Workbench main window is unavailable')
    const surface = this.surfaces.get(id)
    if (!surface) return
    if (!this.visibleTabs.has(id)) return
    if (!visible) {
      surface.showTab(parent, { x: 0, y: 0, width: 1, height: 1 }, false)
      return
    }
    const zoom = parent.webContents.getZoomFactor()
    const scaled = {
      x: Math.round(bounds.x * zoom),
      y: Math.round(bounds.y * zoom),
      width: Math.round(bounds.width * zoom),
      height: Math.round(bounds.height * zoom),
    }
    if (
      !Object.values(scaled).every(value => Number.isFinite(value)) ||
      scaled.width < 1 ||
      scaled.height < 1 ||
      scaled.width > 32768 ||
      scaled.height > 32768 ||
      Math.abs(scaled.x) > 32768 ||
      Math.abs(scaled.y) > 32768
    )
      throw new Error('Invalid workbench bounds')
    surface.showTab(parent, scaled, visible)
  }
  async dispose(): Promise<void> {
    this.disposed = true
    this.consent.abort()
    for (const cancellation of this.cancellations.values())
      cancellation.abort(new Error('Workbench Host is disposed'))
    this.native.dispose()
    for (const id of this.opening.keys()) this.generations.set(id, this.generation(id) + 1)
    for (const surface of this.surfaces.values()) surface.dispose()
    this.surfaces.clear()
    await Promise.allSettled([...this.shortcutOperations.values()])
    for (const controller of this.shortcuts.values()) controller.dispose()
    this.shortcuts.clear()
    await Promise.allSettled([...this.opening.values()])
    await this.options.routes.dispose()
  }
  private async startRuntime(
    id: string,
    generation = this.generation(id),
    signal?: AbortSignal
  ): Promise<SmartAppInstallation> {
    const existing = this.starting.get(id)
    if (existing?.generation === generation) return abortable(existing.operation, signal)
    const operation = this.performStartRuntime(id, generation, signal)
    this.starting.set(id, { generation, operation })
    void operation
      .finally(() => {
        if (this.starting.get(id)?.operation === operation) this.starting.delete(id)
      })
      .catch(() => {})
    return operation
  }
  private async performStartRuntime(
    id: string,
    generation: number,
    signal?: AbortSignal
  ): Promise<SmartAppInstallation> {
    this.assertNotRemoving(id)
    this.assertNotInstalling(id)
    const stopping = this.stopping.get(id)
    if (stopping) await abortable(stopping, signal)
    this.assertNotRemoving(id)
    this.assertNotInstalling(id)
    const cloudEpoch = this.cloudEpoch
    await abortable(this.runtimeTransition, signal)
    await abortable(this.options.ensureServices(), signal)
    this.assertOpening(id, generation)
    const installation = await this.options.manager.get(id)
    if (installation.authorized === false)
      throw new Error('Complete native installation confirmation before running this workbench')
    if (installation.state === 'running') return installation
    if (
      installation.grantedCapabilities.decisionModel ||
      (installation.modelKey && installation.modelKey.split(':')[1] !== 'runtime')
    ) {
      await abortable(this.cloudTransition, signal)
      if (cloudEpoch !== this.cloudEpoch)
        throw new Error('Workbench cloud identity changed while starting')
      this.cloudBound.add(id)
    }
    const routes = await abortable(this.options.routes.acquire(installation, signal), signal)
    try {
      this.assertOpening(id, generation)
      return await abortable(this.options.manager.start({ installationId: id, ...routes }), signal)
    } catch (error) {
      try {
        await this.options.routes.release(id, routes)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Workbench startup failed and route cleanup was incomplete',
          { cause: cleanupError }
        )
      }
      throw error
    }
  }
  private async openPresentation(
    id: string,
    presentation: WorkbenchPresentation | undefined,
    activateTab: boolean,
    generation: number,
    revision: number,
    signal: AbortSignal,
    viewSignal: AbortSignal
  ): Promise<WorkbenchInstallation> {
    let installation = await this.startRuntime(id, generation, signal)
    this.assertOpening(id, generation)
    if (presentation) installation = await this.options.manager.update(id, { presentation })
    const current = () => this.viewRevisions.get(id) === revision && !viewSignal.aborted
    if (!current()) return this.snapshot(installation)
    const target = installation.presentation ?? 'window'
    if (!activateTab && target !== 'tab') {
      await this.options.hideTab(id)
      return this.snapshot(await this.options.manager.get(id))
    }
    let surface = this.surfaces.get(id)
    if (!surface) {
      surface = (this.options.createSurface ?? createWorkbenchSurface)(installation, () => {
        void this.closeView(id, 'window').catch(error => this.report(error))
      })
      this.surfaces.set(id, surface)
      try {
        await abortable(surface.ready, signal)
        this.assertOpening(id, generation)
      } catch (error) {
        if (this.surfaces.get(id) === surface) this.surfaces.delete(id)
        surface.dispose()
        throw error
      }
    }
    if (!current()) return this.snapshot(installation)
    if (!activateTab) {
      installation = await this.options.manager.get(id)
      this.assertOpening(id, generation)
      if (!current()) return this.snapshot(installation)
      if (installation.presentation !== 'tab') {
        await this.options.hideTab(id)
        return this.snapshot(installation)
      }
    }
    if (target === 'tab') {
      surface.hide()
      const presentationSignal = AbortSignal.any([signal, viewSignal])
      try {
        await abortable(
          this.options.showTab(this.snapshot(installation), presentationSignal, activateTab),
          presentationSignal
        )
      } catch (error) {
        this.assertOpening(id, generation)
        if (!current()) return this.snapshot(installation)
        throw error
      }
      this.assertOpening(id, generation)
      if (!current()) return this.snapshot(installation)
      this.visibleTabs.add(id)
    } else {
      this.visibleTabs.delete(id)
      await this.options.hideTab(id)
      this.assertOpening(id, generation)
      if (!current()) return this.snapshot(installation)
      surface.showWindow()
    }
    return this.snapshot(installation)
  }
  private snapshot(installation: SmartAppInstallation): WorkbenchInstallation {
    return {
      ...installation,
      flavor: installation.manifest.flavor ?? 'extended',
      background: installation.background ?? true,
      presentation: installation.presentation ?? 'window',
      visible: this.isVisible(installation.id),
      shortcut: installation.shortcut ?? null,
      shortcutError: this.shortcutErrors.get(installation.id) ?? null,
    }
  }
  private isVisible(id: string): boolean {
    return Boolean(this.surfaces.get(id)?.visible() || this.visibleTabs.has(id))
  }
  async closeView(id: string, expectedPresentation?: WorkbenchPresentation): Promise<void> {
    workbenchId(id)
    const revision = this.viewRevisions.get(id) ?? 0
    const generation = this.generation(id)
    const installation = await this.options.manager.get(id)
    const current = () =>
      revision === (this.viewRevisions.get(id) ?? 0) && generation === this.generation(id)
    if (
      !current() ||
      (expectedPresentation &&
        (this.requestedPresentation.get(id) ?? installation.presentation ?? 'window') !==
          expectedPresentation)
    )
      return
    if (this.opening.has(id)) {
      if (installation.state !== 'running' || installation.background === false) {
        await this.stop(id)
        return
      }
    }
    const hiddenRevision = (this.viewRevisions.get(id) ?? 0) + 1
    await this.hide(id)
    if (
      this.viewRevisions.get(id) === hiddenRevision &&
      generation === this.generation(id) &&
      installation.background === false
    )
      await this.stop(id)
  }
  private advanceViewRevision(id: string): number {
    // Presentation intent is independent of the DSH process lifetime.
    const revision = (this.viewRevisions.get(id) ?? 0) + 1
    this.viewRevisions.set(id, revision)
    this.viewRequests.get(id)?.abort(new Error('Workbench presentation was superseded'))
    return revision
  }
  private mutateShortcut<T>(id: string, operation: () => Promise<T>): Promise<T> {
    workbenchId(id)
    this.assertActive()
    this.assertNotRemoving(id)
    this.assertNotInstalling(id)
    const result = (this.shortcutOperations.get(id) ?? Promise.resolve()).then(() => {
      this.assertActive()
      this.assertNotRemoving(id)
      this.assertNotInstalling(id)
      return operation()
    })
    const settled = result.then(
      () => undefined,
      () => undefined
    )
    this.shortcutOperations.set(id, settled)
    void settled.then(() => {
      if (this.shortcutOperations.get(id) === settled) this.shortcutOperations.delete(id)
    })
    return result
  }
  private generation(id: string): number {
    return this.generations.get(id) ?? 0
  }
  private assertOpening(id: string, generation: number): void {
    this.assertActive()
    if (this.generation(id) !== generation) throw new Error('Workbench opening was canceled')
  }
  private assertActive(): void {
    if (this.disposed) throw new Error('Workbench Host is disposed')
  }
  private assertNotRemoving(id: string): void {
    if (this.removing.has(id)) throw new Error('Workbench is being removed')
  }
  private assertNotInstalling(id: string): void {
    if (this.installing.has(id)) throw new Error('Workbench installation is being confirmed')
  }
  private claimInstallation(id: string, previous?: SmartAppInstallation): void {
    this.assertActive()
    this.assertNotRemoving(id)
    this.assertNotInstalling(id)
    if (this.shortcutOperations.has(id))
      throw new Error('Wait for the workbench shortcut update before installing a new version')
    if (previous?.state === 'running' || this.opening.has(id) || this.starting.has(id))
      throw new Error('Stop the workbench before installing a new version')
    this.installing.add(id)
  }
  private controller(id: string): GlobalShortcutController {
    let controller = this.shortcuts.get(id)
    if (!controller) {
      controller = new GlobalShortcutController(
        globalShortcut,
        async () => {
          if (this.surfaces.get(id)?.focused()) await this.closeView(id)
          else await this.open(id)
        },
        error => this.report(error)
      )
      this.shortcuts.set(id, controller)
    }
    return controller
  }
  private confirm(
    manifest: WorkbenchAppManifest,
    previous?: WorkbenchAppManifest
  ): Promise<boolean> {
    return (
      this.options.confirmInstall?.(manifest, previous, this.consent.signal) ??
      confirmWorkbenchInstallation(
        manifest,
        this.options.parent(),
        previous,
        this.options.installationPreloadPath,
        this.consent.signal
      )
    )
  }
  private report(error: unknown): void {
    this.options.report?.(error)
  }
}

function connectionIdentity(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const input = value as {
    apiBaseUrl?: unknown
    backendUrl?: unknown
    socketBaseUrl?: unknown
    user?: { id?: unknown }
    credentialMode?: unknown
    token?: unknown
  }
  if (typeof input.apiBaseUrl !== 'string' || typeof input.user?.id !== 'number') return ''
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.apiBaseUrl,
        input.backendUrl,
        input.socketBaseUrl,
        input.user.id,
        input.credentialMode,
        input.token,
      ])
    )
    .digest('hex')
}

async function isLegacyProject(projectPath: string): Promise<boolean> {
  try {
    await lstat(join(projectPath, 'plugin-manifest.json'))
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    return (await lstat(join(projectPath, 'light-app.json'))).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return false
  }
}
