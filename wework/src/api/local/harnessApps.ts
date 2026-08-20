import { invoke } from '@tauri-apps/api/core'

export interface HarnessAppManifest {
  name: string
  displayName: string
  version: string
  type: 'deepseek-harness-plugin-bundle'
  description: string
  entry: {
    installPackage: string
    profile: string
    webUrl: string
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
}

export interface HarnessAppPreview {
  valid: boolean
  archivePath: string
  sha256: string
  manifest: HarnessAppManifest | null
  issues: string[]
}

export const harnessAppsApi = {
  preview(archivePath: string) {
    return invoke<HarnessAppPreview>('preview_harness_app', { archivePath })
  },
  list() {
    return invoke<HarnessAppInstallation[]>('list_harness_apps')
  },
  install(preview: HarnessAppPreview, modelKey: string | null) {
    return invoke<HarnessAppInstallation>('install_harness_app', {
      archivePath: preview.archivePath,
      expectedSha256: preview.sha256,
      modelKey,
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
