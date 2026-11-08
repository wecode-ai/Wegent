import type { useTranslation } from '@/hooks/useTranslation'
import type { AppUpdateError, AppUpdateErrorKind, AppUpdateErrorStage } from './app-update-error'

type Translate = ReturnType<typeof useTranslation>['t']

export function formatAppUpdateErrorSummary(error: AppUpdateError, t: Translate): string {
  if (error.kind === 'path-unavailable') return t('workbench.app_update_path_unavailable')
  if (error.kind === 'unsupported') {
    return t('workbench.app_update_endpoint_missing', {
      defaultValue: '当前版本暂不支持自动更新检查',
    })
  }

  if (error.kind === 'network') {
    if (error.stage === 'download') {
      return t('workbench.app_update_network_download_failed', {
        defaultValue: '网络不可用，更新未能下载',
      })
    }
    if (error.stage === 'install') {
      return t('workbench.app_update_network_install_failed', {
        defaultValue: '网络不可用，更新未能安装',
      })
    }
    if (error.stage !== 'check') return t('workbench.app_update_network_preparation_failed')
    return t('workbench.app_update_network_check_failed', {
      defaultValue: '网络不可用，无法检查更新',
    })
  }

  const messages = {
    check: 'workbench.app_update_check_failed',
    download: 'workbench.app_update_download_failed',
    extract: 'workbench.app_update_extract_failed',
    verify: 'workbench.app_update_verify_failed',
    prepare: 'workbench.app_update_prepare_failed',
    install: 'workbench.app_update_install_failed',
  } as const
  return t(messages[error.stage])
}

export function formatAppUpdateErrorType(kind: AppUpdateErrorKind, t: Translate): string {
  if (kind === 'network') {
    return t('workbench.app_update_error_type_network', {
      defaultValue: '网络连接失败',
    })
  }
  if (kind === 'unsupported') {
    return t('workbench.app_update_error_type_unavailable', {
      defaultValue: '功能不可用',
    })
  }
  return t('workbench.app_update_error_type_generic', {
    defaultValue: '更新失败',
  })
}

export function formatAppUpdateErrorFeature(stage: AppUpdateErrorStage, t: Translate): string {
  const messages = {
    check: 'workbench.app_update_error_feature_check',
    download: 'workbench.app_update_error_feature_download',
    extract: 'workbench.app_update_error_feature_extract',
    verify: 'workbench.app_update_error_feature_verify',
    prepare: 'workbench.app_update_error_feature_prepare',
    install: 'workbench.app_update_error_feature_install',
  } as const
  return t(messages[stage])
}
