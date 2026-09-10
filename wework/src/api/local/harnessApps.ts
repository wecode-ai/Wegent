import { observeOperation } from '@/telemetry/observeOperation'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import type { UnlistenFn } from '@/desktop/disposeDesktopListener'

export const HARNESS_APP_LAUNCH_PROGRESS_EVENT = 'harness-app-launch-progress'

export type HarnessAppLaunchPhase = 'preparingRuntime' | 'loadingApp' | 'startingApp'

export interface HarnessAppLaunchProgress {
  installationId: string
  phase: HarnessAppLaunchPhase
}

export interface HarnessAppManifest {
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
  defaultModel?: Record<string, unknown>
}

export interface HarnessAppInstallation {
  id: string
  manifest: HarnessAppManifest
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
  }) {
    return observeOperation(
      'smart_app.create',
      () => invokeDesktopHost<HarnessAppInstallation>('smartApps.createDirectory', input),
      result => result.state === 'installed' || result.state === 'running'
    )
  },
  linkDirectory(directoryPath: string) {
    return observeOperation(
      'smart_app.link',
      () => invokeDesktopHost<HarnessAppInstallation>('smartApps.linkDirectory', { directoryPath }),
      result => result.state === 'installed' || result.state === 'running'
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
        invokeDesktopHost<HarnessAppInstallation>('smartApps.copyToDirectory', {
          installationId,
          ...input,
        }),
      result => result.state === 'installed' || result.state === 'running'
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
    return invokeDesktopHost<HarnessAppInstallation[]>('smartApps.list')
  },
  install(
    preview: HarnessAppPreview,
    modelKey: string | null,
    source: { smartAppId: number; releaseId: number } | null = null
  ) {
    return invokeDesktopHost<HarnessAppInstallation>('smartApps.install', {
      archivePath: preview.archivePath,
      expectedSha256: preview.sha256,
      modelKey,
      smartAppId: source?.smartAppId ?? null,
      releaseId: source?.releaseId ?? null,
    })
  },
  start(
    installationId: string,
    modelBaseUrl: string | null,
    contextBaseUrl: string | null = null,
    contextToken: string | null = null
  ) {
    return observeOperation(
      'smart_app.start',
      () =>
        invokeDesktopHost<HarnessAppInstallation>('smartApps.start', {
          installationId,
          modelBaseUrl,
          contextBaseUrl,
          contextToken,
        }),
      result => result.state === 'running'
    )
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
