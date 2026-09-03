window.__ModuleLoader__.load({
  id: '@wegent/dsh-wework-plugin-developer',
  factory: require => {
    const React = require('react')
    const { createElement, useCallback, useEffect, useState } = React

    async function invoke(capability, params = {}) {
      const response = await fetch('/wework/electron-host/v1/invoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ capability, params }),
      })
      const body = await response.json()
      if (!response.ok || body.ok !== true) {
        throw new Error(body.error?.message || `Electron host request failed (${response.status})`)
      }
      return body.result
    }

    function CreatePluginAction({ onCreate, t }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      return createElement(
        React.Fragment,
        null,
        createElement(
          'button',
          {
            type: 'button',
            disabled: busy || !onCreate,
            'data-testid': 'wework-plugin-developer-create-button',
            className:
              'inline-flex min-h-9 items-center justify-center rounded-lg bg-text-primary px-3 text-sm font-medium text-background disabled:opacity-50',
            onClick: async () => {
              if (!onCreate || busy) return
              setBusy(true)
              setError('')
              try {
                await onCreate()
              } catch (reason) {
                setError(reason instanceof Error ? reason.message : String(reason))
              } finally {
                setBusy(false)
              }
            },
          },
          busy
            ? t('workbench.plugin_development_creating', 'Creating…')
            : t('workbench.plugin_development_create', 'Create plugin')
        ),
        error
          ? createElement(
              'span',
              {
                'data-testid': 'wework-plugin-developer-create-error',
                className: 'ml-2 text-xs text-destructive',
              },
              error
            )
          : null
      )
    }

    function compactPath(path) {
      const parts = path.split(/[\\/]/).filter(Boolean)
      return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path
    }

    function statusPresentation(status, t) {
      if (status === 'ready') {
        return {
          label: t('workbench.plugin_development_status_ready', 'Running'),
          dotClassName: 'bg-success',
        }
      }
      if (status === 'error') {
        return {
          label: t('workbench.plugin_development_status_error', 'Failed'),
          dotClassName: 'bg-destructive',
        }
      }
      if (['validating', 'starting', 'reloading', 'stopping'].includes(status)) {
        return {
          label: t('workbench.plugin_development_status_working', 'Working'),
          dotClassName: 'bg-warning',
        }
      }
      return {
        label: t('workbench.plugin_development_status_stopped', 'Not running'),
        dotClassName: 'bg-text-tertiary',
      }
    }

    function actionButton({ children, className = '', disabled, onClick, testId }) {
      return createElement(
        'button',
        {
          type: 'button',
          disabled,
          'data-testid': testId,
          className: `inline-flex h-9 items-center rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 disabled:cursor-wait disabled:opacity-40 ${className}`,
          onClick,
        },
        children
      )
    }

    function PluginDebugPanel({ scope, t, visible }) {
      const [session, setSession] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')
      const sourceRoot = scope?.cwd || ''

      const refresh = useCallback(async () => {
        try {
          const sessions = await invoke('pluginDevelopment.list')
          setSession(sessions.find(candidate => candidate.sourceRoot === sourceRoot) || null)
          setError('')
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      }, [sourceRoot])

      useEffect(() => {
        if (!visible) return
        void refresh()
        const timer = window.setInterval(refresh, 1000)
        return () => window.clearInterval(timer)
      }, [refresh, visible])

      const run = useCallback(
        async (name, capability, params = {}) => {
          setBusy(name)
          setError('')
          try {
            await invoke(capability, params)
            await refresh()
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason))
          } finally {
            setBusy('')
          }
        },
        [refresh]
      )

      if (!visible) return null
      const currentSession = session
      const running = currentSession && !['stopped', 'error'].includes(currentSession.status)
      const status = currentSession?.status || 'stopped'
      const statusView = statusPresentation(status, t)
      const displayName =
        currentSession?.displayName || sourceRoot.split(/[\\/]/).filter(Boolean).at(-1) || ''
      const statusText = `${statusView.label} · HMR ${currentSession?.hmrGeneration || 0}`
      return createElement(
        'aside',
        {
          'data-testid': 'wework-plugin-development-sidebar',
          className: 'flex h-full min-h-0 flex-col overflow-auto p-5 text-text-primary',
        },
        createElement(
          'section',
          { className: 'w-full max-w-xl min-w-0' },
          createElement(
            'p',
            { className: 'text-xs text-text-tertiary' },
            t('workbench.plugin_development_project', 'Debug project')
          ),
          createElement('h2', { className: 'mt-1 truncate text-base font-medium' }, displayName),
          createElement(
            'p',
            {
              'aria-label': sourceRoot,
              className: 'mt-1 truncate font-mono text-xs text-text-tertiary',
            },
            compactPath(sourceRoot)
          )
        ),
        createElement(
          'div',
          {
            className:
              'mt-5 flex w-full max-w-xl items-center justify-between gap-3 border-y border-border/60 py-3',
          },
          createElement(
            'div',
            { className: 'flex min-w-0 items-center gap-2' },
            createElement('span', {
              'aria-hidden': 'true',
              className: `h-2 w-2 shrink-0 rounded-full ${statusView.dotClassName}`,
            }),
            createElement(
              'span',
              {
                'data-testid': 'wework-plugin-development-sidebar-status',
                className: 'truncate text-sm font-medium',
              },
              statusText
            )
          ),
          busy
            ? createElement(
                'span',
                { className: 'shrink-0 text-xs text-text-tertiary' },
                t('workbench.plugin_development_updating', 'Updating…')
              )
            : null
        ),
        error
          ? createElement(
              'div',
              {
                'data-testid': 'wework-plugin-development-sidebar-error',
                className:
                  'mt-4 w-full max-w-xl whitespace-pre-wrap rounded-lg bg-destructive/5 px-3 py-2 text-xs text-destructive',
              },
              error
            )
          : null,
        currentSession?.lastError
          ? createElement(
              'pre',
              {
                'data-testid': 'wework-plugin-development-sidebar-last-error',
                className:
                  'mt-4 w-full max-w-xl whitespace-pre-wrap rounded-lg bg-destructive/5 px-3 py-2 text-xs text-destructive',
              },
              `${currentSession.lastError.stage}: ${currentSession.lastError.message}`
            )
          : null,
        createElement(
          'section',
          { className: 'mt-5 w-full max-w-xl' },
          actionButton({
            children:
              busy === 'start'
                ? t('workbench.plugin_development_starting', 'Starting…')
                : running
                  ? t('workbench.plugin_development_focus', 'Focus debug instance')
                  : t('workbench.plugin_development_start', 'Start debug instance'),
            className:
              'w-full justify-center bg-text-primary text-background hover:bg-text-primary/80',
            disabled: !sourceRoot || Boolean(busy),
            onClick: () =>
              running
                ? run('focus', 'pluginDevelopment.focus')
                : run('start', 'pluginDevelopment.start', { sourceRoot }),
            testId: running
              ? 'wework-plugin-development-sidebar-focus'
              : 'wework-plugin-development-sidebar-start',
          }),
          running
            ? createElement(
                'div',
                { className: 'mt-5' },
                createElement(
                  'p',
                  { className: 'mb-2 text-xs text-text-tertiary' },
                  t('workbench.plugin_development_tools', 'Debug tools')
                ),
                createElement(
                  'div',
                  { className: 'overflow-hidden rounded-xl bg-muted/50' },
                  actionButton({
                    children: t(
                      'workbench.plugin_development_restart_core_dsh',
                      'Restart Core DSH'
                    ),
                    className:
                      'w-full justify-start rounded-none px-3 text-text-secondary hover:bg-muted hover:text-text-primary',
                    disabled: Boolean(busy),
                    onClick: () => run('restart', 'pluginDevelopment.restartCoreDsh'),
                    testId: 'wework-plugin-development-sidebar-restart',
                  }),
                  createElement('div', { className: 'mx-3 h-px bg-border/70' }),
                  actionButton({
                    children: 'DevTools',
                    className:
                      'w-full justify-start rounded-none px-3 text-text-secondary hover:bg-muted hover:text-text-primary',
                    disabled: Boolean(busy),
                    onClick: () => run('devtools', 'pluginDevelopment.openDevTools'),
                    testId: 'wework-plugin-development-sidebar-devtools',
                  }),
                  createElement('div', { className: 'mx-3 h-px bg-border/70' }),
                  actionButton({
                    children: t('workbench.plugin_development_logs', 'Logs'),
                    className:
                      'w-full justify-start rounded-none px-3 text-text-secondary hover:bg-muted hover:text-text-primary',
                    disabled: Boolean(busy),
                    onClick: () => run('logs', 'pluginDevelopment.openLogDirectory'),
                    testId: 'wework-plugin-development-sidebar-logs',
                  })
                ),
                actionButton({
                  children: t('workbench.plugin_development_stop', 'Stop'),
                  className: 'mt-3 justify-start text-destructive hover:bg-destructive/5',
                  disabled: Boolean(busy),
                  onClick: () => run('stop', 'pluginDevelopment.stop'),
                  testId: 'wework-plugin-development-sidebar-stop',
                })
              )
            : null
        )
      )
    }

    const contributions = [
      {
        slot: 'wework.plugins.action',
        descriptor: {
          id: 'wework-plugin-developer.create',
          label: 'Create plugin',
          labelKey: 'workbench.plugin_development_create',
          order: 10,
        },
        component: CreatePluginAction,
      },
      {
        slot: 'wework.workspace.sidebar.tab',
        descriptor: {
          id: 'wework-plugin-developer.debug',
          label: 'Plugin debugging',
          labelKey: 'workbench.plugin_development_debug',
          order: 15,
          when: {
            projectKinds: ['wework-core-dsh-plugin'],
          },
        },
        component: PluginDebugPanel,
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
