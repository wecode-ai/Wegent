window.__ModuleLoader__.load({
  id: '@wegent/dsh-dev-environments-demo',
  factory: require => {
    const React = require('react')
    const { createElement, useEffect, useState } = React
    const PROVIDER_ID = 'dev-environments'
    const OPEN_EVENT = 'wework-demo:open-dev-environments'
    let activePath = ''

    function EnvironmentStatusAction({ workspaceTarget }) {
      activePath = workspaceTarget?.path ?? activePath
      return createElement(
        'button',
        {
          type: 'button',
          disabled: !activePath,
          onClick: () => window.dispatchEvent(new CustomEvent(OPEN_EVENT)),
          'aria-label': '打开开发环境',
          'data-testid': 'dev-environments-trigger',
          className:
            'flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-40',
        },
        createElement('span', { className: 'h-2 w-2 rounded-full bg-blue-500' }),
        createElement('span', null, 'Local')
      )
    }

    function DevEnvironmentWizard() {
      const [open, setOpen] = useState(false)
      const [report, setReport] = useState(null)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState('')

      useEffect(() => {
        const show = () => {
          setOpen(true)
          void inspect()
        }
        window.addEventListener(OPEN_EVENT, show)
        return () => window.removeEventListener(OPEN_EVENT, show)
      }, [])

      const inspect = async () => {
        if (!activePath) return
        setLoading(true)
        setError('')
        try {
          setReport(
            await DevEnvironmentWizard.wework.environments.inspect(PROVIDER_ID, {
              workspacePath: activePath,
            })
          )
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setLoading(false)
        }
      }

      const prepare = async () => {
        if (!activePath || loading) return
        setLoading(true)
        setError('')
        try {
          setReport(
            await DevEnvironmentWizard.wework.environments.prepare(PROVIDER_ID, {
              workspacePath: activePath,
              target: 'devcontainer',
            })
          )
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setLoading(false)
        }
      }

      if (!open) return null
      const configured = report?.state === 'configured'
      return createElement(
        'div',
        {
          className:
            'pointer-events-auto fixed inset-0 z-[100] flex items-center justify-center bg-black/35 p-8 backdrop-blur-[1px]',
          'data-testid': 'dev-environments-overlay',
        },
        createElement(
          'section',
          {
            className:
              'flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-background text-text-primary shadow-xl',
            'data-testid': 'dev-environments-wizard',
          },
          createElement(
            'header',
            { className: 'flex items-start justify-between border-b border-border px-5 py-4' },
            createElement(
              'div',
              null,
              createElement('h2', { className: 'heading-section' }, '配置开发环境'),
              createElement(
                'p',
                { className: 'mt-1 text-sm text-text-secondary' },
                '把本地工作区转换为可复现的 Dev Container'
              )
            ),
            createElement(
              'button',
              {
                type: 'button',
                onClick: () => setOpen(false),
                'aria-label': '关闭开发环境向导',
                'data-testid': 'dev-environments-close',
                className: 'h-8 w-8 rounded-lg text-text-secondary hover:bg-muted',
              },
              '×'
            )
          ),
          createElement(
            'div',
            { className: 'grid min-h-0 flex-1 grid-cols-[180px_1fr]' },
            createElement(
              'nav',
              { className: 'border-r border-border bg-muted/20 p-3' },
              step('1', '检测项目', Boolean(report)),
              step('2', '选择模板', Boolean(report)),
              step('3', '生成配置', configured)
            ),
            createElement(
              'main',
              { className: 'min-h-0 overflow-auto p-5' },
              loading && !report
                ? createElement(
                    'p',
                    { className: 'text-sm text-text-secondary' },
                    '正在检测工作区…'
                  )
                : null,
              error
                ? createElement(
                    'p',
                    {
                      role: 'alert',
                      className: 'mb-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive',
                      'data-testid': 'dev-environments-error',
                    },
                    error
                  )
                : null,
              report
                ? createElement(
                    React.Fragment,
                    null,
                    createElement(
                      'div',
                      { className: 'rounded-xl border border-border p-4' },
                      createElement(
                        'div',
                        { className: 'flex items-center justify-between' },
                        createElement(
                          'div',
                          null,
                          createElement('h3', { className: 'text-sm font-medium' }, '推荐环境'),
                          createElement(
                            'p',
                            { className: 'mt-1 text-sm text-text-secondary' },
                            report.recommendation.label
                          )
                        ),
                        createElement(
                          'span',
                          {
                            className: configured
                              ? 'rounded-full bg-emerald-500/10 px-2 py-1 text-xs text-emerald-600'
                              : 'rounded-full bg-blue-500/10 px-2 py-1 text-xs text-blue-600',
                          },
                          configured ? '已配置' : '建议'
                        )
                      ),
                      createElement(
                        'code',
                        {
                          className:
                            'mt-4 block rounded-lg bg-muted px-3 py-2 text-code text-text-secondary',
                        },
                        report.recommendation.image
                      )
                    ),
                    createElement(
                      'div',
                      { className: 'mt-4 grid grid-cols-2 gap-2' },
                      ...report.tools.map(tool =>
                        createElement(
                          'div',
                          {
                            key: tool.id,
                            className:
                              'flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm',
                          },
                          createElement('span', null, tool.available ? '✓' : '—'),
                          createElement('span', null, tool.label),
                          createElement(
                            'span',
                            { className: 'ml-auto truncate text-xs text-text-muted' },
                            tool.version ?? tool.reason
                          )
                        )
                      )
                    )
                  )
                : null
            )
          ),
          createElement(
            'footer',
            { className: 'flex justify-end gap-2 border-t border-border px-5 py-3' },
            createElement(
              'button',
              {
                type: 'button',
                onClick: () => setOpen(false),
                'data-testid': 'dev-environments-cancel',
                className: 'h-8 rounded-lg px-3 text-sm hover:bg-muted',
              },
              '取消'
            ),
            createElement(
              'button',
              {
                type: 'button',
                disabled: loading || !report || configured,
                onClick: () => void prepare(),
                'data-testid': 'dev-environments-prepare',
                className:
                  'h-8 rounded-lg bg-primary px-3 text-sm text-primary-foreground disabled:opacity-40',
              },
              configured ? '配置已生成' : loading ? '生成中…' : '生成 Dev Container'
            )
          )
        )
      )
    }

    function step(number, label, complete) {
      return createElement(
        'div',
        { className: 'mb-1 flex h-8 items-center gap-2 rounded-lg px-2 text-sm' },
        createElement(
          'span',
          {
            className: complete
              ? 'flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-xs text-white'
              : 'flex h-5 w-5 items-center justify-center rounded-full border border-border text-xs',
          },
          complete ? '✓' : number
        ),
        createElement('span', null, label)
      )
    }

    return {
      inject: ['slots', 'wework'],
      apply(ctx) {
        const backend = ctx.wework.backend.scope(PROVIDER_ID)
        ctx.wework.environments.providers.register(ctx, {
          id: PROVIDER_ID,
          label: 'Dev Environments',
          order: 10,
          inspect: request => backend.request('inspect', { cwd: request.workspacePath }),
          prepare: request =>
            backend.request('prepare', {
              cwd: request.workspacePath,
              target: request.target,
            }),
        })
        DevEnvironmentWizard.wework = ctx.wework
        for (const contribution of [
          {
            slot: 'wework.workspace.toolbar.action',
            descriptor: {
              id: 'dev-environments.status',
              label: 'Development environment',
              order: 15,
            },
            component: EnvironmentStatusAction,
          },
          {
            slot: 'wework.shell.overlay',
            descriptor: {
              id: 'dev-environments.wizard',
              label: 'Development environment wizard',
              order: 15,
            },
            component: DevEnvironmentWizard,
          },
        ]) {
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
