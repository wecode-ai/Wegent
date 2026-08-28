window.__ModuleLoader__.load({
  id: '@wegent/dsh-ui-cloud-work',
  factory: () => {
    return {
      inject: ['slots', 'wework'],
      apply(ctx) {
        ctx.slots.inject('wework.route', () =>
          ctx.wework.ui.register(ctx, 'wework.route', {
            id: 'cloud-work.root',
            icon: 'cloud',
            module: 'plugins/wework-ui-cloud-work.js',
            path: '/cloud-work',
            restorePolicy: 'session',
            telemetryFeature: 'cloud_work',
            titleKey: 'workbench.workspace_tab_cloud',
            title: '云端工作',
          })
        )
        ctx.slots.inject('wework.sidebar.navigation', () =>
          ctx.wework.ui.register(ctx, 'wework.sidebar.navigation', {
            id: 'cloud-work.navigation',
            activeItem: 'cloud-work',
            labelKey: 'workbench.cloud_work_entry',
            label: '云端工作',
            module: 'plugins/wework-ui-cloud-work-sidebar.js',
            order: 40,
            path: '/cloud-work',
            surface: 'module',
          })
        )
      },
    }
  },
})
