import type { CollaborationLocale } from '../i18n'
export const pluginPickerMessages: Record<CollaborationLocale, Readonly<Record<string, string>>> = {
  'zh-CN': {
    'workbench.composer_plugins': '插件',
    'workbench.composer_plugin_search': '搜索插件',
    'workbench.composer_plugin_matches': '匹配结果',
    'workbench.composer_plugin_available': '可用插件',
    'workbench.plugins_loading_plugins': '正在加载插件',
    'workbench.composer_no_available_plugins': '当前账号没有已安装且启用的匹配插件。',
    'workbench.composer_open_plugin_marketplace': '打开插件市场',
    'workbench.composer_plugins_load_error': '加载插件失败',
    'workbench.retry': '重试',
  },
  en: {
    'workbench.composer_plugins': 'Plugins',
    'workbench.composer_plugin_search': 'Search plugins',
    'workbench.composer_plugin_matches': 'Matches',
    'workbench.composer_plugin_available': 'Available plugins',
    'workbench.plugins_loading_plugins': 'Loading plugins',
    'workbench.composer_no_available_plugins':
      'This account has no matching installed and enabled plugins.',
    'workbench.composer_open_plugin_marketplace': 'Open plugin marketplace',
    'workbench.composer_plugins_load_error': 'Failed to load plugins',
    'workbench.retry': 'Retry',
  },
}
