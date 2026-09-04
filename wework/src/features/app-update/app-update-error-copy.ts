import type { useTranslation } from '@/hooks/useTranslation'
import type { AppUpdateError, AppUpdateErrorKind, AppUpdateErrorStage } from './app-update-error'

type Translate = ReturnType<typeof useTranslation>['t']

export function formatAppUpdateErrorSummary(error: AppUpdateError, t: Translate): string {
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
    return t('workbench.app_update_network_check_failed', {
      defaultValue: '网络不可用，无法检查更新',
    })
  }

  if (error.stage === 'download') {
    return t('workbench.app_update_download_failed', {
      defaultValue: '更新下载失败',
    })
  }
  if (error.stage === 'install') {
    return t('workbench.app_update_install_failed', {
      defaultValue: '更新安装失败',
    })
  }
  return t('workbench.app_update_check_failed', {
    defaultValue: '检查更新失败',
  })
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
  if (stage === 'download') {
    return t('workbench.app_update_error_feature_download', {
      defaultValue: '下载应用更新',
    })
  }
  if (stage === 'install') {
    return t('workbench.app_update_error_feature_install', {
      defaultValue: '安装应用更新',
    })
  }
  return t('workbench.app_update_error_feature_check', {
    defaultValue: '检查应用更新',
  })
}
