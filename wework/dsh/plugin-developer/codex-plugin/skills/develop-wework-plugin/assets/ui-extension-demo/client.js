window.__ModuleLoader__.load({
  id: '@wegent/dsh-wework-extension-demo',
  factory: require => {
    const React = require('react')
    const { createElement } = React
    const DEMO_COMMAND = 'dsh-extension-demo.run'
    const DEMO_CONFIGURATION = 'dsh-extension-demo.settings'
    const DEMO_CONTEXT = 'dsh-extension-demo.enabled'

    const colors = {
      border: 'rgb(var(--color-border))',
      muted: 'rgb(var(--color-text-muted))',
      primary: 'rgb(var(--color-text-primary))',
      surface: 'rgb(var(--color-background))',
    }

    function workspaceTabPath(path, id, title) {
      const separator = path.includes('?') ? '&' : '?'
      const params = new URLSearchParams({
        workspaceTab: id,
        workspaceTabTitle: title,
      })
      return `${path}${separator}${params}`
    }

    function DemoPanel({ children, testId, title }) {
      return createElement(
        'section',
        {
          'data-testid': testId,
          style: {
            background: colors.surface,
            color: colors.primary,
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            height: '100%',
            overflow: 'auto',
            padding: '24px',
          },
        },
        createElement('h1', { style: { fontWeight: 600, margin: 0 } }, title),
        createElement(
          'p',
          { style: { color: colors.muted, lineHeight: 1.6, margin: 0 } },
          'This surface is rendered by a third-party Core DSH client plugin.'
        ),
        children
      )
    }

    function DemoRoute({ onNavigate, search }) {
      return createElement(
        DemoPanel,
        { testId: 'dsh-extension-demo-route', title: 'DSH extension route' },
        createElement('code', null, search || '(no query string)'),
        createElement(
          'button',
          {
            'data-testid': 'dsh-extension-demo-open-settings',
            onClick: () => onNavigate?.('/settings/dsh-extension-demo'),
            style: {
              alignSelf: 'flex-start',
              border: `1px solid ${colors.border}`,
              borderRadius: '8px',
              cursor: 'pointer',
              padding: '8px 12px',
            },
            type: 'button',
          },
          'Open demo settings'
        )
      )
    }

    function DemoApp({ visible }) {
      return createElement(
        'div',
        { hidden: !visible, style: { height: '100%' } },
        createElement(DemoPanel, {
          testId: 'dsh-extension-demo-app',
          title: 'DSH extension app',
        })
      )
    }

    function DemoSettings({ onBack }) {
      return createElement(
        DemoPanel,
        { testId: 'dsh-extension-demo-settings', title: 'DSH extension settings' },
        createElement(
          'button',
          {
            'data-testid': 'dsh-extension-demo-settings-back',
            onClick: onBack,
            style: {
              alignSelf: 'flex-start',
              border: `1px solid ${colors.border}`,
              borderRadius: '8px',
              cursor: 'pointer',
              padding: '8px 12px',
            },
            type: 'button',
          },
          'Back'
        )
      )
    }

    function DemoSettingsSection() {
      return createElement(DemoPanel, {
        testId: 'dsh-extension-demo-settings-section',
        title: 'DSH settings section',
      })
    }

    function DemoWorkspaceTab({ tab, visible }) {
      return createElement(
        'div',
        { hidden: !visible, style: { height: '100%' } },
        createElement(
          DemoPanel,
          { testId: 'dsh-extension-demo-workspace-tab', title: 'DSH workspace tab' },
          createElement('code', null, tab?.id || '(no tab id)')
        )
      )
    }

    function DemoWorkspaceMenuSection() {
      return createElement(
        'div',
        { 'data-testid': 'dsh-extension-demo-workspace-menu-section' },
        'Demo workspace menu section'
      )
    }

    function DemoComposerAction({ disabled }) {
      return createElement(
        'button',
        {
          'data-testid': 'dsh-extension-demo-composer-action',
          disabled,
          type: 'button',
        },
        'Demo'
      )
    }

    function DemoWorkspaceToolbarAction() {
      return createElement(
        'button',
        {
          'data-testid': 'dsh-extension-demo-workspace-toolbar-action',
          type: 'button',
        },
        'Demo'
      )
    }

    function DemoBottomPanel({ visible }) {
      return createElement(
        'div',
        {
          'data-testid': 'dsh-extension-demo-bottom-panel',
          hidden: !visible,
          style: { color: colors.primary, height: '100%', padding: '16px' },
        },
        'Demo bottom-panel tool'
      )
    }

    function DemoProjectCreateSection() {
      return createElement(
        'div',
        { 'data-testid': 'dsh-extension-demo-project-create-section' },
        'Demo project creation controls'
      )
    }

    function DemoProjectWorkSection() {
      return createElement(
        'div',
        { 'data-testid': 'dsh-extension-demo-project-work-section' },
        'Demo project controls'
      )
    }

    function DemoPluginAction({ onCreate, t }) {
      return createElement(
        'button',
        {
          'data-testid': 'dsh-extension-demo-plugin-action',
          onClick: onCreate,
          type: 'button',
        },
        t('dsh_extension_demo.create', 'Create demo plugin')
      )
    }

    function DemoWorkspaceSidebar({ scope, tab, visible }) {
      return createElement(
        'aside',
        {
          'data-testid': 'dsh-extension-demo-workspace-sidebar',
          hidden: !visible,
          style: { color: colors.primary, padding: '16px' },
        },
        createElement('strong', null, tab?.title || 'Demo inspector'),
        createElement('div', { style: { color: colors.muted } }, scope?.cwd || '(no workspace)')
      )
    }

    function DemoShellBefore() {
      return createElement('span', {
        'data-testid': 'dsh-extension-demo-shell-before',
        hidden: true,
      })
    }

    function DemoShellAfter() {
      return createElement('span', {
        'data-testid': 'dsh-extension-demo-shell-after',
        hidden: true,
      })
    }

    function DemoOverlay() {
      return createElement(
        'div',
        {
          'data-testid': 'dsh-extension-demo-overlay',
          style: {
            background: colors.primary,
            borderRadius: '999px',
            bottom: '16px',
            color: colors.surface,
            padding: '6px 10px',
            pointerEvents: 'none',
            position: 'absolute',
            right: '16px',
          },
        },
        'DSH Demo'
      )
    }

    function DemoTaskStatus({ task }) {
      return createElement(
        'span',
        { 'data-testid': 'dsh-extension-demo-task-status', title: task?.title || '' },
        '●'
      )
    }

    function DemoEnvironmentSection({ info }) {
      return createElement(
        'div',
        { 'data-testid': 'dsh-extension-demo-environment-section' },
        info?.workspacePath || 'Demo environment'
      )
    }

    function DemoBoardCardStatus({ itemId }) {
      return createElement(
        'span',
        { 'data-testid': 'dsh-extension-demo-board-card-status' },
        itemId || 'Demo card'
      )
    }

    const contributions = [
      {
        slot: 'wework.action',
        descriptor: {
          id: 'dsh-extension-demo.open',
          path: '/dsh-extension-demo',
        },
      },
      {
        slot: 'wework.app',
        descriptor: {
          description: 'Third-party surface application',
          id: 'dsh-extension-demo',
          label: 'DSH Demo',
          mode: 'surface',
          order: 90,
        },
        component: DemoApp,
      },
      {
        slot: 'wework.task.status',
        descriptor: {
          id: 'dsh-extension-demo.task-status',
          order: 90,
        },
        component: DemoTaskStatus,
      },
      {
        slot: 'wework.environment.section',
        descriptor: {
          id: 'dsh-extension-demo.environment-section',
          order: 90,
        },
        component: DemoEnvironmentSection,
      },
      {
        slot: 'wework.board.card.status',
        descriptor: {
          id: 'dsh-extension-demo.board-card-status',
          order: 90,
        },
        component: DemoBoardCardStatus,
      },
      {
        slot: 'wework.workspace.menu.section',
        descriptor: {
          id: 'demo-workspace-menu',
          label: 'Demo workspace menu',
        },
        component: DemoWorkspaceMenuSection,
      },
      {
        slot: 'wework.composer.action',
        descriptor: {
          id: 'dsh-extension-demo.composer-action',
          order: 90,
        },
        component: DemoComposerAction,
      },
      {
        slot: 'wework.workspace.toolbar.action',
        descriptor: {
          id: 'dsh-extension-demo.workspace-toolbar-action',
          order: 90,
        },
        component: DemoWorkspaceToolbarAction,
      },
      {
        slot: 'wework.workspace.bottom-panel.tab',
        descriptor: {
          icon: 'blocks',
          id: 'dsh-extension-demo.bottom-panel',
          label: 'DSH Demo',
          order: 90,
        },
        component: DemoBottomPanel,
      },
      {
        slot: 'wework.plugins.action',
        descriptor: {
          id: 'dsh-extension-demo.create',
          label: 'Create demo plugin',
          order: 90,
        },
        component: DemoPluginAction,
      },
      {
        slot: 'wework.project.create.section',
        descriptor: {
          id: 'dsh-extension-demo.project-create',
          order: 90,
        },
        component: DemoProjectCreateSection,
      },
      {
        slot: 'wework.project.work.section',
        descriptor: {
          id: 'dsh-extension-demo.project-work',
          order: 90,
        },
        component: DemoProjectWorkSection,
      },
      {
        slot: 'wework.runtime-profile.workspace-policy',
        descriptor: {
          id: 'dsh_extension_demo',
          label: 'Demo workspace',
          order: 90,
        },
      },
      {
        slot: 'wework.route',
        descriptor: {
          icon: 'blocks',
          id: 'dsh-extension-demo.route',
          path: '/dsh-extension-demo',
          restorePolicy: 'session',
          telemetryFeature: 'apps',
          title: 'DSH Demo',
        },
        component: DemoRoute,
      },
      {
        slot: 'wework.sidebar.navigation',
        descriptor: {
          activeItem: 'dsh-extension-demo',
          icon: 'blocks',
          id: 'dsh-extension-demo.navigation',
          label: 'DSH Demo',
          order: 90,
          path: workspaceTabPath('/dsh-extension-demo', 'auxiliary-dsh-extension-demo', 'DSH Demo'),
          testId: 'dsh-extension-demo-navigation',
        },
      },
      {
        slot: 'wework.settings.page',
        descriptor: {
          category: 'extensions',
          categoryLabel: 'Extensions',
          icon: 'blocks',
          id: 'dsh-extension-demo.settings',
          label: 'DSH Demo',
          order: 90,
          path: '/settings/dsh-extension-demo',
        },
        component: DemoSettings,
      },
      {
        slot: 'wework.settings.section',
        descriptor: {
          id: 'dsh-extension-demo.settings-section',
          label: 'DSH Demo',
          order: 90,
          page: 'connections',
        },
        component: DemoSettingsSection,
      },
      {
        slot: 'wework.workspace.tab',
        descriptor: {
          id: 'dsh-extension-demo.workspace',
          label: 'DSH Demo',
          order: 90,
        },
        component: DemoWorkspaceTab,
      },
      {
        slot: 'wework.workspace.sidebar.tab',
        descriptor: {
          id: 'dsh-extension-demo.inspector',
          label: 'Demo inspector',
          order: 90,
        },
        component: DemoWorkspaceSidebar,
      },
      {
        slot: 'wework.shell.before',
        descriptor: { id: 'dsh-extension-demo.before' },
        component: DemoShellBefore,
      },
      {
        slot: 'wework.shell.after',
        descriptor: { id: 'dsh-extension-demo.after' },
        component: DemoShellAfter,
      },
      {
        slot: 'wework.shell.overlay',
        descriptor: { id: 'dsh-extension-demo.overlay' },
        component: DemoOverlay,
      },
    ]

    return {
      inject: ['slots', 'wework'],
      apply(ctx) {
        const state = ctx.wework.storage.scope('dsh-extension-demo')
        ctx.wework.context.set(ctx, DEMO_CONTEXT, true)
        ctx.wework.composer.references.register(ctx, {
          description: 'Insert a stable reference owned by the demo plugin.',
          id: 'dsh-extension-demo.reference',
          metaLabel: 'DSH Demo',
          reference: '[$DSH Demo](dsh-demo://overview)',
          searchAliases: ['demo', 'extension'],
          title: 'DSH Demo',
          when: DEMO_CONTEXT,
        })
        ctx.wework.configuration.register(ctx, {
          defaults: { message: 'Hello from the Wework extension framework' },
          description: 'Settings owned and persisted by the demo plugin.',
          id: DEMO_CONFIGURATION,
          properties: {
            message: { type: 'string' },
          },
          title: 'DSH extension demo',
        })
        ctx.wework.commands.register(
          ctx,
          {
            enablement: ['wework.desktop', DEMO_CONTEXT],
            icon: 'play',
            id: DEMO_COMMAND,
            title: 'Run DSH extension demo',
          },
          (_args, invocation) => {
            const runCount = state.get('run-count', 0) + 1
            state.set('run-count', runCount)
            return {
              invocation,
              message: ctx.wework.configuration.get(DEMO_CONFIGURATION)?.message,
              runCount,
            }
          }
        )
        ctx.wework.menus.register(ctx, 'composer.toolbar', {
          command: DEMO_COMMAND,
          group: 'extensions',
          icon: 'play',
          id: 'dsh-extension-demo.composer-menu',
          order: 90,
        })
        ctx.wework.menus.register(ctx, 'composer.slash', {
          command: DEMO_COMMAND,
          group: 'Extensions',
          id: 'dsh-extension-demo.slash-menu',
          order: 90,
        })
        ctx.wework.menus.register(ctx, 'workspace.toolbar', {
          command: DEMO_COMMAND,
          group: 'extensions',
          icon: 'play',
          id: 'dsh-extension-demo.workspace-menu',
          order: 90,
        })
        ctx.wework.keybindings.register(ctx, {
          command: DEMO_COMMAND,
          id: 'dsh-extension-demo.run-keybinding',
          key: 'Ctrl+Shift+D',
          mac: 'Command+Shift+D',
          when: DEMO_CONTEXT,
        })

        for (const contribution of contributions) {
          ctx.slots.inject(contribution.slot, function* () {
            yield ctx.wework.contributions.register(ctx, contribution.slot, contribution.descriptor)
            yield ctx.slots.register(
              {
                name: contribution.slot,
                id: contribution.descriptor.id,
                label: contribution.descriptor.label,
                order: contribution.descriptor.order,
              },
              contribution.component
            )
          })
        }
      },
    }
  },
})
