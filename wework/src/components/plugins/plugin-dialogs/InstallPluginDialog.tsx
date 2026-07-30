import { Boxes, Loader2 } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

export interface InstallPluginDialogTarget {
  id: string | number
  name: string
  publisher?: string | null
  version?: string | null
  logoUrl?: string | null
  componentCount: number
}

interface InstallPluginDialogProps {
  plugin: InstallPluginDialogTarget
  phase: 'confirm' | 'installing' | 'success'
  onCancel: () => void
  onConfirm: () => void
  onDone?: () => void
  onConnect?: () => void
}

export function InstallPluginDialog({
  plugin,
  phase,
  onCancel,
  onConfirm,
  onDone,
  onConnect,
}: InstallPluginDialogProps) {
  const { t } = useTranslation('common')
  const confirmRef = useRef<HTMLButtonElement>(null)
  const logo = plugin.logoUrl?.trim() || ''

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
        className={`plugin-dialog-surface w-full overflow-hidden ${
          phase === 'success' ? 'max-w-[420px]' : 'max-w-[600px]'
        }`}
        onClick={event => event.stopPropagation()}
      >
        {phase === 'success' ? (
          <div className="px-6 py-8 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
              <Boxes className="h-6 w-6" />
            </div>
            <h2 id="install-plugin-dialog-title" className="heading-subsection text-text-primary">
              {t('workbench.plugins_install_success_title', '{{name}} 已安装', {
                name: plugin.name,
                defaultValue: `${plugin.name} 已安装`,
              })}
            </h2>
            <p className="mt-2 text-sm leading-5 text-text-secondary">
              {t(
                'workbench.plugins_install_success_hint',
                '账号授权仍独立进行，可在需要连接时单独授权。'
              )}
            </p>
            <div className="mt-6 flex justify-center gap-2">
              {onConnect && (
                <button
                  type="button"
                  data-testid="install-plugin-dialog-connect"
                  className="h-9 rounded-lg bg-surface px-4 text-sm font-medium hover:bg-muted"
                  onClick={onConnect}
                >
                  {t('workbench.plugins_connect_account', '连接账号')}
                </button>
              )}
              <button
                type="button"
                data-testid="install-plugin-dialog-done"
                className="h-9 rounded-lg bg-text-primary px-4 text-sm font-medium text-background hover:bg-text-primary/90"
                onClick={onDone ?? onCancel}
              >
                {t('workbench.plugins_done', '完成')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="plugin-dialog-divider border-b px-6 py-5">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border border-border/30 bg-background">
                  {logo ? (
                    <img src={logo} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <Boxes className="h-5 w-5 text-text-muted" />
                  )}
                </div>
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
                <li>
                  {t('workbench.plugins_install_gain_components', {
                    count: plugin.componentCount,
                    defaultValue: `获得 ${plugin.componentCount} 项内部能力`,
                  })}
                </li>
                <li>{t('workbench.plugins_install_gain_all_chats', '所有对话可用')}</li>
                <li>{t('workbench.plugins_install_gain_auth_separate', '外部账号按需另行授权')}</li>
              </ul>
            </div>
            <div className="plugin-dialog-divider flex justify-end gap-2 border-t px-6 py-4">
              <button
                type="button"
                data-testid="install-plugin-dialog-cancel"
                className="h-9 rounded-lg px-4 text-sm font-medium text-text-secondary hover:bg-surface"
                onClick={onCancel}
                disabled={phase === 'installing'}
              >
                {t('workbench.cancel', '取消')}
              </button>
              <button
                ref={confirmRef}
                type="button"
                data-testid="install-plugin-dialog-confirm"
                className="flex h-9 items-center gap-2 rounded-lg bg-text-primary px-4 text-sm font-medium text-background hover:bg-text-primary/90 disabled:opacity-60"
                onClick={onConfirm}
                disabled={phase === 'installing'}
              >
                {phase === 'installing' && (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                )}
                {phase === 'installing'
                  ? t('workbench.plugins_installing', '正在安装')
                  : t('workbench.plugins_install_plugin', '安装插件')}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  )
}
