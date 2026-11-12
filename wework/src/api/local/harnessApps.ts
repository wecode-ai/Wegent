import { observeOperation } from '@/telemetry/observeOperation'
import { trackBusinessEvent } from '@/telemetry/businessEvents'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import type { UnlistenFn } from '@/desktop/disposeDesktopListener'

export const HARNESS_APP_LAUNCH_PROGRESS_EVENT = 'harness-app-launch-progress'

export type HarnessAppLaunchPhase = 'preparingRuntime' | 'loadingApp' | 'startingApp'

export interface HarnessAppLaunchProgress {
  installationId: string
  phase: HarnessAppLaunchPhase
}

export type WorkbenchFlavor = 'lightweight' | 'extended'
export type WorkbenchPresentation = 'window' | 'tab'

export interface WorkbenchViewBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface HarnessAppManifest {
  flavor?: WorkbenchFlavor
  name: string
  displayName: string
  version: string
  type: 'deepseek-harness-plugin-bundle'
  description: string
  entry: {
    installPackage: string
    profile: string
  }
  requirements: {
    dsh: string
    node: string
  }
  plugins?: Array<{
    spec: string
    path?: string
  }>
  /** Capability requests; a request is not a grant. */
  capabilities?: {
    decisionModel?: boolean
  }
  defaultModel?: Record<string, unknown>
}

export interface HarnessAppInstallation {
  id: string
  manifest: HarnessAppManifest
  packagePath: string
  sha256: string
  modelKey: string | null
  resident: boolean
  background?: boolean
  flavor?: WorkbenchFlavor
  presentation?: WorkbenchPresentation
  visible?: boolean
  shortcut?: string | null
  shortcutError?: string | null
  runtimeVersion: string | null
  state: 'installed' | 'running' | 'failed'
  webUrl: string | null
  error: string | null
  smartAppId?: number | null
  releaseId?: number | null
  source: 'managed' | 'linked' | 'market'
  /** Capabilities Wework authorized for this installation. */
  grantedCapabilities: {
    decisionModel: boolean
  }
}

/** Renderer-safe DTO matching the Host workbench application contract. */
export interface WorkbenchInstallation extends HarnessAppInstallation {
  flavor: WorkbenchFlavor
  presentation: WorkbenchPresentation
  visible: boolean
  shortcut: string | null
  shortcutError: string | null
}

export interface HarnessAppPreview {
  valid: boolean
  archivePath: string
  sha256: string
  manifest: HarnessAppManifest | null
  issues: string[]
}

export interface HarnessAppExport {
  archivePath: string
  sha256: string
  sizeBytes: number
  manifest: HarnessAppManifest
}

export interface HarnessAppSavedExport extends HarnessAppExport {
  destinationPath: string
}

export type HarnessAppVerificationStage =
  | 'environment'
  | 'manifest'
  | 'scripts'
  | 'artifacts'
  | 'runtime'
  | 'package'

export interface HarnessAppVerificationIssue {
  code: string
  stage: HarnessAppVerificationStage
  file: string | null
  message: string
  expected: string | null
  actual: string | null
  blocking: boolean
  hint: string | null
}

export interface HarnessAppVerificationStageResult {
  stage: HarnessAppVerificationStage
  status: 'passed' | 'failed' | 'skipped'
  startedAt: string
  finishedAt: string
  logPath: string | null
}

export interface HarnessAppVerificationReport {
  schemaVersion: 1
  status: 'passed' | 'failed' | 'stale'
  projectRoot: string
  inputFingerprint: string
  deliverableFingerprint: string | null
  startedAt: string
  finishedAt: string
  stages: HarnessAppVerificationStageResult[]
  issues: HarnessAppVerificationIssue[]
}

export type SmartAppTemplate = 'web' | 'host' | 'web-host' | 'web-host-remote'

