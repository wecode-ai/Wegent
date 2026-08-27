window.__ModuleLoader__.load({
  id: '@wegent/dsh-ui-automations',
  factory: () => {
    return {
      inject: ['slots', 'wework'],
      apply(ctx) {
        ctx.slots.inject('wework.route', () =>
          ctx.wework.ui.register(ctx, 'wework.route', {
            id: 'automations.root',
            icon: 'alarm-clock',
            module: 'plugins/wework-ui-automations.js',
            path: '/automations',
            restorePolicy: 'session',
            telemetryFeature: 'automations',
            titleKey: 'workbench.automation',
            title: '已安排',
          })
        )
        ctx.slots.inject('wework.sidebar.navigation', () =>
          ctx.wework.ui.register(ctx, 'wework.sidebar.navigation', {
            id: 'automations.navigation',
            activeItem: 'automation',
            icon: 'alarm-clock',
            labelKey: 'workbench.automation',
            label: '已安排',
            order: 10,
            path: '/automations',
            testId: 'automation-button',
          })
        )
      },
    }
  },
})
