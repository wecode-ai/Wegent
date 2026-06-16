import { isTauriRuntime } from './runtime-environment'

export interface WeworkUpdateInfo {
  currentVersion: string
  version: string
  body?: string
}

interface PendingUpdate {
  version: string
  currentVersion: string
  body?: string
  downloadAndInstall: () => Promise<void>
}

let pendingUpdate: PendingUpdate | null = null

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Unknown updater error'
}

export async function checkForWeworkUpdate(): Promise<WeworkUpdateInfo | null> {
  if (!isTauriRuntime()) {
    throw new Error('Wework updater is only available in the macOS app.')
  }

  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (!update) {
      pendingUpdate = null
      return null
    }

    pendingUpdate = {
      version: update.version,
      currentVersion: update.currentVersion,
      body: update.body,
      downloadAndInstall: () => update.downloadAndInstall(),
    }

    return {
      version: update.version,
      currentVersion: update.currentVersion,
      body: update.body,
    }
  } catch (error) {
    pendingUpdate = null
    throw new Error(errorMessage(error), { cause: error })
  }
}

export async function installPendingWeworkUpdate(): Promise<void> {
  if (!pendingUpdate) {
    throw new Error('No pending Wework update is available.')
  }

  try {
    await pendingUpdate.downloadAndInstall()
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
  } catch (error) {
    throw new Error(errorMessage(error), { cause: error })
  }
}
