window.__ModuleLoader__.load({
  id: '@wegent/dsh-ui-device-desktop',
  factory: () => ({
    inject: ['slots', 'wework'],
    apply(ctx) {
      ctx.slots.inject('wework.route', () =>
        ctx.wework.contributions.register(ctx, 'wework.route', {
          id: 'device-desktop.root',
          icon: 'monitor',
          module: 'plugins/wework-ui-device-desktop.js',
          path: '/device-desktop',
          restorePolicy: 'none',
          telemetryFeature: 'cloud_work',
          titleKey: 'vnc:workbench.device_desktop',
          title: '设备桌面',
        })
      )
    },
  }),
})
