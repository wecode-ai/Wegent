import { AlertTriangle } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

export function PluginInstallWarning() {
  const { t } = useTranslation('common')
  return (
    <div
      data-testid="plugin-install-unofficial-warning"
      className="flex items-start gap-2 rounded-lg bg-orange-500/10 p-3 text-sm text-text-primary"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-orange-600" aria-hidden="true" />
      <div>
        <p className="font-medium">
          {t('workbench.plugins_install_unofficial_title', '非官方插件提醒')}
        </p>
        <p className="mt-1 text-text-secondary">
          {t(
            'workbench.plugins_install_unofficial_description',
            '此插件并非官方插件，可能执行代码、访问本机文件或向外部服务发送数据。请确认你信任插件来源后再安装。'
          )}
        </p>
      </div>
    </div>
  )
}
