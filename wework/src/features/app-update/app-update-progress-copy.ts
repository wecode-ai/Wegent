import type { useTranslation } from '@/hooks/useTranslation'
import type { WeworkUpdateDownloadProgress } from '@/lib/app-updater'
import { calculateAppUpdateDownloadPercent } from './app-update-format'

type Translate = ReturnType<typeof useTranslation>['t']

export function formatAppUpdateProgress(
  progress: WeworkUpdateDownloadProgress | null,
  t: Translate
): string {
  const phase = progress?.phase
  let message: string
  if (phase === 'preparing') {
    message = t('workbench.app_update_preparing', { defaultValue: '正在准备更新' })
  } else if (phase === 'components') {
    message = t('workbench.app_update_components', {
      defaultValue: '正在下载组件 {{completed}}/{{total}}',
      completed: progress?.completedComponents ?? 0,
      total: progress?.totalComponents ?? 0,
    })
  } else if (phase === 'verifying') {
    message = t('workbench.app_update_verifying', { defaultValue: '正在验证更新' })
  } else if (phase === 'ready') {
    message = t('workbench.app_update_ready', { defaultValue: '更新已就绪，可以重启安装' })
  } else if (progress?.reason === 'differential-failed') {
    message = t('workbench.app_update_full_after_failure', {
      defaultValue: '增量更新校验失败，正在下载完整更新',
    })
  } else {
    const percent = progress
      ? calculateAppUpdateDownloadPercent(progress.downloadedBytes, progress.totalBytes)
      : null
    message =
      percent === null
        ? t('workbench.app_update_downloading', { defaultValue: '正在下载更新' })
        : t('workbench.app_update_downloading_progress', {
            defaultValue: '正在下载更新 {{progress}}%',
            progress: percent,
          }).replace('{{progress}}', String(percent))
  }
  if (!phase) return message
  const bytes = (progress.downloadedBytes / 1024 / 1024).toFixed(1)
  return `${message} · ${t('workbench.app_update_received', { defaultValue: '已下载 {{size}} MiB', size: bytes })}`
}
