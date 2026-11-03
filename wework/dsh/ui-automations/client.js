window.__ModuleLoader__.load({
  id: '@wegent/dsh-ui-automations',
  factory: () => {
    return {
      inject: ['slots', 'wework'],
      apply(ctx) {
        ctx.slots.inject('wework.route', () =>
          ctx.wework.contributions.register(ctx, 'wework.route', {
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
      },
    }
  },
})
