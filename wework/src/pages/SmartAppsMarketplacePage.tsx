import { Boxes, Download, PackageCheck, WandSparkles } from 'lucide-react'
import { SmartAppsSectionNav } from '@/components/smart-apps/SmartAppsSectionNav'
import { Button } from '@/components/ui/button'
import { queuePluginReferenceTrial } from '@/features/plugins/pluginTrial'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'

export function SmartAppsMarketplacePage() {
  const { t } = useTranslation('common')

  function createSmartApp() {
    queuePluginReferenceTrial({
      pluginName: 'smart-app-builder',
      marketplaceName: 'wework-personal',
      displayName: t('workbench.smart_apps_builder_name', '智能应用开发助手'),
      prompt: t(
        'workbench.smart_apps_builder_prompt',
        '帮我创建一个智能应用，完成 DSH 环境准备、插件检索与拼装、内置浏览器测试、打包和本机安装。'
      ),
      openInNewChat: true,
    })
    navigateTo('/')
  }

  return (
    <div data-testid="smart-apps-marketplace-page">
      <div>
        <SmartAppsSectionNav active="marketplace" />
      </div>

      <section
        data-testid="smart-apps-marketplace-empty"
        className="mt-5 flex min-h-[320px] flex-col items-center justify-center rounded-2xl border border-dashed border-border/45 bg-surface/25 px-8 py-14 text-center"
      >
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border/30 bg-background shadow-sm">
          <Boxes className="h-6 w-6 text-text-secondary" />
        </div>
        <strong className="mt-5 text-base font-medium text-text-primary">
          {t('workbench.smart_apps_marketplace_coming', '智能应用市场即将上线')}
        </strong>
        <p className="mt-2 max-w-[440px] text-sm leading-6 text-text-muted">
          {t(
            'workbench.smart_apps_marketplace_coming_hint',
            '市场内容接入前，可以先导入本地智能应用安装包；已安装应用仍可正常管理和运行。'
          )}
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Button size="sm" data-testid="smart-apps-marketplace-create" onClick={createSmartApp}>
            <WandSparkles className="h-4 w-4" />
            {t('workbench.smart_apps_create', '创建智能应用')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="smart-apps-marketplace-import"
            onClick={() => navigateTo('/sites?app_type=smart_app&view=installed&action=import')}
          >
            <Download className="h-4 w-4" />
            {t('workbench.smart_apps_import_local', '导入本地安装包')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="smart-apps-marketplace-installed"
            onClick={() => navigateTo('/sites?app_type=smart_app&view=installed')}
          >
            <PackageCheck className="h-4 w-4" />
            {t('workbench.smart_apps_view_installed', '查看已安装')}
          </Button>
        </div>
      </section>
    </div>
  )
}
