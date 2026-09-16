import type { useTranslation } from '@/hooks/useTranslation'
import { prerelease } from 'semver'
import type { AppUpdateContextValue } from './app-update-context'
import { formatAppUpdateErrorSummary } from './app-update-error-copy'
import { formatAppUpdateProgress } from './app-update-progress-copy'

type Translate = ReturnType<typeof useTranslation>['t']
type UpdateState = Pick<
  AppUpdateContextValue,
  | 'availableUpdate'
  | 'status'
  | 'error'
  | 'downloadProgress'
  | 'isUpdateReady'
  | 'currentVersion'
  | 'updateChannel'
>

export function getAppUpdateCopy(state: UpdateState | null, t: Translate) {
  const update = state?.availableUpdate
  const text = (key: string) => t(`workbench.app_update_${key}`, { version: update?.version ?? '' })
  if (state?.status === 'checking') {
    return { action: text('checking_action'), message: text('checking') }
  }
  if (state?.status === 'downloading') {
    return {
      action: text('downloading_action'),
      message: formatAppUpdateProgress(state.downloadProgress, t),
    }
  }
  if (state?.status === 'installing') {
    return { action: text('installing_short'), message: text('installing') }
  }
  if (state?.error) {
    return {
      action: text(
        state.error.stage === 'check' || !update
          ? 'retry_check'
          : state.error.kind === 'verification'
            ? 'redownload'
            : state.error.stage === 'download'
              ? 'retry_download'
              : 'retry_install'
      ),
      message: formatAppUpdateErrorSummary(state.error, t),
    }
  }
  if (update) {
    if (state?.isUpdateReady) {
      const downgrade = update.kind === 'downgrade-to-stable'
      return {
        action: text(downgrade ? 'restart_return_action' : 'restart_confirm_action'),
        message: text(downgrade ? 'return_ready' : 'upgrade_ready'),
      }
    }
    const key = update.kind.replaceAll('-', '_')
    return { action: text(`${key}_action`), message: text(`${key}_available`) }
  }
  const noStable =
    state?.status === 'upToDate' &&
    state.updateChannel === 'stable' &&
    state.currentVersion &&
    prerelease(state.currentVersion) !== null
  return {
    action: text(noStable ? 'retry_check' : 'check'),
    message: text(noStable ? 'no_stable' : state?.status === 'upToDate' ? 'up_to_date' : 'idle'),
  }
}
