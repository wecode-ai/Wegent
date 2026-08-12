import { useEffect, useRef } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { PluginDistribution } from '../pluginDistribution'
import { PluginSourceAvatar } from '../PluginSourceAvatar'

export interface InstallPluginDialogTarget {
  id: string | number
  name: string
  publisher?: string | null
  version?: string | null
  logoUrl?: string | null
  logoContrastPad?: boolean
  useLogoInitial?: boolean
  logoDistribution?: PluginDistribution
  componentCount: number
  requiredConnectionNames?: string[]
}

interface InstallPluginDialogProps {
  plugin: InstallPluginDialogTarget
  onCancel: () => void
  onConfirm: () => void
}

export function InstallPluginDialog({ plugin, onCancel, onConfirm }: InstallPluginDialogProps) {
  const { t } = useTranslation('common')
  const confirmRef = useRef<HTMLButtonElement>(null)
  const logo = plugin.logoUrl?.trim() || ''
  const useInitial = Boolean(plugin.useLogoInitial) || !logo
  const requiredConnectionNames = plugin.requiredConnectionNames ?? []
  const requiredConnectionName =
    requiredConnectionNames.length === 1 ? requiredConnectionNames[0]?.trim() || null : null

  useEffect(() => {
    confirmRef.current?.focus()
  }, [])

  return (
    <div
      className="plugin-dialog-overlay fixed inset-0 z-modal flex items-center justify-center px-6"
      onClick={onCancel}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-plugin-dialog-title"
        data-testid="install-plugin-dialog"
        className="plugin-dialog-surface w-full max-w-[480px] overflow-hidden"
        onClick={event => event.stopPropagation()}
      >
        <div className="plugin-dialog-divider border-b px-6 py-5">
          <div className="flex items-center gap-3">
            <PluginSourceAvatar
              className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border border-border/30 bg-background"
              contrastPad={plugin.logoContrastPad}
              distribution={plugin.logoDistribution}
              logoUrl={logo}
              name={plugin.name}
              useInitial={useInitial}
            />
            <div>
              <h2 id="install-plugin-dialog-title" className="heading-subsection">
                {t('workbench.plugins_install_plugin', '安装插件')}
              </h2>
              <p className="text-sm text-text-secondary">
                {t('workbench.plugins_install_scope_hint', '安装到当前账号，不绑定项目。')}
              </p>
            </div>
          </div>
        </div>
        <div className="space-y-3 px-6 py-5 text-sm leading-5 text-text-secondary">
          <p>
            <strong className="text-text-primary">{plugin.name}</strong>
            {(plugin.publisher || plugin.version) && (
              <span className="text-text-muted">
                {' '}
                ·{' '}
                {[plugin.publisher, plugin.version ? `v${plugin.version}` : '']
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )}
          </p>
          <ul className="list-disc space-y-1 pl-5">
            {plugin.componentCount > 0 && (
              <li>
                {t('workbench.plugins_install_gain_components', {
                  count: plugin.componentCount,
                  defaultValue: `包含 ${plugin.componentCount} 项能力`,
                })}
              </li>
            )}
            <li>{t('workbench.plugins_install_gain_all_chats', '所有对话可用')}</li>
            {requiredConnectionNames.length > 0 && (
              <li>
                {requiredConnectionName
                  ? t('workbench.plugins_install_connection_required_named', {
                      name: requiredConnectionName,
                      defaultValue: `需要连接 ${requiredConnectionName}`,
                    })
                  : t('workbench.plugins_install_connection_required', '需要连接所需应用')}
              </li>
            )}
          </ul>
        </div>
        <div className="plugin-dialog-divider flex justify-end gap-2 border-t px-6 py-4">
          <button
            type="button"
            data-testid="install-plugin-dialog-cancel"
            className="h-9 rounded-lg px-4 text-sm font-medium text-text-secondary hover:bg-surface"
            onClick={onCancel}
          >
            {t('workbench.cancel', '取消')}
          </button>
          <button
            ref={confirmRef}
            type="button"
            data-testid="install-plugin-dialog-confirm"
            className="flex h-9 items-center gap-2 rounded-lg bg-text-primary px-4 text-sm font-medium text-background hover:bg-text-primary/90"
            onClick={onConfirm}
          >
            {requiredConnectionNames.length > 0
              ? requiredConnectionName
                ? t('workbench.plugins_install_and_connect_named', {
                    name: requiredConnectionName,
                    defaultValue: `安装并连接 ${requiredConnectionName}`,
                  })
                : t('workbench.plugins_install_and_connect', '安装并连接')
              : t('workbench.plugins_install_plugin', '安装插件')}
          </button>
        </div>
      </section>
    </div>
  )
}
