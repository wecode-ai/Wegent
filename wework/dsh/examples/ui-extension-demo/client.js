window.__ModuleLoader__.load({
  id: '@wegent/dsh-wework-extension-demo',
  factory: require => {
    const React = require('react')
    const { createElement } = React

    const colors = {
      border: 'rgb(var(--color-border))',
      muted: 'rgb(var(--color-text-muted))',
      primary: 'rgb(var(--color-text-primary))',
      surface: 'rgb(var(--color-background))',
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
          path: '/dsh-extension-demo',
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
        for (const contribution of contributions) {
          ctx.slots.inject(contribution.slot, () =>
            ctx.wework.ui.register(
              ctx,
              contribution.slot,
              contribution.descriptor,
              contribution.component
            )
          )
        }
      },
    }
  },
})
