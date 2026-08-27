window.__ModuleLoader__.load({
  id: '@wegent/dsh-ui-plugin-center',
  factory: () => {
    const routes = [
      {
        id: 'plugin-center.catalog',
        icon: 'plug',
        module: 'plugins/wework-ui-plugin-center-catalog.js',
        path: '/plugins',
        restorePolicy: 'session',
        telemetryFeature: 'plugins',
        titleKey: 'workbench.workspace_tab_plugins',
        title: '插件',
      },
      {
        id: 'plugin-center.create',
        icon: 'plug',
        module: 'plugins/wework-ui-plugin-center-create.js',
        path: '/plugins/create',
        restorePolicy: 'session',
        telemetryFeature: 'plugin_create',
        titleKey: 'workbench.workspace_tab_plugins',
        title: '插件',
      },
      {
        id: 'plugin-center.management',
        icon: 'plug',
        module: 'plugins/wework-ui-plugin-center-management.js',
        path: '/plugins/manage',
        restorePolicy: 'session',
        telemetryFeature: 'plugin_management',
        titleKey: 'workbench.workspace_tab_plugins',
        title: '插件',
      },
    ]
    const navigation = {
      id: 'plugin-center.navigation',
      activeItem: 'plugins',
      icon: 'plug',
      labelKey: 'workbench.plugins',
      label: '插件',
      module: 'plugins/wework-ui-plugin-center-catalog.js',
      order: 20,
      path: '/plugins',
      prefetch: true,
      testId: 'plugins-button',
    }
    return {
      inject: ['slots', 'wework'],
      apply(ctx) {
        ctx.slots.inject('wework.action', () =>
          ctx.wework.ui.register(ctx, 'wework.action', {
            id: 'plugin-center.open',
            path: '/plugins',
          })
        )
        ctx.slots.inject('wework.route', function* () {
          for (const route of routes) {
            yield ctx.wework.ui.register(ctx, 'wework.route', route)
          }
        })
        ctx.slots.inject('wework.sidebar.navigation', () =>
          ctx.wework.ui.register(ctx, 'wework.sidebar.navigation', navigation)
        )
      },
    }
  },
})
