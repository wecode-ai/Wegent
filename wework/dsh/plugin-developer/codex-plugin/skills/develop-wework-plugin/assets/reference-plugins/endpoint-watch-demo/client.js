window.__ModuleLoader__.load({
  id: '@wegent/dsh-endpoint-watch-demo',
  factory: require => {
    const React = require('react')
    const { createElement, useEffect, useState } = React
    const CONFIGURATION_ID = 'endpoint-watch.settings'
    const PAGE_ID = 'plugin:endpoint-watch'

    function workspaceTabPath(path, id, title) {
      const params = new URLSearchParams({ workspaceTab: id, workspaceTabTitle: title })
      return `${path}?${params}`
    }

    function createWatchStore(service) {
      const storage = service.storage.scope('endpoint-watch')
      let snapshot = {
        checking: false,
        endpoint: service.configuration.get(CONFIGURATION_ID)?.endpoint ?? 'https://example.com',
        history: storage.get('history', []),
        latest: storage.get('latest', null),
      }
      let pageCreated = false
      const listeners = new Set()
      const publish = patch => {
        snapshot = { ...snapshot, ...patch }
        for (const listener of listeners) listener(snapshot)
      }
      const normalizeEndpoint = value => {
        const url = new URL(value)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          throw new Error('Endpoint Watch only supports HTTP and HTTPS URLs.')
        }
        return url.toString()
      }
      return {
        close() {
          if (!pageCreated) return
          pageCreated = false
          void service.host.browser.closeBackgroundPage(PAGE_ID)
        },
        getSnapshot() {
          return snapshot
        },
        async run(value = snapshot.endpoint, notify = false) {
          const endpoint = normalizeEndpoint(value)
          publish({ checking: true, endpoint })
          service.configuration.update(CONFIGURATION_ID, { endpoint })
          const startedAt = performance.now()
          try {
            if (!pageCreated) {
              await service.host.browser.createBackgroundPage(PAGE_ID)
              pageCreated = true
            }
            const state = await service.host.browser.navigateBackgroundPage(PAGE_ID, endpoint)
            const result = {
              checkedAt: new Date().toISOString(),
              durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
              endpoint,
              error: state.navigationError?.message ?? null,
              ok:
                !state.navigationError &&
                state.httpResponseCode !== null &&
                state.httpResponseCode >= 200 &&
                state.httpResponseCode < 400,
              status: state.httpResponseCode,
              title: state.title,
            }
            const history = [result, ...snapshot.history].slice(0, 6)
            storage.set('latest', result)
            storage.set('history', history)
            publish({ checking: false, endpoint, history, latest: result })
            if (notify) {
              await service.host.notification.show({
                body: result.ok
                  ? `${result.status} · ${result.durationMs} ms`
                  : (result.error ?? `HTTP ${result.status ?? 'unknown'}`),
                title: `Endpoint Watch · ${result.ok ? '正常' : '异常'}`,
              })
            }
            return result
          } catch (error) {
            const result = {
              checkedAt: new Date().toISOString(),
              durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
              endpoint,
              error: error instanceof Error ? error.message : String(error),
              ok: false,
              status: null,
              title: null,
            }
            const history = [result, ...snapshot.history].slice(0, 6)
            storage.set('latest', result)
            storage.set('history', history)
            publish({ checking: false, endpoint, history, latest: result })
            if (notify) {
              await service.host.notification.show({
                body: result.error,
                title: 'Endpoint Watch · 检查失败',
              })
            }
            return result
          }
        },
        setEndpoint(endpoint) {
          publish({ endpoint })
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    function useWatch(store) {
      const [snapshot, setSnapshot] = useState(store.getSnapshot())
      useEffect(() => store.subscribe(setSnapshot), [store])
      return snapshot
    }

    function StatusBadge({ result }) {
      if (!result) {
        return createElement(
          'span',
          {
            style: {
              background: 'rgb(var(--color-bg-muted))',
              borderRadius: '999px',
              color: 'rgb(var(--color-text-muted))',
              padding: '7px 11px',
            },
          },
          '等待首次检查'
        )
      }
      const color = result.ok ? '#16a34a' : '#dc2626'
      return createElement(
        'span',
        {
          'data-testid': 'endpoint-watch-status',
          style: {
            background: `${color}14`,
            border: `1px solid ${color}30`,
            borderRadius: '999px',
            color,
            fontSize: '12px',
            fontWeight: 700,
            padding: '7px 11px',
          },
        },
        result.ok ? `● Healthy · ${result.status}` : `● Unhealthy · ${result.status ?? 'ERR'}`
      )
    }

    function EndpointWatchPage({ store }) {
      const snapshot = useWatch(store)
      return createElement(
        'main',
        {
          'data-testid': 'endpoint-watch-page',
          style: {
            background:
              'radial-gradient(circle at 84% 8%, rgba(59,130,246,.13), transparent 34%), rgb(var(--color-background))',
            color: 'rgb(var(--color-text-primary))',
            height: '100%',
            overflow: 'auto',
            padding: '36px clamp(24px, 5vw, 68px)',
          },
        },
        createElement(
          'div',
          { style: { margin: '0 auto', maxWidth: '960px' } },
          createElement(
            'header',
            { style: { alignItems: 'center', display: 'flex', justifyContent: 'space-between' } },
            createElement(
              'div',
              null,
              createElement(
                'div',
                {
                  style: {
                    color: '#2563eb',
                    fontSize: '12px',
                    fontWeight: 700,
                    letterSpacing: '.14em',
                    textTransform: 'uppercase',
                  },
                },
                'Background Browser Monitor'
              ),
              createElement(
                'h1',
                { style: { fontSize: '34px', letterSpacing: '-.035em', margin: '8px 0' } },
                'Endpoint Watch'
              ),
              createElement(
                'p',
                { style: { color: 'rgb(var(--color-text-secondary))', margin: 0 } },
                '在不打断当前工作的情况下检查服务是否可达。'
              )
            ),
            createElement(StatusBadge, { result: snapshot.latest })
          ),
          createElement(
            'form',
            {
              onSubmit: event => {
                event.preventDefault()
                void store.run()
              },
              style: {
                background: 'rgb(var(--color-bg-surface))',
                border: '1px solid rgb(var(--color-border))',
                borderRadius: '18px',
                boxShadow: '0 18px 55px rgba(15,23,42,.06)',
                display: 'flex',
                gap: '10px',
                marginTop: '30px',
                padding: '16px',
              },
            },
            createElement('input', {
              'data-testid': 'endpoint-watch-input',
              onChange: event => store.setEndpoint(event.target.value),
              spellCheck: false,
              style: {
                background: 'rgb(var(--color-background))',
                border: '1px solid rgb(var(--color-border))',
                borderRadius: '10px',
                color: 'inherit',
                flex: 1,
                fontFamily: 'var(--font-mono)',
                minHeight: '44px',
                outline: 'none',
                padding: '0 13px',
              },
              value: snapshot.endpoint,
            }),
            createElement(
              'button',
              {
                'data-testid': 'endpoint-watch-run',
                disabled: snapshot.checking,
                style: {
                  background: '#2563eb',
                  border: 0,
                  borderRadius: '10px',
                  color: 'white',
                  cursor: snapshot.checking ? 'wait' : 'pointer',
                  fontWeight: 700,
                  minWidth: '116px',
                },
                type: 'submit',
              },
              snapshot.checking ? '检查中…' : '立即检查'
            )
          ),
          createElement(
            'section',
            {
              style: {
                display: 'grid',
                gap: '16px',
                gridTemplateColumns: 'minmax(280px, .8fr) minmax(360px, 1.2fr)',
                marginTop: '18px',
              },
            },
            createElement(
              'article',
              {
                style: {
                  background: 'rgb(var(--color-bg-surface))',
                  border: '1px solid rgb(var(--color-border))',
                  borderRadius: '16px',
                  padding: '22px',
                },
              },
              createElement(
                'span',
                {
                  style: {
                    color: 'rgb(var(--color-text-muted))',
                    fontSize: '11px',
                    fontWeight: 700,
                    letterSpacing: '.12em',
                  },
                },
                'LATEST CHECK'
              ),
              snapshot.latest
                ? createElement(
                    'div',
                    { style: { marginTop: '22px' } },
                    createElement(
                      'strong',
                      { style: { fontSize: '42px', letterSpacing: '-.04em' } },
                      snapshot.latest.status ?? 'ERR'
                    ),
                    createElement(
                      'span',
                      {
                        style: {
                          color: 'rgb(var(--color-text-secondary))',
                          marginLeft: '10px',
                        },
                      },
                      `${snapshot.latest.durationMs} ms`
                    ),
                    createElement(
                      'p',
                      {
                        style: {
                          color: 'rgb(var(--color-text-secondary))',
                          lineHeight: 1.6,
                          margin: '18px 0 0',
                          overflowWrap: 'anywhere',
                        },
                      },
                      snapshot.latest.error ?? snapshot.latest.title ?? snapshot.latest.endpoint
                    )
                  )
                : createElement(
                    'p',
                    {
                      style: {
                        color: 'rgb(var(--color-text-secondary))',
                        lineHeight: 1.7,
                        margin: '20px 0 0',
                      },
                    },
                    '点击“立即检查”，Wework 会创建一个隔离的后台页面并记录真实导航结果。'
                  )
            ),
            createElement(
              'article',
              {
                style: {
                  background: 'rgb(var(--color-bg-surface))',
                  border: '1px solid rgb(var(--color-border))',
                  borderRadius: '16px',
                  overflow: 'hidden',
                },
              },
              createElement(
                'div',
                {
                  style: {
                    borderBottom: '1px solid rgb(var(--color-border))',
                    fontSize: '13px',
                    fontWeight: 700,
                    padding: '16px 18px',
                  },
                },
                '最近检查'
              ),
              ...(snapshot.history.length > 0
                ? snapshot.history.map((result, index) =>
                    createElement(
                      'div',
                      {
                        key: `${result.checkedAt}-${index}`,
                        style: {
                          alignItems: 'center',
                          borderBottom:
                            index === snapshot.history.length - 1
                              ? 0
                              : '1px solid rgb(var(--color-border) / .55)',
                          display: 'grid',
                          gap: '12px',
                          gridTemplateColumns: '12px 1fr auto',
                          padding: '14px 18px',
                        },
                      },
                      createElement('span', {
                        style: {
                          background: result.ok ? '#16a34a' : '#dc2626',
                          borderRadius: '50%',
                          height: '8px',
                          width: '8px',
                        },
                      }),
                      createElement(
                        'div',
                        { style: { minWidth: 0 } },
                        createElement(
                          'div',
                          {
                            style: {
                              fontFamily: 'var(--font-mono)',
                              fontSize: '12px',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            },
                          },
                          result.endpoint
                        ),
                        createElement(
                          'div',
                          { style: { color: 'rgb(var(--color-text-muted))', fontSize: '11px' } },
                          new Date(result.checkedAt).toLocaleTimeString()
                        )
                      ),
                      createElement(
                        'strong',
                        { style: { fontFamily: 'var(--font-mono)', fontSize: '12px' } },
                        `${result.status ?? 'ERR'} · ${result.durationMs}ms`
                      )
                    )
                  )
                : [
                    createElement(
                      'div',
                      {
                        key: 'empty',
                        style: {
                          color: 'rgb(var(--color-text-muted))',
                          padding: '28px 18px',
                          textAlign: 'center',
                        },
                      },
                      '暂无检查记录'
                    ),
                  ])
            )
          )
        )
      )
    }

    function EndpointBottomPanel({ store, visible }) {
      const snapshot = useWatch(store)
      return createElement(
        'div',
        {
          'data-testid': 'endpoint-watch-bottom-panel',
          hidden: !visible,
          style: {
            alignItems: 'center',
            color: 'rgb(var(--color-text-primary))',
            display: visible ? 'flex' : 'none',
            gap: '14px',
            padding: '16px',
          },
        },
        createElement(StatusBadge, { result: snapshot.latest }),
        createElement(
          'code',
          { style: { color: 'rgb(var(--color-text-secondary))' } },
          snapshot.endpoint
        ),
        snapshot.latest ? createElement('span', null, `${snapshot.latest.durationMs} ms`) : null
      )
    }

    return {
      inject: ['slots', 'wework'],
      apply(ctx) {
        ctx.wework.configuration.register(ctx, {
          defaults: { endpoint: 'https://example.com' },
          description: 'The URL checked by Endpoint Watch.',
          id: CONFIGURATION_ID,
          properties: { endpoint: { type: 'string' } },
          title: 'Endpoint Watch',
        })
        const store = createWatchStore(ctx.wework)
        ctx.effect(() => () => store.close())
        ctx.wework.commands.register(
          ctx,
          {
            category: 'Endpoint Watch',
            description: 'Check the configured endpoint in a background browser page.',
            id: 'endpoint-watch.run',
            title: '检查 Endpoint',
          },
          () => store.run(undefined, true)
        )
        ctx.wework.menus.register(ctx, 'workspace.toolbar', {
          command: 'endpoint-watch.run',
          group: 'monitoring',
          icon: 'activity',
          id: 'endpoint-watch.workspace-run',
          order: 44,
        })
        ctx.wework.keybindings.register(ctx, {
          command: 'endpoint-watch.run',
          id: 'endpoint-watch.run-keybinding',
          key: 'Ctrl+Shift+H',
          mac: 'Command+Shift+H',
        })

        const Page = () => createElement(EndpointWatchPage, { store })
        const BottomPanel = props => createElement(EndpointBottomPanel, { ...props, store })
        ctx.slots.inject('wework.route', function* () {
          const descriptor = {
            icon: 'activity',
            id: 'endpoint-watch.route',
            path: '/endpoint-watch',
            restorePolicy: 'session',
            telemetryFeature: 'plugins',
            title: 'Endpoint Watch',
          }
          yield ctx.wework.contributions.register(ctx, 'wework.route', descriptor)
          yield ctx.slots.register(
            {
              name: 'wework.route',
              id: descriptor.id,
              label: descriptor.title,
            },
            Page
          )
        })
        ctx.slots.inject('wework.sidebar.navigation', () =>
          ctx.wework.contributions.register(ctx, 'wework.sidebar.navigation', {
            activeItem: 'endpoint-watch',
            icon: 'activity',
            id: 'endpoint-watch.navigation',
            label: 'Endpoint Watch',
            order: 43,
            path: workspaceTabPath('/endpoint-watch', 'plugin-endpoint-watch', 'Endpoint Watch'),
            testId: 'endpoint-watch-navigation',
          })
        )
        ctx.slots.inject('wework.workspace.bottom-panel.tab', function* () {
          const descriptor = {
            icon: 'activity',
            id: 'endpoint-watch.bottom-panel',
            label: 'Endpoint',
            order: 43,
          }
          yield ctx.wework.contributions.register(
            ctx,
            'wework.workspace.bottom-panel.tab',
            descriptor
          )
          yield ctx.slots.register(
            {
              name: 'wework.workspace.bottom-panel.tab',
              id: descriptor.id,
              label: descriptor.label,
              order: descriptor.order,
            },
            BottomPanel
          )
        })
      },
    }
  },
})
