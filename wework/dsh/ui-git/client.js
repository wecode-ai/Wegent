window.__ModuleLoader__.load({
  id: '@wegent/dsh-ui-git',
  factory: () => ({
    inject: ['slots', 'wework'],
    apply(ctx) {
      ctx.slots.inject('wework.git', () =>
        ctx.wework.ui.register(ctx, 'wework.git', {
          commands: ['git', 'gh', 'glab'],
          id: 'git',
          surfaces: [
            'repositories',
            'worktrees',
            'sidebar',
            'environment',
            'changes-review',
            'board',
          ],
        })
      )
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
