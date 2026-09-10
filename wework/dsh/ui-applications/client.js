window.__ModuleLoader__.load({
  id: '@wegent/dsh-ui-applications',
  factory: () => {
    return {
      inject: ['slots', 'wework'],
      apply(ctx) {
        ctx.slots.inject('wework.route', () =>
          ctx.wework.contributions.register(ctx, 'wework.route', {
            id: 'applications.sites',
            icon: 'applications',
            module: 'plugins/wework-ui-applications.js',
            path: '/sites',
            restorePolicy: 'session',
            telemetryFeature: 'sites',
            titleKey: 'workbench.workspace_tab_sites',
            title: '应用',
          })
        )
        ctx.slots.inject('wework.sidebar.navigation', () =>
          ctx.wework.contributions.register(ctx, 'wework.sidebar.navigation', {
            id: 'applications.navigation',
            activeItem: 'sites',
            icon: 'applications',
            labelKey: 'workbench.sites',
            label: '应用',
            order: 30,
            path: '/sites',
            testId: 'sites-button',
          })
        )
      },
    }
  },
})
