window.__ModuleLoader__.load({
  id: '@wegent/dsh-test-explorer-demo',
  factory: require => {
    const React = require('react')
    const { createElement, useEffect, useMemo, useRef, useState } = React
    const PROVIDER_ID = 'test-explorer'

    function TestExplorer({ scope, visible }) {
      const [report, setReport] = useState(null)
      const [selected, setSelected] = useState(new Set())
      const [run, setRun] = useState(null)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState('')
      const path = scope?.cwd ?? ''
      const activePath = useRef(path)
      const requestSequence = useRef(0)
      if (activePath.current !== path) {
        activePath.current = path
        requestSequence.current += 1
      }

      useEffect(() => {
        setReport(null)
        setSelected(new Set())
        setRun(null)
        setError('')
        setLoading(false)
      }, [path])

      const discover = async () => {
        if (!path || loading) return
        const requestedPath = path
        const requestId = ++requestSequence.current
        const isCurrent = () =>
          activePath.current === requestedPath && requestSequence.current === requestId
        setLoading(true)
        setError('')
        try {
          const next = await TestExplorer.wework.testing.discover(PROVIDER_ID, {
            workspacePath: requestedPath,
          })
          if (!isCurrent()) return
          setReport(next)
          setSelected(new Set())
        } catch (reason) {
          if (isCurrent()) setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          if (isCurrent()) setLoading(false)
        }
      }

      useEffect(() => {
        if (visible && path) void discover()
      }, [path, visible])

      const groups = useMemo(() => {
        const values = new Map()
        for (const test of report?.tests ?? []) {
          const tests = values.get(test.group) ?? []
          tests.push(test)
          values.set(test.group, tests)
        }
        return [...values.entries()]
      }, [report])

      const runSelected = async () => {
        if (!path || loading) return
        const requestedPath = path
        const requestId = ++requestSequence.current
        const isCurrent = () =>
          activePath.current === requestedPath && requestSequence.current === requestId
        setLoading(true)
        setError('')
        setRun({ state: 'running', output: '正在启动测试…' })
        try {
          const next = await TestExplorer.wework.testing.run(PROVIDER_ID, {
            workspacePath: requestedPath,
            testIds: [...selected],
          })
          if (isCurrent()) setRun(next)
        } catch (reason) {
          if (isCurrent()) {
            setError(reason instanceof Error ? reason.message : String(reason))
            setRun(null)
          }
        } finally {
          if (isCurrent()) setLoading(false)
        }
      }

      const toggle = id => {
        setSelected(current => {
          const next = new Set(current)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }

      return createElement(
        'section',
        {
          className: 'flex h-full min-h-0 flex-col bg-background text-text-primary',
          'data-testid': 'test-explorer',
        },
        createElement(
          'header',
          { className: 'flex items-center gap-1 border-b border-border px-2 py-1.5' },
          createElement(
            'button',
            {
              type: 'button',
              disabled: loading || !path,
              onClick: () => void runSelected(),
              'aria-label': '运行选中的测试',
              'data-testid': 'test-explorer-run',
              className:
                'flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted disabled:opacity-40',
            },
            '▶'
          ),
          createElement(
            'button',
            {
              type: 'button',
              disabled: loading || !path,
              onClick: () => void discover(),
              'aria-label': '刷新测试',
              'data-testid': 'test-explorer-refresh',
              className:
                'flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted disabled:opacity-40',
            },
            '↻'
          ),
          createElement(
            'span',
            { className: 'ml-1 text-xs text-text-secondary' },
            report ? `${report.count} 个测试文件` : loading ? '发现测试中…' : '测试资源管理器'
          )
        ),
        error
          ? createElement(
              'p',
              {
                role: 'alert',
                className: 'm-2 rounded-lg bg-destructive/10 p-2 text-xs text-destructive',
                'data-testid': 'test-explorer-error',
              },
              error
            )
          : null,
        createElement(
          'div',
          {
            className: 'min-h-0 flex-1 overflow-auto px-1 py-2',
            'data-testid': 'test-explorer-tree',
          },
          groups.length
            ? groups.map(([group, tests]) =>
                createElement(
                  'div',
                  { key: group, className: 'mb-2' },
                  createElement(
                    'div',
                    { className: 'flex h-7 items-center gap-1 px-1 text-xs font-medium' },
                    createElement('span', { className: 'text-text-secondary' }, '⌄'),
                    createElement('span', { className: 'truncate' }, group),
                    createElement(
                      'span',
                      { className: 'ml-auto text-text-muted' },
                      String(tests.length)
                    )
                  ),
                  ...tests.map(test =>
                    createElement(
                      'button',
                      {
                        key: test.id,
                        type: 'button',
                        onClick: () => toggle(test.id),
                        'data-testid': `test-explorer-item-${test.id}`,
                        className:
                          'flex h-7 w-full items-center gap-2 rounded-md pl-5 pr-2 text-left text-xs hover:bg-muted',
                      },
                      createElement(
                        'span',
                        {
                          className: selected.has(test.id)
                            ? 'text-blue-500'
                            : 'text-text-secondary',
                        },
                        selected.has(test.id) ? '●' : '○'
                      ),
                      createElement('span', { className: 'min-w-0 flex-1 truncate' }, test.label),
                      createElement(
                        'span',
                        { className: 'text-text-muted' },
                        test.framework.replace(' runner', '')
                      )
                    )
                  )
                )
              )
            : createElement(
                'div',
                {
                  className:
                    'flex h-full items-center justify-center p-4 text-center text-xs text-text-secondary',
                },
                path ? (loading ? '正在发现测试…' : '没有发现测试文件') : '当前没有本地工作区'
              )
        ),
        run
          ? createElement(
              'aside',
              {
                className: 'max-h-40 border-t border-border bg-muted/20',
                'data-testid': 'test-explorer-output',
              },
              createElement(
                'div',
                { className: 'flex items-center justify-between px-2 py-1.5 text-xs' },
                createElement('span', { className: 'font-medium' }, '测试输出'),
                createElement(
                  'span',
                  {
                    className:
                      run.state === 'passed'
                        ? 'text-emerald-500'
                        : run.state === 'running'
                          ? 'text-blue-500'
                          : 'text-red-500',
                  },
                  run.state
                )
              ),
              createElement(
                'pre',
                {
                  className:
                    'max-h-28 overflow-auto whitespace-pre-wrap px-2 pb-2 text-code text-text-secondary',
                },
                run.output || run.command
              )
            )
          : null
      )
    }

    return {
      inject: ['slots', 'wework'],
      apply(ctx) {
        const backend = ctx.wework.backend.scope(PROVIDER_ID)
        ctx.wework.testing.providers.register(ctx, {
          id: PROVIDER_ID,
          label: 'Test Explorer',
          order: 10,
          discover: request => backend.request('discover', { cwd: request.workspacePath }),
          run: request =>
            backend.request('run', {
              cwd: request.workspacePath,
              testIds: request.testIds ?? [],
            }),
        })
        TestExplorer.wework = ctx.wework
        ctx.slots.inject('wework.workspace.sidebar.tab', function* () {
          yield ctx.wework.contributions.register(ctx, 'wework.workspace.sidebar.tab', {
            id: 'test-explorer.sidebar',
            label: 'Tests',
            icon: 'flask-conical',
            order: 20,
          })
          yield ctx.slots.register(
            {
              name: 'wework.workspace.sidebar.tab',
              id: 'test-explorer.sidebar',
              label: 'Tests',
              order: 20,
            },
            TestExplorer
          )
        })
      },
    }
  },
})
