window.__ModuleLoader__.load({
  id: '@wegent/dsh-ui-git',
  factory: () => ({
    inject: ['slots', 'wework'],
    apply(ctx) {
      ctx.slots.inject('wework.source-control.provider', () =>
        ctx.wework.ui.register(ctx, 'wework.source-control.provider', {
          id: 'git',
          workspaceModes: ['git_worktree'],
        })
      )
      for (const contribution of [
        {
          slot: 'wework.task.status',
          descriptor: {
            id: 'git-change-request',
            module: 'plugins/wework-ui-git-task-status.js',
            order: 50,
          },
        },
        {
          slot: 'wework.environment.section',
          descriptor: {
            id: 'git-change-request',
            module: 'plugins/wework-ui-git-environment-section.js',
            order: 50,
          },
        },
        {
          slot: 'wework.board.card.status',
          descriptor: {
            id: 'git-change-request',
            module: 'plugins/wework-ui-git-board-card-status.js',
            order: 50,
          },
        },
      ]) {
        ctx.slots.inject(contribution.slot, () =>
          ctx.wework.ui.register(ctx, contribution.slot, contribution.descriptor)
        )
      }
      ctx.slots.inject('wework.settings.page', function* () {
        for (const page of [
          {
            id: 'git-hosting',
            path: '/settings/git-hosting',
            icon: 'git-pull-request',
            labelKey: 'settings_nav_git_hosting',
            label: '代码托管',
            order: 50,
          },
          {
            id: 'worktrees',
            path: '/settings/worktrees',
            icon: 'git-branch',
            labelKey: 'settings_nav_worktrees',
            label: '工作树',
            order: 60,
          },
        ]) {
          yield ctx.wework.ui.register(ctx, 'wework.settings.page', {
            ...page,
            category: 'coding',
            categoryLabel: '编码',
            module: 'plugins/wework-ui-git-settings.js',
          })
        }
      })
    },
  }),
})
