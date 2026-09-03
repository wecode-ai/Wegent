import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { installDshUiTestContributions } from '@/test/setup'

export async function installGitUiTestContributions() {
  const settingsPages = window.__WEWORK_DSH_UI__?.getEntries(WEWORK_DSH_SLOTS.settingsPage) ?? []
  await installDshUiTestContributions(
    {
      [WEWORK_DSH_SLOTS.workspaceMenuSection]: [
        {
          id: 'git-workspace-controls',
          module: 'plugins/wework-ui-git-workspace-menu-section.js',
          order: 50,
        },
      ],
      [WEWORK_DSH_SLOTS.projectCreateSection]: [
        {
          id: 'git-project-create',
          module: 'plugins/wework-ui-git-project-create-section.js',
          order: 50,
        },
      ],
      [WEWORK_DSH_SLOTS.projectWorkSection]: [
        {
          id: 'git-project-work',
          module: 'plugins/wework-ui-git-project-work-section.js',
          order: 50,
        },
      ],
      [WEWORK_DSH_SLOTS.taskStatus]: [
        {
          id: 'git-change-request',
          module: 'plugins/wework-ui-git-task-status.js',
          order: 50,
        },
      ],
      [WEWORK_DSH_SLOTS.environmentSection]: [
        {
          id: 'git-change-request',
          module: 'plugins/wework-ui-git-environment-section.js',
          order: 50,
        },
      ],
      [WEWORK_DSH_SLOTS.boardCardStatus]: [
        {
          id: 'git-change-request',
          module: 'plugins/wework-ui-git-board-card-status.js',
          order: 50,
        },
      ],
      [WEWORK_DSH_SLOTS.settingsPage]: [
        ...settingsPages,
        {
          id: 'git-hosting',
          path: '/settings/git-hosting',
          icon: 'git-pull-request',
          labelKey: 'settings_nav_git_hosting',
          label: '代码托管',
          order: 50,
          category: 'coding',
          categoryLabel: '编码',
          module: 'plugins/wework-ui-git-settings.js',
        },
        {
          id: 'worktrees',
          path: '/settings/worktrees',
          icon: 'git-branch',
          labelKey: 'settings_nav_worktrees',
          label: '工作树',
          order: 60,
          category: 'coding',
          categoryLabel: '编码',
          module: 'plugins/wework-ui-git-settings.js',
        },
      ],
    },
    {
      'plugins/wework-ui-git-workspace-menu-section.js': () =>
        import('./src/workspace-menu-section'),
      'plugins/wework-ui-git-project-create-section.js': () =>
        import('./src/project-create-section'),
      'plugins/wework-ui-git-project-work-section.js': () => import('./src/project-work-section'),
      'plugins/wework-ui-git-task-status.js': () => import('./src/task-status'),
      'plugins/wework-ui-git-environment-section.js': () => import('./src/environment-section'),
      'plugins/wework-ui-git-board-card-status.js': () => import('./src/board-card-status'),
      'plugins/wework-ui-git-settings.js': () => import('./src/settings-page'),
    }
  )
}
