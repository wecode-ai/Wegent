import { useTranslation } from '@/hooks/useTranslation'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { useRef } from 'react'
import type { PluginUninstallScope } from '../pluginUninstall'

interface UninstallPluginDialogProps {
  pluginName: string
  scope?: PluginUninstallScope
  onCancel: () => void
  onConfirm: () => void
  confirmTestId?: string
}

export function UninstallPluginDialog({
  pluginName,
  scope = 'account',
  onCancel,
  onConfirm,
  confirmTestId = 'plugin-uninstall-confirm-button',
}: UninstallPluginDialogProps) {
  const { t } = useTranslation('common')
  const dialogRef = useRef<HTMLElement>(null)

  return (
    <div
      className="plugin-dialog-overlay fixed inset-0 z-modal flex items-center justify-center px-6"
      onClick={onCancel}
    >
      <DialogSurface
        onClose={() => {
          onCancel()
        }}
        initialFocus={'[data-testid="plugin-uninstall-cancel-button"]'}
        render={
          <section
            ref={dialogRef}
            tabIndex={-1}
            aria-labelledby="uninstall-plugin-dialog-title"
            data-testid="uninstall-plugin-dialog"
            className="plugin-dialog-surface w-full max-w-[420px] p-6"
            onClick={event => event.stopPropagation()}
          />
        }
      >
        <h2 id="uninstall-plugin-dialog-title" className="heading-subsection text-text-primary">
          {t('workbench.plugins_uninstall_plugin_title', '卸载插件？')}
        </h2>
        <p className="mt-2 text-sm leading-5 text-text-secondary">
          {t(
            scope === 'published-source'
              ? 'workbench.plugins_uninstall_published_source_description'
              : scope === 'local'
                ? 'workbench.plugins_uninstall_local_description'
                : 'workbench.plugins_uninstall_plugin_description',
            { name: pluginName }
          )}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="plugin-uninstall-cancel-button"
            className="h-9 rounded-lg px-4 text-sm font-medium text-text-secondary hover:bg-surface"
            onClick={onCancel}
          >
            {t('workbench.cancel', '取消')}
          </ControlButton>
          <ControlButton
            variant="destructive"
            size="sm"
            type="button"
            data-testid={confirmTestId}
            className="h-9 rounded-lg bg-destructive px-4 text-sm font-medium text-destructive-contrast hover:bg-destructive/90 wework:bg-red-600 wework:text-white wework:hover:bg-red-700"
            onClick={onConfirm}
          >
            {t('workbench.plugins_uninstall', '卸载')}
          </ControlButton>
        </div>
      </DialogSurface>
    </div>
  )
}
