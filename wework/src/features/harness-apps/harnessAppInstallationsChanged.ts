import type { HarnessAppInstallation } from '@/api/local/harnessApps'

export const HARNESS_APP_INSTALLATIONS_CHANGED_EVENT = 'wework:harness-app-installations-changed'

export type HarnessAppInstallationsChangedDetail =
  | {
      type: 'installed' | 'restored'
      installationId: string
      installation: HarnessAppInstallation
    }
  | {
      type: 'removed'
      installationId: string
    }
  | {
      type: 'stopped'
      installationId: string
    }

export function notifyHarnessAppInstallationsChanged(
  detail: HarnessAppInstallationsChangedDetail
): void {
  window.dispatchEvent(new CustomEvent(HARNESS_APP_INSTALLATIONS_CHANGED_EVENT, { detail }))
}
