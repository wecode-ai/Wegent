window.__ModuleLoader__.load({
  id: '@wegent/dsh-wework-plugin-developer',
  factory: require => {
    const React = require('react')
    const { createElement, useCallback, useEffect, useState } = React
    const text = (zh, en) =>
      document.documentElement.lang.toLowerCase().startsWith('zh') ? zh : en

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

    function CreatePluginAction({ onCreate }) {
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
          busy ? text('正在创建…', 'Creating…') : text('创建新插件', 'Create plugin')
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

    function PluginDebugPanel({ scope, visible }) {
      const [session, setSession] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')

      const refresh = useCallback(async () => {
        try {
          const sessions = await invoke('pluginDevelopment.list')
          setSession(sessions[0] || null)
          setError('')
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      }, [])

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
      const sourceRoot = scope?.cwd || ''
      const currentSession = session?.sourceRoot === sourceRoot ? session : null
      const running = currentSession && !['stopped', 'error'].includes(currentSession.status)
      return createElement(
        'aside',
        {
          'data-testid': 'wework-plugin-development-sidebar',
          className: 'flex h-full min-h-0 flex-col gap-4 overflow-auto p-4 text-text-primary',
        },
        createElement(
          'header',
          null,
          createElement(
            'h2',
            { className: 'heading-section' },
            text('插件调试', 'Plugin debugging')
          ),
          createElement(
            'p',
            { className: 'mt-1 break-all text-sm text-text-secondary' },
            sourceRoot
          )
        ),
        error
          ? createElement(
              'pre',
              {
                'data-testid': 'wework-plugin-development-sidebar-error',
                className:
                  'whitespace-pre-wrap rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive',
              },
              error
            )
          : null,
        currentSession
          ? createElement(
              'div',
              { className: 'rounded-xl border border-border/40 p-3' },
              createElement('strong', { className: 'text-sm' }, currentSession.displayName),
              createElement(
                'p',
                {
                  'data-testid': 'wework-plugin-development-sidebar-status',
                  className: 'mt-1 text-sm text-text-secondary',
                },
                `${text('状态', 'Status')}: ${currentSession.status} · HMR ${currentSession.hmrGeneration}`
              ),
              currentSession.lastError
                ? createElement(
                    'pre',
                    {
                      'data-testid': 'wework-plugin-development-sidebar-last-error',
                      className: 'mt-3 whitespace-pre-wrap text-xs text-destructive',
                    },
                    `${currentSession.lastError.stage}: ${currentSession.lastError.message}`
                  )
                : null
            )
          : null,
        createElement(
          'div',
          { className: 'flex flex-wrap gap-2' },
          !running
            ? createElement(
                'button',
                {
                  type: 'button',
                  disabled: !sourceRoot || Boolean(busy),
                  'data-testid': 'wework-plugin-development-sidebar-start',
                  className:
                    'inline-flex min-h-9 items-center rounded-lg bg-text-primary px-3 text-sm text-background disabled:opacity-50',
                  onClick: () => run('start', 'pluginDevelopment.start', { sourceRoot }),
                },
                busy === 'start'
                  ? text('启动中…', 'Starting…')
                  : text('启动调试实例', 'Start debug instance')
              )
            : createElement(
                'button',
                {
                  type: 'button',
                  disabled: Boolean(busy),
                  'data-testid': 'wework-plugin-development-sidebar-focus',
                  className:
                    'inline-flex min-h-9 items-center rounded-lg bg-text-primary px-3 text-sm text-background disabled:opacity-50',
                  onClick: () => run('focus', 'pluginDevelopment.focus'),
                },
                text('切换到调试实例', 'Focus debug instance')
              ),
          running
            ? createElement(
                React.Fragment,
                null,
                createElement(
                  'button',
                  {
                    type: 'button',
                    disabled: Boolean(busy),
                    'data-testid': 'wework-plugin-development-sidebar-restart',
                    className: 'min-h-9 rounded-lg border border-border px-3 text-sm',
                    onClick: () => run('restart', 'pluginDevelopment.restartCoreDsh'),
                  },
                  text('重启 Core DSH', 'Restart Core DSH')
                ),
                createElement(
                  'button',
                  {
                    type: 'button',
                    disabled: Boolean(busy),
                    'data-testid': 'wework-plugin-development-sidebar-devtools',
                    className: 'min-h-9 rounded-lg border border-border px-3 text-sm',
                    onClick: () => run('devtools', 'pluginDevelopment.openDevTools'),
                  },
                  'DevTools'
                ),
                createElement(
                  'button',
                  {
                    type: 'button',
                    disabled: Boolean(busy),
                    'data-testid': 'wework-plugin-development-sidebar-logs',
                    className: 'min-h-9 rounded-lg border border-border px-3 text-sm',
                    onClick: () => run('logs', 'pluginDevelopment.openLogDirectory'),
                  },
                  text('日志', 'Logs')
                ),
                createElement(
                  'button',
                  {
                    type: 'button',
                    disabled: Boolean(busy),
                    'data-testid': 'wework-plugin-development-sidebar-stop',
                    className:
                      'min-h-9 rounded-lg border border-destructive/40 px-3 text-sm text-destructive',
                    onClick: () => run('stop', 'pluginDevelopment.stop'),
                  },
                  text('停止', 'Stop')
                )
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
          label: text('创建新插件', 'Create plugin'),
          order: 10,
        },
        component: CreatePluginAction,
      },
      {
        slot: 'wework.workspace.sidebar.tab',
        descriptor: {
          id: 'wework-plugin-developer.debug',
          label: text('插件调试', 'Plugin debugging'),
          order: 15,
          when: {
            projectKinds: ['wework-core-dsh-plugin'],
            codexPluginKeys: ['wework-plugin-developer'],
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
