import { useEffect, useRef } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { PluginDeleteImpactResponse } from '@/types/api'

interface DeletePersonalPluginDialogProps {
  pluginName: string
  installed: boolean
  published: boolean
  publicationActive?: boolean
  impact: PluginDeleteImpactResponse | null
  deleting: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function DeletePersonalPluginDialog({
  pluginName,
  installed,
  published,
  publicationActive = false,
  impact,
  deleting,
  onCancel,
  onConfirm,
}: DeletePersonalPluginDialogProps) {
  const { t } = useTranslation('common')
  const cancelRef = useRef<HTMLButtonElement>(null)
  const requiresRevocation = Boolean(
    impact && (impact.affectedUserCount > 0 || impact.sharedTargetCount > 0)
  )

  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !deleting) onCancel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [deleting, onCancel])

  return (
    <div
      className="plugin-dialog-overlay fixed inset-0 z-modal flex items-center justify-center px-6"
      onClick={() => {
        if (!deleting) onCancel()
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-personal-plugin-dialog-title"
        data-testid="delete-personal-plugin-dialog"
        className="plugin-dialog-surface w-full max-w-[420px] p-6"
        onClick={event => event.stopPropagation()}
      >
        <h2
          id="delete-personal-plugin-dialog-title"
          className="heading-subsection text-text-primary"
        >
          {t('workbench.plugins_delete_plugin_title', '删除插件？')}
        </h2>
        <p className="mt-2 text-sm leading-5 text-text-secondary">
          {publicationActive
            ? t('workbench.plugins_delete_active_publication_description', {
                name: pluginName,
                defaultValue: `「${pluginName}」仍有进行中的企业全员发布申请。确认后会先撤回申请并关闭尚未合并的 MR；只有撤回成功才会继续删除个人插件。已发布的企业版本不受影响。`,
              })
            : published && !impact
              ? t('workbench.plugins_delete_impact_loading', '正在检查插件的使用情况…')
              : published && impact && requiresRevocation
                ? t('workbench.plugins_delete_published_plugin_in_use_description', {
                    name: pluginName,
                    userCount: impact.affectedUserCount,
                    deviceCount: impact.installedDeviceCount,
                    sharedTargetCount: impact.sharedTargetCount,
                    defaultValue: `「${pluginName}」当前有 ${impact.affectedUserCount} 位其他用户安装，涉及 ${impact.installedDeviceCount} 台设备，并分享给 ${impact.sharedTargetCount} 个对象。删除后将立即停止分享，在线设备会自动卸载，离线设备将在下次上线时清理。正在执行的任务不会被强制中断。`,
                  })
                : published
                  ? t('workbench.plugins_delete_published_plugin_description', {
                      name: pluginName,
                      defaultValue: `将删除云端插件「${pluginName}」及其分享关系，并清理本地插件。此操作无法撤销。`,
                    })
                  : installed
                    ? t('workbench.plugins_delete_plugin_installed_description', {
                        name: pluginName,
                        defaultValue: `将先卸载「${pluginName}」，再永久删除本地插件源码。此操作无法撤销。`,
                      })
                    : t('workbench.plugins_delete_plugin_description', {
                        name: pluginName,
                        defaultValue: `将永久删除「${pluginName}」的本地插件源码。此操作无法撤销。`,
                      })}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            disabled={deleting}
            data-testid="plugin-delete-cancel-button"
            className="h-9 rounded-lg px-4 text-sm font-medium text-text-secondary hover:bg-surface disabled:opacity-40"
            onClick={onCancel}
          >
            {t('workbench.cancel', '取消')}
          </button>
          <button
            type="button"
            disabled={deleting || (published && !impact)}
            data-testid="plugin-delete-confirm-button"
            className="h-9 rounded-lg bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40"
            onClick={onConfirm}
          >
            {deleting
              ? t('workbench.plugins_deleting_plugin', '正在删除')
              : publicationActive
                ? t('workbench.plugins_withdraw_and_delete', '撤回申请并删除')
                : published && requiresRevocation
                  ? t('workbench.plugins_revoke_and_delete', '停用并删除')
                  : t('workbench.plugins_delete_plugin', '删除插件')}
          </button>
        </div>
      </section>
    </div>
  )
}
