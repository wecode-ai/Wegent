window.__ModuleLoader__.load({
  id: '@wegent/dsh-workspace-copilot-demo',
  factory: require => {
    const React = require('react')
    const { createElement, useEffect, useState } = React
    const PROVIDER_ID = 'workspace-copilot'
    let activePath = ''
    let latest = null

    function contextMarkdown(report, intent = '理解并完成当前任务') {
      if (!report) return '请先选择一个本地代码工作区。'
      const languages = report.languages.map(item => `${item.label} (${item.count})`).join('、')
      return [
        `${intent}。请使用以下已验证的工作区事实，不要猜测仓库结构：`,
        '',
        `- 项目：${report.root}`,
        `- 文件数：${report.fileCount}`,
        `- 主要语言：${languages || '未识别'}`,
        `- 框架：${report.frameworks.join('、') || '未识别'}`,
        `- 可用脚本：${report.scripts.join('、') || '无'}`,
        `- 关键文件：${report.importantFiles.join('、') || '无'}`,
        '',
        '先阅读相关文件，再给出有证据的实现与验证结果。',
      ].join('\n')
    }

    function WorkspaceCopilotAction({ disabled, workspaceTarget }) {
      const [open, setOpen] = useState(false)
      const [report, setReport] = useState(latest)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState('')
      const workspacePath = workspaceTarget?.path ?? ''

      useEffect(() => {
        activePath = workspacePath
        if (latest?.path !== workspacePath) {
          latest = null
          setReport(null)
        }
      }, [workspacePath])

      const analyze = async () => {
        if (!activePath || loading) return
        setLoading(true)
        setError('')
        try {
          const result = await WorkspaceCopilotAction.wework.chat.prepareContext(PROVIDER_ID, {
            workspacePath: activePath,
          })
          latest = result.metadata.report
          setReport(latest)
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setLoading(false)
        }
      }

      useEffect(() => {
        if (open && activePath && !report && !loading) void analyze()
      }, [open])

      const insert = async intent => {
        if (!latest) await analyze()
        const result = await WorkspaceCopilotAction.wework.chat.prepareContext(PROVIDER_ID, {
          workspacePath: activePath,
          prompt: intent,
        })
        WorkspaceCopilotAction.wework.composer.insertText(result.text)
        WorkspaceCopilotAction.wework.composer.focus()
        setOpen(false)
      }

      const suggestion = (id, label, intent) =>
        createElement(
          'button',
          {
            type: 'button',
            disabled: loading || !activePath,
            onClick: () => void insert(intent),
            'data-testid': `workspace-copilot-suggestion-${id}`,
            className:
              'rounded-lg bg-muted/60 px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-40',
          },
          label
        )

      return createElement(
        'div',
        { className: 'relative' },
        createElement(
          'button',
          {
            type: 'button',
            disabled,
            onClick: () => setOpen(value => !value),
            'aria-label': '打开 Workspace Copilot',
            'data-testid': 'workspace-copilot-trigger',
            className:
              'flex h-7 min-w-7 items-center justify-center rounded-lg px-2 text-sm text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-40',
          },
          '✦'
        ),
        open
          ? createElement(
              'section',
              {
                className:
                  'absolute bottom-9 left-0 z-50 w-80 rounded-xl border border-border bg-popover p-3 text-text-primary shadow-lg',
                'data-testid': 'workspace-copilot-popover',
              },
              createElement(
                'header',
                { className: 'mb-3 flex items-start justify-between gap-3' },
                createElement(
                  'div',
                  null,
                  createElement('h2', { className: 'text-sm font-medium' }, 'Workspace Copilot'),
                  createElement(
                    'p',
                    { className: 'mt-1 text-xs text-text-secondary' },
                    report
                      ? `${report.fileCount} 个文件 · ${report.frameworks.join(' / ') || '通用项目'}`
                      : loading
                        ? '正在读取仓库上下文…'
                        : '基于当前仓库准备 AI 上下文'
                  )
                ),
                createElement(
                  'button',
                  {
                    type: 'button',
                    onClick: () => setOpen(false),
                    'aria-label': '关闭 Workspace Copilot',
                    'data-testid': 'workspace-copilot-close',
                    className: 'h-7 w-7 rounded-md text-text-secondary hover:bg-muted',
                  },
                  '×'
                )
              ),
              error
                ? createElement(
                    'p',
                    {
                      role: 'alert',
                      className: 'mb-2 text-xs text-destructive',
                      'data-testid': 'workspace-copilot-error',
                    },
                    error
                  )
                : null,
              createElement(
                'div',
                { className: 'grid gap-1.5' },
                suggestion('explain', '解释当前代码', '解释当前代码的职责、数据流与风险。'),
                suggestion('test', '补齐测试', '为当前改动补齐最小且有效的自动化测试。'),
                suggestion('review', '审查改动', '审查当前改动，重点检查正确性、回归风险和遗漏。')
              ),
              createElement(
                'button',
                {
                  type: 'button',
                  onClick: analyze,
                  disabled: loading || !activePath,
                  'data-testid': 'workspace-copilot-refresh',
                  className:
                    'mt-3 w-full rounded-lg border border-border px-2 py-1.5 text-xs text-text-secondary hover:bg-muted disabled:opacity-40',
                },
                loading ? '分析中…' : '刷新仓库上下文'
              )
            )
          : null
      )
    }

    return {
      inject: ['slots', 'wework'],
      apply(ctx) {
        const backend = ctx.wework.backend.scope(PROVIDER_ID)
        ctx.wework.chat.providers.register(ctx, {
          id: PROVIDER_ID,
          label: 'Workspace Copilot',
          order: 10,
          async prepareContext(request) {
            activePath = request.workspacePath || activePath
            if (!activePath) throw new Error('当前没有本地代码工作区')
            latest = await backend.request('analyze', { cwd: activePath })
            return {
              text: contextMarkdown(latest, request.prompt),
              metadata: { report: latest },
            }
          },
        })
        WorkspaceCopilotAction.wework = ctx.wework
        ctx.wework.commands.register(
          ctx,
          { id: 'workspace-copilot.insert', title: '插入工作区上下文', icon: 'sparkles' },
          async (_args, invocation) => {
            const result = await ctx.wework.chat.prepareContext(PROVIDER_ID, {
              workspacePath: activePath,
            })
            const composer = invocation.composer ?? ctx.wework.composer
            composer.insertText(result.text)
            composer.focus()
            return result.text
          }
        )
        ctx.wework.menus.register(ctx, 'composer.slash', {
          id: 'workspace-copilot.insert.slash',
          command: 'workspace-copilot.insert',
          title: '/workspace-context',
          icon: 'sparkles',
          order: 20,
        })
        ctx.slots.inject('wework.composer.action', function* () {
          yield ctx.wework.contributions.register(ctx, 'wework.composer.action', {
            id: 'workspace-copilot.action',
            label: 'Workspace Copilot',
            icon: 'sparkles',
            order: 10,
          })
          yield ctx.slots.register(
            {
              name: 'wework.composer.action',
              id: 'workspace-copilot.action',
              label: 'Workspace Copilot',
              order: 10,
            },
            WorkspaceCopilotAction
          )
        })
      },
    }
  },
})
