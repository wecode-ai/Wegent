import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isElectronRuntime } from '@/lib/runtime-environment'

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

export const harnessAppsApi = {
  preview(archivePath: string) {
    if (isElectronRuntime()) {
      return invokeDesktopHost<HarnessAppPreview>('smartApps.preview', { archivePath })
    }
    return invoke<HarnessAppPreview>('preview_harness_app', { archivePath })
  },
  download(input: {
    downloadUrl: string
    sha256: string
    sizeBytes: number
    smartAppId: number
    releaseId: number
  }) {
    if (isElectronRuntime()) {
      return invokeDesktopHost<HarnessAppPreview>('smartApps.download', input)
    }
    return invoke<HarnessAppPreview>('download_harness_app_package', {
      downloadUrl: input.downloadUrl,
      expectedSha256: input.sha256,
      expectedSize: input.sizeBytes,
      smartAppId: input.smartAppId,
      releaseId: input.releaseId,
    })
  },
  export(installationId: string) {
    if (isElectronRuntime()) {
      return invokeDesktopHost<HarnessAppExport>('smartApps.export', { installationId })
    }
    return invoke<HarnessAppExport>('export_harness_app_package', { installationId })
  },
  upload(archivePath: string, uploadUrl: string) {
    if (isElectronRuntime()) {
      return invokeDesktopHost<void>('smartApps.upload', { archivePath, uploadUrl })
    }
    return invoke<void>('upload_harness_app_package', { archivePath, uploadUrl })
  },
  list() {
    if (isElectronRuntime()) {
      return invokeDesktopHost<HarnessAppInstallation[]>('smartApps.list')
    }
    return invoke<HarnessAppInstallation[]>('list_harness_apps')
  },
  install(
    preview: HarnessAppPreview,
    modelKey: string | null,
    source: { smartAppId: number; releaseId: number } | null = null
  ) {
    if (isElectronRuntime()) {
      return invokeDesktopHost<HarnessAppInstallation>('smartApps.install', {
        archivePath: preview.archivePath,
        expectedSha256: preview.sha256,
        modelKey,
        smartAppId: source?.smartAppId ?? null,
        releaseId: source?.releaseId ?? null,
      })
    }
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
    if (isElectronRuntime()) {
      return invokeDesktopHost<HarnessAppInstallation>('smartApps.start', {
        installationId,
        modelBaseUrl,
        contextBaseUrl,
        contextToken,
      })
    }
    return invoke<HarnessAppInstallation>('start_harness_app', {
      installationId,
      modelBaseUrl,
      contextBaseUrl,
      contextToken,
    })
  },
  stop(installationId: string) {
    if (isElectronRuntime()) {
      return invokeDesktopHost<void>('smartApps.stop', { installationId })
    }
    return invoke<void>('stop_harness_app', { installationId })
  },
  update(installationId: string, updates: { modelKey?: string; resident?: boolean }) {
    if (isElectronRuntime()) {
      return invokeDesktopHost<HarnessAppInstallation>('smartApps.update', {
        installationId,
        ...updates,
      })
    }
    return invoke<HarnessAppInstallation>('update_harness_app', {
      installationId,
      ...updates,
    })
  },
  delete(installationId: string, deleteData = false) {
    if (isElectronRuntime()) {
      return invokeDesktopHost<void>('smartApps.delete', { installationId, deleteData })
    }
    return invoke<void>('delete_harness_app', { installationId, deleteData })
  },
}

export function listenHarnessAppLaunchProgress(
  callback: (progress: HarnessAppLaunchProgress) => void
): Promise<UnlistenFn> {
  if (isElectronRuntime()) {
    return Promise.resolve(() => {})
  }
  return listen<HarnessAppLaunchProgress>(HARNESS_APP_LAUNCH_PROGRESS_EVENT, event => {
    callback(event.payload)
  })
}
