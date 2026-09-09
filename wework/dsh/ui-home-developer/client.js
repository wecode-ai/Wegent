window.__ModuleLoader__.load({
  id: '@wegent/dsh-ui-home-developer',
  factory: () => ({
    inject: ['slots', 'wework'],
    apply(ctx) {
      ctx.slots.inject('wework.home', () =>
        ctx.wework.contributions.register(ctx, 'wework.home', {
          id: 'developer-home',
          module: 'plugins/wework-ui-home-developer.js',
        })
      )
    },
  }),
})
