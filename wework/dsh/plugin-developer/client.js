window.__ModuleLoader__.load({
  id: '@wegent/dsh-wework-plugin-developer',
  factory: () => ({
    inject: ['slots', 'wework'],
    apply(ctx) {
      ctx.slots.inject('wework.plugins.action', () =>
        ctx.wework.contributions.register(ctx, 'wework.plugins.action', {
          id: 'wework-plugin-developer.create',
          label: 'Create plugin',
          labelKey: 'workbench.plugin_development_create',
          module: 'plugins/wework-ui-plugin-developer-create.js',
          order: 10,
        })
      )
      ctx.slots.inject('wework.workspace.sidebar.tab', () =>
        ctx.wework.contributions.register(ctx, 'wework.workspace.sidebar.tab', {
          id: 'wework-plugin-developer.debug',
          label: 'Plugin debugging',
          module: 'plugins/wework-ui-plugin-developer-debug.js',
          order: 15,
          when: {
            projectKinds: ['wework-core-dsh-plugin'],
          },
        })
      )
    },
  }),
})
