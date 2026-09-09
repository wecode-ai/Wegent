window.__ModuleLoader__.load({
  id: '@wegent/dsh-ui-home-focus',
  factory: () => ({
    inject: ['slots', 'wework'],
    apply(ctx) {
      ctx.slots.inject('wework.home', () =>
        ctx.wework.contributions.register(ctx, 'wework.home', {
          id: 'focus-home',
          module: 'plugins/wework-ui-home-focus.js',
        })
      )
    },
  }),
})
