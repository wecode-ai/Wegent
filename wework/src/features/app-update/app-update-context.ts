import { createContext, useContext } from 'react'
import type {
  WeworkUpdateChannel,
  WeworkUpdateDownloadProgress,
  WeworkUpdateInfo,
} from '@/lib/app-updater'
import type { WeworkInstalledReleaseNotes } from './app-release-notes'

export const APP_UPDATE_LAST_AUTO_CHECK_KEY = 'wework:lastAutoUpdateCheckAt'
export const APP_UPDATE_CHANNEL_KEY = 'wework:updateChannel'
export const APP_UPDATE_INITIAL_CHECK_DELAY_MS = 5_000
export const APP_UPDATE_TIMER_INTERVAL_MS = 60 * 60 * 1000
export const APP_UPDATE_AUTO_CHECK_MIN_AGE_MS = 24 * 60 * 60 * 1000
export const APP_UPDATE_SIMULATE_EVENT = 'wework:simulate-app-update'

export type AppUpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'upToDate'
  | 'installing'
  | 'error'

export interface AppUpdateContextValue {
  updateChannel: WeworkUpdateChannel
  availableUpdate: WeworkUpdateInfo | null
  installedReleaseNotes: WeworkInstalledReleaseNotes | null
  status: AppUpdateStatus
  downloadProgress: WeworkUpdateDownloadProgress | null
  message: string | null
  error: string | null
  checkNow: () => Promise<WeworkUpdateInfo | null>
  installUpdate: () => Promise<void>
  dismissInstalledReleaseNotes: () => void
  setUpdateChannel: (channel: WeworkUpdateChannel) => Promise<void>
}

export const AppUpdateContext = createContext<AppUpdateContextValue | null>(null)

export function useAppUpdate() {
  const context = useContext(AppUpdateContext)
  if (!context) {
    throw new Error('useAppUpdate must be used within AppUpdateProvider')
  }
  return context
}

export function useOptionalAppUpdate() {
  return useContext(AppUpdateContext)
}
