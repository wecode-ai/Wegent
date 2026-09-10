window.__ModuleLoader__.load({
  id: '@wegent/dsh-ui-outputs',
  factory: () => ({
    inject: ['slots', 'wework'],
    apply(ctx) {
      ctx.slots.inject('wework.conversation.summary', () =>
        ctx.wework.contributions.register(ctx, 'wework.conversation.summary', {
          id: 'outputs-summary',
          module: 'plugins/wework-ui-outputs-conversation-summary.js',
          order: 50,
          requiredHostServices: ['wework.conversation.outputs'],
          when: { key: 'workspace.isGitRepository', equals: false },
        })
      )
    },
  }),
})
