import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '@/hooks/useTranslation'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import {
  openAppshotsPermissionSettings,
  subscribeToAppshots,
  type AppshotPermission,
} from '@/tauri/appshots'

interface AppshotBridgeProps {
  onOpenWework: () => void
}

export function AppshotBridge({ onOpenWework }: AppshotBridgeProps) {
  const { t } = useTranslation('common')
  const { addExistingAttachment } = useWorkbench().projectChat
  const [permissionRequired, setPermissionRequired] = useState<AppshotPermission | null>(null)

  useEffect(() => {
    let active = true
    let unlisten: (() => void) | undefined

    subscribeToAppshots(
      attachments => {
        if (!active) return
        onOpenWework()
        attachments.forEach(attachment => addExistingAttachment(attachment))
      },
      permission => {
        if (!active) return
        onOpenWework()
        setPermissionRequired(permission)
      }
    )
      .then(dispose => {
        if (active) {
          unlisten = dispose
        } else {
          dispose()
        }
      })
      .catch(error => {
        console.error('[Wework] Failed to initialize Appshots:', error)
      })

    return () => {
      active = false
      unlisten?.()
    }
  }, [addExistingAttachment, onOpenWework])

  if (!permissionRequired) return null

  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="appshots-permission-title"
        data-testid="appshots-permission-dialog"
        className="w-full max-w-[420px] rounded-lg border border-border bg-popover p-5 text-text-primary shadow-2xl"
      >
        <h2 id="appshots-permission-title" className="text-base font-semibold">
          {permissionRequired === 'accessibility'
            ? t('workbench.appshots_accessibility_permission_title', '允许 Wework 读取窗口文本')
            : t('workbench.appshots_permission_title', '允许 Wework 录制屏幕')}
        </h2>
        <p className="mt-2 text-sm leading-[18px] text-text-secondary">
          {permissionRequired === 'accessibility'
            ? t(
                'workbench.appshots_accessibility_permission_description',
                '应用快照需要 macOS 辅助功能权限，才能读取窗口中可用的文本，包括应用暴露的滚动区域外文本。授权后请重新启动 Wework。'
              )
            : t(
                'workbench.appshots_permission_description',
                '应用快照需要 macOS 的屏幕与系统录制权限。授权后请重新启动 Wework，再按一次快捷键。'
              )}
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            data-testid="appshots-permission-cancel-button"
            onClick={() => setPermissionRequired(null)}
            className="h-11 min-w-[44px] rounded-md border border-border px-4 text-sm font-medium hover:bg-muted"
          >
            {t('common.cancel', '取消')}
          </button>
          <button
            type="button"
            data-testid="appshots-open-permission-settings-button"
            onClick={() => {
              void openAppshotsPermissionSettings(permissionRequired).catch(error => {
                console.error('[Wework] Failed to open screen capture settings:', error)
              })
            }}
            className="h-11 min-w-[44px] rounded-md bg-text-primary px-4 text-sm font-medium text-background hover:bg-text-primary/90"
          >
            {t('workbench.appshots_open_permission_settings', '打开系统设置')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
