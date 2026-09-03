window.__ModuleLoader__.load({
  id: '@wegent/dsh-ui-core-settings',
  factory: () => {
    const personal = {
      category: 'personal',
      categoryLabelKey: 'settings_category_personal',
      categoryLabel: '个人',
    }
    const integrations = {
      category: 'integrations',
      categoryLabelKey: 'settings_category_integrations',
      categoryLabel: '集成',
    }
    const coding = {
      category: 'coding',
      categoryLabelKey: 'settings_category_coding',
      categoryLabel: '编码',
    }
    const archived = {
      category: 'archived',
      categoryLabelKey: 'settings_category_archived',
      categoryLabel: '已归档',
    }
    const pages = [
      {
        id: 'general',
        path: '/settings',
        icon: 'sliders-horizontal',
        labelKey: 'settings_nav_general',
        label: '通用',
        ...personal,
      },
      {
        id: 'connections',
        path: '/settings/connections',
        icon: 'globe-2',
        labelKey: 'settings_nav_connections',
        label: '云端连接',
        ...personal,
      },
      {
        id: 'appearance',
        path: '/settings/appearance',
        icon: 'palette',
        labelKey: 'settings_nav_appearance',
        label: '外观',
        ...personal,
      },
      {
        id: 'context',
        path: '/settings/personal/context',
        icon: 'terminal',
        labelKey: 'settings_nav_context',
        label: '上下文',
        ...personal,
      },
      {
        id: 'model-settings',
        path: '/settings/personal/models',
        aliases: ['/settings/personal'],
        icon: 'user-round',
        labelKey: 'settings_nav_model_settings',
        label: '模型',
        ...personal,
      },
      {
        id: 'proxy',
        path: '/settings/personal/proxy',
        icon: 'network',
        labelKey: 'settings_nav_proxy',
        label: '代理',
        ...personal,
      },
      {
        id: 'keyboard-shortcuts',
        path: '/settings/personal/keyboard-shortcuts',
        icon: 'keyboard',
        labelKey: 'settings_nav_keyboard_shortcuts',
        label: '快捷键',
        desktopOnly: true,
        ...personal,
      },
      {
        id: 'quick-phrases',
        path: '/settings/personal/quick-phrases',
        icon: 'message-square-text',
        labelKey: 'settings_nav_quick_phrases',
        label: '快捷短语',
        ...personal,
      },
      {
        id: 'runtimes',
        path: '/settings/personal/runtimes',
        icon: 'server',
        labelKey: 'settings_nav_runtimes',
        label: 'Runtime',
        ...personal,
      },
      {
        id: 'about',
        path: '/settings/about',
        icon: 'info',
        labelKey: 'settings_nav_about',
        label: '关于',
        ...personal,
      },
      {
        id: 'appshots',
        path: '/settings/appshots',
        icon: 'scan-line',
        labelKey: 'settings_nav_appshots',
        label: '应用快照',
        desktopOnly: true,
        ...integrations,
      },
      {
        id: 'computer-use',
        path: '/settings/computer-use',
        icon: 'monitor-cog',
        labelKey: 'settings_nav_computer_use',
        label: '电脑操控',
        desktopOnly: true,
        ...integrations,
      },
      {
        id: 'plugins',
        path: '/settings/plugins',
        icon: 'package',
        labelKey: 'settings_nav_plugins',
        label: '插件',
        ...integrations,
      },
      {
        id: 'browser',
        path: '/settings/browser',
        aliases: ['/settings/browser/history'],
        icon: 'app-window',
        labelKey: 'settings_nav_browser',
        label: '浏览器',
        ...integrations,
      },
      {
        id: 'execution-environments',
        path: '/settings/execution-environments',
        icon: 'cpu',
        labelKey: 'settings_nav_execution_environments',
        label: '执行环境',
        ...coding,
      },
      {
        id: 'harnesses',
        path: '/settings/harnesses',
        icon: 'code-2',
        labelKey: 'settings_nav_harnesses',
        label: '编码工具',
        experimental: true,
        ...coding,
      },
      {
        id: 'hooks',
        path: '/settings/hooks',
        icon: 'webhook',
        labelKey: 'settings_nav_hooks',
        label: 'Hooks',
        ...coding,
      },
      {
        id: 'archived-conversations',
        path: '/settings/archived-conversations',
        icon: 'archive',
        labelKey: 'settings_nav_archived_conversations',
        label: '已归档对话',
        ...archived,
      },
    ]
    return {
      inject: ['slots', 'wework'],
      apply(ctx) {
        ctx.slots.inject('wework.settings.page', function* () {
          for (const page of pages) {
            yield ctx.wework.ui.register(ctx, 'wework.settings.page', {
              order: 100,
              ...page,
              module: 'plugins/wework-ui-core-settings.js',
            })
          }
        })
      },
    }
  },
})
