window.__ModuleLoader__.load({
  id: '@wegent/dsh-ui-git',
  factory: () => ({
    inject: ['slots', 'wework'],
    apply(ctx) {
      ctx.slots.inject('wework.workspace.menu.section', () =>
        ctx.wework.ui.register(ctx, 'wework.workspace.menu.section', {
          id: 'git-workspace-controls',
          module: 'plugins/wework-ui-git-workspace-menu-section.js',
          order: 50,
        })
      )
      ctx.slots.inject('wework.project.create.section', () =>
        ctx.wework.ui.register(ctx, 'wework.project.create.section', {
          id: 'git-project-create',
          module: 'plugins/wework-ui-git-project-create-section.js',
          order: 50,
        })
      )
      ctx.slots.inject('wework.project.work.section', () =>
        ctx.wework.ui.register(ctx, 'wework.project.work.section', {
          id: 'git-project-work',
          module: 'plugins/wework-ui-git-project-work-section.js',
          order: 50,
        })
      )
      ctx.slots.inject('wework.runtime-profile.workspace-policy', () =>
        ctx.wework.ui.register(ctx, 'wework.runtime-profile.workspace-policy', {
          id: 'git_worktree',
          label: '新工作树',
          labelKey: 'runtime_profile_workspace_worktree',
          order: 50,
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
