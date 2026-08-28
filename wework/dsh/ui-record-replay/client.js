window.__ModuleLoader__.load({
  id: '@wegent/dsh-ui-record-replay',
  factory: () => ({
    inject: ['slots', 'wework'],
    apply(ctx) {
      ctx.slots.inject('wework.route', () =>
        ctx.wework.ui.register(ctx, 'wework.route', {
          id: 'record-replay.root',
          icon: 'list-restart',
          module: 'plugins/wework-ui-record-replay.js',
          path: '/record-replay',
          restorePolicy: 'session',
          telemetryFeature: 'record-replay',
          titleKey: 'workbench.record_replay',
          title: '录制回放',
        })
      )
      ctx.slots.inject('wework.sidebar.navigation', () =>
        ctx.wework.ui.register(ctx, 'wework.sidebar.navigation', {
          id: 'record-replay.navigation',
          activeItem: 'record-replay',
          icon: 'list-restart',
          labelKey: 'workbench.record_replay',
          label: '录制回放',
          order: 20,
          path: '/record-replay',
          testId: 'record-replay-button',
        })
      )
    },
  }),
})
