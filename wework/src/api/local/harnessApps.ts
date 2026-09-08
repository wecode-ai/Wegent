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

export const harnessAppsApi = {
  createDirectory(input: {
    parentPath: string
    name: string
    displayName: string
    description: string
  }) {
    return invokeDesktopHost<HarnessAppInstallation>('smartApps.createDirectory', input)
  },
  linkDirectory(directoryPath: string) {
    return invokeDesktopHost<HarnessAppInstallation>('smartApps.linkDirectory', { directoryPath })
  },
  addPlugin(installationId: string, pluginSpec: string) {
    return invokeDesktopHost<HarnessAppInstallation>('smartApps.addPlugin', {
      installationId,
      pluginSpec,
    })
  },
  copyToDirectory(
    installationId: string,
    input: { parentPath: string; name: string; displayName: string }
  ) {
    return invokeDesktopHost<HarnessAppInstallation>('smartApps.copyToDirectory', {
      installationId,
      ...input,
    })
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
  async exportToDownloads(installationId: string): Promise<HarnessAppSavedExport> {
    return invokeDesktopHost<HarnessAppSavedExport>('smartApps.exportToDownloads', {
      installationId,
    })
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
    return invokeDesktopHost<HarnessAppInstallation>('smartApps.start', {
      installationId,
      modelBaseUrl,
      contextBaseUrl,
      contextToken,
    })
  },
  stop(installationId: string) {
    return invokeDesktopHost<void>('smartApps.stop', { installationId })
  },
  update(installationId: string, updates: { modelKey?: string; resident?: boolean }) {
    return invokeDesktopHost<HarnessAppInstallation>('smartApps.update', {
      installationId,
      ...updates,
    })
  },
  delete(installationId: string, deleteData = false) {
    return invokeDesktopHost<void>('smartApps.delete', { installationId, deleteData })
  },
}

export function listenHarnessAppLaunchProgress(
  callback: (progress: HarnessAppLaunchProgress) => void
): Promise<UnlistenFn> {
  void callback
  return Promise.resolve(() => undefined)
}
