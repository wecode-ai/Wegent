import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

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
  preview(archivePath: string) {
    return invoke<HarnessAppPreview>('preview_harness_app', { archivePath })
  },
  download(input: {
    downloadUrl: string
    sha256: string
    sizeBytes: number
    smartAppId: number
    releaseId: number
  }) {
    return invoke<HarnessAppPreview>('download_harness_app_package', {
      downloadUrl: input.downloadUrl,
      expectedSha256: input.sha256,
      expectedSize: input.sizeBytes,
      smartAppId: input.smartAppId,
      releaseId: input.releaseId,
    })
  },
  export(installationId: string) {
    return invoke<HarnessAppExport>('export_harness_app_package', { installationId })
  },
  async exportToDownloads(installationId: string): Promise<HarnessAppSavedExport> {
    const exported = await invoke<HarnessAppExport>('export_harness_app_package', {
      installationId,
    })
    const destinationPath = await invoke<string>('download_local_file_to_downloads', {
      sourcePath: exported.archivePath,
      filename: `${exported.manifest.name}-${exported.manifest.version}.zip`,
    })
    return { ...exported, destinationPath }
  },
  upload(archivePath: string, uploadUrl: string) {
    return invoke<void>('upload_harness_app_package', { archivePath, uploadUrl })
  },
  list() {
    return invoke<HarnessAppInstallation[]>('list_harness_apps')
  },
  install(
    preview: HarnessAppPreview,
    modelKey: string | null,
    source: { smartAppId: number; releaseId: number } | null = null
  ) {
    return invoke<HarnessAppInstallation>('install_harness_app', {
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
    return invoke<HarnessAppInstallation>('start_harness_app', {
      installationId,
      modelBaseUrl,
      contextBaseUrl,
      contextToken,
    })
  },
  stop(installationId: string) {
    return invoke<void>('stop_harness_app', { installationId })
  },
  update(installationId: string, updates: { modelKey?: string; resident?: boolean }) {
    return invoke<HarnessAppInstallation>('update_harness_app', {
      installationId,
      ...updates,
    })
  },
  delete(installationId: string, deleteData = false) {
    return invoke<void>('delete_harness_app', { installationId, deleteData })
  },
}

export function listenHarnessAppLaunchProgress(
  callback: (progress: HarnessAppLaunchProgress) => void
): Promise<UnlistenFn> {
  return listen<HarnessAppLaunchProgress>(HARNESS_APP_LAUNCH_PROGRESS_EVENT, event => {
    callback(event.payload)
  })
}
