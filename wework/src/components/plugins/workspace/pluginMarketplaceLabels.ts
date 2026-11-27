import type { PluginCatalogInput } from './pluginCatalogState'
import type { PluginMarketplaceRowLabels } from './PluginMarketplaceRow'
export function createPluginMarketplaceRowLabels(
  t: PluginCatalogInput['t']
): PluginMarketplaceRowLabels {
  return {
    install: t('workbench.plugins_install', '安装'),
    installing: t('workbench.plugins_installing', '正在安装'),
    uninstalling: t('workbench.plugins_uninstalling', '正在卸载'),
    retry: t('workbench.plugins_retry_install', '重试安装'),
    syncing: t('workbench.plugins_syncing_installation', '同步中...'),
    try: t('workbench.plugins_try_now', '立即对话'),
    manage: t('workbench.plugins_manage', '管理'),
    uninstall: t('workbench.plugins_uninstall', '卸载'),
    copy: t('workbench.plugins_copy_to_personal', '复制到我的插件'),
  }
}
