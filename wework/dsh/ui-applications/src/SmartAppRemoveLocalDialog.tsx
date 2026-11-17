import type { HarnessAppInstallation } from '@/api/local/harnessApps'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useTranslation } from '@/hooks/useTranslation'

interface SmartAppRemoveLocalDialogProps {
  installation: Pick<HarnessAppInstallation, 'source'> | null
  localReady: boolean
  localError: string | null
  pending: boolean
  onClose(): void
  onConfirm(): void
}

export function SmartAppRemoveLocalDialog({
  installation,
  localReady,
  localError,
  pending,
  onClose,
  onConfirm,
}: SmartAppRemoveLocalDialogProps) {
  const { t } = useTranslation('common')
  return (
    <ConfirmDialog
      open={Boolean(installation)}
      title={t('workbench.smart_apps_remove_local_title', '从本机移除工作台？')}
      description={
        <>
          {installation?.source === 'linked'
            ? t(
                'workbench.smart_apps_unlink_local_description',
                '将停止运行并从列表中移除，但不会删除工作台文件夹。'
              )
            : t(
                'workbench.smart_apps_remove_local_description',
                '将停止运行并删除本机文件。已发布版本和分享范围不会受到影响。'
              )}{' '}
          <span
            role={!localReady && localError ? 'alert' : 'status'}
            aria-atomic="true"
            className={localReady ? undefined : 'mt-2 block'}
          >
            {!localReady
              ? localError
                ? t(
                    'workbench.smart_apps_remove_local_revalidation_failed',
                    '无法重新确认本机安装状态（{{error}}）。请取消此对话框，在页面重试后再移除。'
                  ).replace('{{error}}', localError)
                : t(
                    'workbench.smart_apps_remove_local_revalidating',
                    '正在重新确认本机安装状态，确认完成前无法移除。'
                  )
              : null}
          </span>
        </>
      }
      cancelLabel={t('common.cancel', '取消')}
      confirmLabel={t('workbench.smart_apps_remove_local_confirm', '移除')}
      confirmTestId="smart-app-remove-local-confirm"
      destructive
      pending={pending}
      confirmDisabled={!localReady}
      onClose={onClose}
      onConfirm={onConfirm}
    />
  )
}