export const harnessAppsApi = {
  createDirectory(input: {
    parentPath: string
    name: string
    displayName: string
    description: string
    template: SmartAppTemplate
    flavor: WorkbenchFlavor
  }) {
    return observeOperation(
      'smart_app.create',
      () => invokeDesktopHost<HarnessAppInstallation | null>('smartApps.createDirectory', input),
      result => result?.state === 'installed' || result?.state === 'running'
    )
  },
  linkDirectory(directoryPath: string) {
    return observeOperation(
      'smart_app.link',
      () =>
        invokeDesktopHost<HarnessAppInstallation | null>('smartApps.linkDirectory', {
          directoryPath,
        }),
      result => result?.state === 'installed' || result?.state === 'running'
    )
  },
  addPlugin(installationId: string, pluginSpec: string) {
    return observeOperation(
      'smart_app.add_plugin',
      () =>
        invokeDesktopHost<HarnessAppInstallation>('smartApps.addPlugin', {
          installationId,
          pluginSpec,
        }),
      result => result.state === 'installed' || result.state === 'running'
    )
  },
  copyToDirectory(
    installationId: string,
    input: { parentPath: string; name: string; displayName: string }
  ) {
    return observeOperation(
      'smart_app.copy',
      () =>
        invokeDesktopHost<HarnessAppInstallation | null>('smartApps.copyToDirectory', {
          installationId,
          ...input,
        }),
      result => result?.state === 'installed' || result?.state === 'running'
    )
  },
  preview(archivePath: string) {
    return invokeDesktopHost<HarnessAppPreview>('smartApps.preview', { archivePath })
  },
  download(input: {
    downloadUrl: string
    sha256: string
    sizeBytes: number
    smartAppId: number
    releaseId: number
  }) {
    return invokeDesktopHost<HarnessAppPreview>('smartApps.download', input)
  },
  export(installationId: string) {
    return invokeDesktopHost<HarnessAppExport>('smartApps.export', { installationId })
  },
  inspectVerification(installationId: string) {
    return invokeDesktopHost<HarnessAppVerificationReport | null>('smartApps.inspectVerification', {
      installationId,
    })
  },
  async exportToDownloads(installationId: string): Promise<HarnessAppSavedExport> {
    return observeOperation('smart_app.export', () =>
      invokeDesktopHost<HarnessAppSavedExport>('smartApps.exportToDownloads', {
        installationId,
      })
    )
  },
  upload(archivePath: string, uploadUrl: string) {
    return invokeDesktopHost<void>('smartApps.upload', { archivePath, uploadUrl })
  },
  list() {
    return invokeDesktopHost<WorkbenchInstallation[]>('smartApps.list')
  },
  install(
    preview: HarnessAppPreview,
    modelKey: string | null,
    source: { smartAppId: number; releaseId: number } | null = null
  ) {
    return invokeDesktopHost<HarnessAppInstallation | null>('smartApps.install', {
      archivePath: preview.archivePath,
      expectedSha256: preview.sha256,
      modelKey,
      smartAppId: source?.smartAppId ?? null,
      releaseId: source?.releaseId ?? null,
    })
  },
  open(
    installationId: string,
    presentation?: WorkbenchPresentation,
    options?: { activateTab?: boolean }
  ) {
    const startupId = crypto.randomUUID()
    trackBusinessEvent('smart_app_start_attempted', { startup_id: startupId })
    return observeOperation(
      'smart_app.start',
      () =>
        invokeDesktopHost<WorkbenchInstallation>('smartApps.open', {
          installationId,
          ...(presentation ? { presentation } : {}),
          ...(options?.activateTab !== undefined ? { activateTab: options.activateTab } : {}),
        }),
      result => result.state === 'running',
      { properties: { startup_id: startupId } }
    )
  },
  preparePreview(installationId: string) {
    return invokeDesktopHost<HarnessAppInstallation>('smartApps.preparePreview', { installationId })
  },
  createTodo() {
    return invokeDesktopHost<WorkbenchInstallation | null>('smartApps.createTodo')
  },
  hide(installationId: string) {
    return invokeDesktopHost<void>('smartApps.hide', { installationId })
  },
  closeView(installationId: string) {
    return invokeDesktopHost<void>('smartApps.closeView', { installationId })
  },
  layout(installationId: string, bounds: WorkbenchViewBounds, visible: boolean) {
    return invokeDesktopHost<void>('smartApps.layout', { installationId, bounds, visible })
  },
  configure(
    installationId: string,
    updates: { presentation?: WorkbenchPresentation; resident?: boolean; background?: boolean }
  ) {
    return invokeDesktopHost<HarnessAppInstallation>('smartApps.configure', {
      installationId,
      ...updates,
    })
  },
  createShortcut(installationId: string) {
    return invokeDesktopHost<string>('smartApps.createShortcut', { installationId })
  },
  setShortcut(installationId: string, accelerator: string | null) {
    return invokeDesktopHost<void>('smartApps.setShortcut', { installationId, accelerator })
  },
  stop(installationId: string) {
    return observeOperation('smart_app.stop', () =>
      invokeDesktopHost<void>('smartApps.stop', { installationId })
    )
  },
  verify(installationId: string) {
    return observeOperation(
      'smart_app.verify',
      () => invokeDesktopHost<HarnessAppVerificationReport>('smartApps.verify', { installationId }),
      result => result.status === 'passed'
    )
  },
  update(installationId: string, updates: { modelKey?: string; resident?: boolean }) {
    return observeOperation(
      'smart_app.configure',
      () =>
        invokeDesktopHost<HarnessAppInstallation>('smartApps.update', {
          installationId,
          ...updates,
        }),
      result => result.state === 'installed' || result.state === 'running'
    )
  },
  delete(installationId: string, deleteData = false) {
    return observeOperation('smart_app.uninstall', () =>
      invokeDesktopHost<void>('smartApps.delete', { installationId, deleteData })
    )
  },
}

export function listenHarnessAppLaunchProgress(
  callback: (progress: HarnessAppLaunchProgress) => void
): Promise<UnlistenFn> {
  void callback
  return Promise.resolve(() => undefined)
}
