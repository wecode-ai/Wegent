window.__ModuleLoader__.load({
  id: '@wegent/dsh-ui-core-apps',
  factory: () => {
    const apps = [
      {
        id: 'wework',
        labelKey: 'workbench.app_wework_label',
        label: '任务',
        descriptionKey: 'workbench.app_wework_description',
        description: '使用 AI 解决具体问题',
        mode: 'native',
        module: 'plugins/wework-ui-core-apps.js',
        path: '/',
        requiresAuth: true,
        workspaceKinds: ['task'],
      },
      {
        id: 'todo',
        labelKey: 'workbench.app_weloop_label',
        label: '项目空间',
        descriptionKey: 'workbench.app_weloop_description',
        description: '用 AI 管理项目的规划、执行与反馈',
        mode: 'native',
        module: 'plugins/wework-ui-core-apps.js',
        path: '/todo',
        requiresAuth: true,
        workspaceKinds: ['board'],
        hidden: true,
      },
      {
        id: 'wegent',
        labelKey: 'workbench.app_wegent_label',
        label: '智能体',
        descriptionKey: 'workbench.app_wegent_description',
        description: '构建并交付可嵌入业务的云端智能体',
        mode: 'iframe',
        requiresAuth: true,
        requiresCloud: true,
        urlSource: 'cloud-web',
        hidden: true,
      },
    ]
    return {
      inject: ['slots', 'wework'],
      apply(ctx) {
        ctx.slots.inject('wework.app', function* () {
          for (const app of apps) {
            yield ctx.wework.ui.register(ctx, 'wework.app', app)
          }
        })
      },
    }
  },
})
