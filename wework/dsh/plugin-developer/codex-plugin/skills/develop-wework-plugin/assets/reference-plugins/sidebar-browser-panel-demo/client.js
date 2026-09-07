window.__ModuleLoader__.load({
  id: '@wegent/dsh-sidebar-browser-panel-demo',
  factory: () => {
    const PANEL_ID = 'reference-website'

    return {
      inject: ['slots', 'wework'],
      apply(ctx) {
        const label = ctx.wework.localization.translate({
          en: 'Reference website',
          'zh-CN': '参考网站',
        })
        const description = ctx.wework.localization.translate({
          en: 'Open the reference website beside the current workspace',
          'zh-CN': '在当前工作区右侧打开参考网站',
        })

        ctx.slots.inject('wework.workspace.sidebar.tab', () =>
          ctx.wework.contributions.register(ctx, 'wework.workspace.sidebar.tab', {
            id: PANEL_ID,
            label,
            description,
            mode: 'iframe',
            url: 'https://example.com/',
          })
        )

        ctx.slots.inject('wework.sidebar.navigation', () =>
          ctx.wework.contributions.register(ctx, 'wework.sidebar.navigation', {
            id: 'sidebar-browser-panel.navigation',
            icon: 'globe',
            label,
            order: 50,
            testId: 'sidebar-browser-panel-navigation-button',
            workspaceSidebarTab: PANEL_ID,
          })
        )
      },
    }
  },
})
