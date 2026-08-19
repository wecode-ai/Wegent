const examplePlugin = {
  activate(api) {
    const h = api.react.createElement
    const disposeRoute = api.routes.register({
      id: 'wework-plugin-example.home',
      path: '/plugin-example',
      telemetryFeature: 'plugins',
      render: () =>
        h(
          'main',
          {
            className:
              'mx-auto flex h-full w-full max-w-3xl flex-col justify-center px-5 py-8 text-text-primary',
          },
          h('p', { className: 'text-sm text-text-secondary' }, 'Workbench Plugin API v1'),
          h('h1', { className: 'heading-large mt-2' }, '示例插件已加载'),
          h(
            'p',
            { className: 'mt-3 max-w-2xl text-base leading-6 text-text-secondary' },
            '这个页面、应用入口和设置入口都由本地插件动态注册，不属于 Wework 内置执行器。'
          ),
          h(
            'section',
            { className: 'mt-8 grid gap-3 sm:grid-cols-3' },
            ['本地清单发现', 'SHA-256 完整性校验', '卸载时自动清理'].map((label, index) =>
              h(
                'div',
                {
                  key: label,
                  className: 'rounded-xl border border-border bg-surface px-4 py-5',
                },
                h('p', { className: 'text-xs text-text-secondary' }, `步骤 ${index + 1}`),
                h('p', { className: 'mt-2 text-sm font-medium' }, label)
              )
            )
          )
        ),
    })
    const disposeApp = api.apps.register({
      key: 'plugin-example',
      mode: 'native',
      path: '/plugin-example',
      labelKey: 'pluginExample.app',
      label: '插件示例',
      descriptionKey: 'pluginExample.description',
      description: '验证外部 Wework 插件的加载、路由注册和卸载',
    })
    const disposeSettings = api.settings.register({
      key: 'plugin-example',
      path: '/settings/plugin-example',
      icon: () => null,
      labelKey: 'pluginExample.settings',
      label: '插件示例',
      category: 'plugins',
      categoryLabelKey: 'pluginExample.category',
      categoryLabel: '插件',
      render: () =>
        h(
          'main',
          { className: 'mx-auto w-full max-w-3xl px-5 py-8 text-text-primary' },
          h('h1', { className: 'heading-medium' }, '插件示例'),
          h(
            'p',
            { className: 'mt-2 text-sm leading-6 text-text-secondary' },
            '这个设置页由示例插件注册。卸载插件后，侧栏入口和页面会一起移除。'
          ),
          h(
            'div',
            { className: 'mt-6 rounded-xl border border-border bg-surface px-4 py-4' },
            h('p', { className: 'text-sm font-medium' }, '运行状态'),
            h(
              'p',
              { className: 'mt-1 text-sm text-text-secondary' },
              '本地前端模块已加载，路由、应用和设置注册表均可用。'
            )
          )
        ),
    })
    const disposeRightPanel = api.rightPanels.register({
      key: 'example',
      label: '插件示例',
      icon: ({ className }) =>
        h(
          'span',
          {
            'aria-hidden': 'true',
            className: `${className ?? ''} flex items-center justify-center rounded bg-primary/15 text-[10px] font-semibold text-primary`,
          },
          'P'
        ),
      render: () =>
        h(
          'section',
          {
            'data-testid': 'plugin-example-right-panel',
            className:
              'flex min-h-0 flex-1 flex-col overflow-y-auto bg-background px-6 py-8 text-text-primary',
          },
          h('p', { className: 'text-xs font-medium text-primary' }, 'PLUGIN CONTRIBUTION'),
          h('h1', { className: 'heading-medium mt-2' }, '插件右侧面板'),
          h(
            'p',
            { className: 'mt-3 text-sm leading-6 text-text-secondary' },
            '这个选项和面板由示例插件动态注册。卸载插件后，入口、标签页和内容会从工作台移除。'
          ),
          h(
            'div',
            { className: 'mt-6 rounded-xl border border-border bg-surface px-4 py-4' },
            h('p', { className: 'text-sm font-medium' }, '扩展点状态'),
            h(
              'p',
              { className: 'mt-1 text-sm text-text-secondary' },
              'api.rightPanels 已连接到 Wework 右侧工作区。'
            )
          )
        ),
    })

    return () => {
      disposeRightPanel()
      disposeSettings()
      disposeApp()
      disposeRoute()
    }
  },
}

export default examplePlugin
