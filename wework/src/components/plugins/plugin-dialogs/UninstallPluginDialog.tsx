import { useEffect, useRef } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

interface UninstallPluginDialogProps {
  pluginName: string
  onCancel: () => void
  onConfirm: () => void
  confirmTestId?: string
}

export function UninstallPluginDialog({
  pluginName,
  onCancel,
  onConfirm,
  confirmTestId = 'plugin-uninstall-confirm-button',
}: UninstallPluginDialogProps) {
  const { t } = useTranslation('common')
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  return (
    <div
      className="plugin-dialog-overlay fixed inset-0 z-modal flex items-center justify-center px-6"
      onClick={onCancel}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="uninstall-plugin-dialog-title"
        data-testid="uninstall-plugin-dialog"
        className="plugin-dialog-surface w-full max-w-[420px] p-6"
        onClick={event => event.stopPropagation()}
      >
        <h2 id="uninstall-plugin-dialog-title" className="heading-subsection text-text-primary">
          {t('workbench.plugins_uninstall_plugin_title', '卸载插件？')}
        </h2>
        <p className="mt-2 text-sm leading-5 text-text-secondary">
          {t(
            'workbench.plugins_uninstall_plugin_description',
            '{{name}} 将从当前账号和本机卸载，并清除本机登录态与运行时安装记录；市场仍可重新安装。',
            {
              name: pluginName,
              defaultValue: `${pluginName} 将从当前账号和本机卸载，并清除本机登录态与运行时安装记录；市场仍可重新安装。`,
            }
          )}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            data-testid="plugin-uninstall-cancel-button"
            className="h-9 rounded-lg px-4 text-sm font-medium text-text-secondary hover:bg-surface"
            onClick={onCancel}
          >
            {t('workbench.cancel', '取消')}
          </button>
          <button
            type="button"
            data-testid={confirmTestId}
            className="h-9 rounded-lg bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700"
            onClick={onConfirm}
          >
            {t('workbench.plugins_uninstall', '卸载')}
          </button>
        </div>
      </section>
    </div>
  )
}
