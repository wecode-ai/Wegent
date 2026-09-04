window.__ModuleLoader__.load({
  id: '@wegent/dsh-workspace-copilot-demo',
  factory: require => {
    const React = require('react')
    const { createElement, useEffect, useRef, useState } = React
    const PROVIDER_ID = 'workspace-copilot'
    let activePath = ''

    function localized(zhCN, en) {
      return (
        WorkspaceCopilotAction.wework?.localization.translate({ en, 'zh-CN': zhCN }, zhCN) ?? zhCN
      )
    }

    function contextMarkdown(
      report,
      intent = localized('理解并完成当前任务', 'Understand and complete the current task')
    ) {
      if (!report) {
        return localized('请先选择一个本地代码工作区。', 'Select a local code workspace first.')
      }
      const separator = localized('、', ', ')
      const languages = report.languages
        .map(item => `${item.label} (${item.count})`)
        .join(separator)
      return [
        localized(
          `${intent}。请使用以下已验证的工作区事实，不要猜测仓库结构：`,
          `${intent}. Use the following verified workspace facts instead of guessing the repository structure:`
        ),
        '',
        localized(`- 项目：${report.root}`, `- Project: ${report.root}`),
        localized(`- 文件数：${report.fileCount}`, `- Files: ${report.fileCount}`),
        localized(
          `- 主要语言：${languages || '未识别'}`,
          `- Primary languages: ${languages || 'Unknown'}`
        ),
        localized(
          `- 框架：${report.frameworks.join(separator) || '未识别'}`,
          `- Frameworks: ${report.frameworks.join(separator) || 'Unknown'}`
        ),
        localized(
          `- 可用脚本：${report.scripts.join(separator) || '无'}`,
          `- Available scripts: ${report.scripts.join(separator) || 'None'}`
        ),
        localized(
          `- 关键文件：${report.importantFiles.join(separator) || '无'}`,
          `- Important files: ${report.importantFiles.join(separator) || 'None'}`
        ),
        '',
        localized(
          '先阅读相关文件，再给出有证据的实现与验证结果。',
          'Read the relevant files first, then provide an evidence-backed implementation and verification result.'
        ),
      ].join('\n')
    }

    function WorkspaceCopilotAction({ disabled, workspaceTarget }) {
      const [open, setOpen] = useState(false)
      const [report, setReport] = useState(null)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState('')
      const workspacePath = workspaceTarget?.path ?? ''
      const currentPath = useRef(workspacePath)
      const requestSequence = useRef(0)
      if (currentPath.current !== workspacePath) {
        currentPath.current = workspacePath
        requestSequence.current += 1
      }
      activePath = workspacePath

      useEffect(() => {
        setReport(null)
        setError('')
        setLoading(false)
      }, [workspacePath])

      const analyze = async () => {
        if (!workspacePath || loading) return null
        const requestPath = workspacePath
        const requestId = ++requestSequence.current
        const isCurrent = () =>
          currentPath.current === requestPath && requestSequence.current === requestId
        setLoading(true)
        setError('')
        try {
          const result = await WorkspaceCopilotAction.wework.chat.prepareContext(PROVIDER_ID, {
            workspacePath: requestPath,
          })
          if (!isCurrent()) return null
          setReport(result.metadata.report)
          return result.metadata.report
        } catch (reason) {
          if (isCurrent()) setError(reason instanceof Error ? reason.message : String(reason))
          return null
        } finally {
          if (isCurrent()) setLoading(false)
        }
      }

      useEffect(() => {
        if (open && workspacePath && !report && !loading) void analyze()
      }, [open, workspacePath])

      const insert = async intent => {
        if (!workspacePath || loading) return
        const requestPath = workspacePath
        const requestId = ++requestSequence.current
        const isCurrent = () =>
          currentPath.current === requestPath && requestSequence.current === requestId
        setLoading(true)
        setError('')
        try {
          const result = await WorkspaceCopilotAction.wework.chat.prepareContext(PROVIDER_ID, {
            workspacePath: requestPath,
            prompt: intent,
          })
          if (!isCurrent()) return
          WorkspaceCopilotAction.wework.composer.insertText(result.text)
          WorkspaceCopilotAction.wework.composer.focus()
          setOpen(false)
        } catch (reason) {
          if (isCurrent()) setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          if (isCurrent()) setLoading(false)
        }
      }

      const suggestion = (id, label, intent) =>
        createElement(
          'button',
          {
            type: 'button',
            disabled: loading || !workspacePath,
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
            'aria-label': localized('打开 Workspace Copilot', 'Open Workspace Copilot'),
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
                      ? localized(
                          `${report.fileCount} 个文件 · ${report.frameworks.join(' / ') || '通用项目'}`,
                          `${report.fileCount} files · ${report.frameworks.join(' / ') || 'General project'}`
                        )
                      : loading
                        ? localized('正在读取仓库上下文…', 'Reading repository context…')
                        : localized(
                            '基于当前仓库准备 AI 上下文',
                            'Prepare AI context from the current repository'
                          )
                  )
                ),
                createElement(
                  'button',
                  {
                    type: 'button',
                    onClick: () => setOpen(false),
                    'aria-label': localized('关闭 Workspace Copilot', 'Close Workspace Copilot'),
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
                suggestion(
                  'explain',
                  localized('解释当前代码', 'Explain current code'),
                  localized(
                    '解释当前代码的职责、数据流与风险。',
                    'Explain the responsibilities, data flow, and risks of the current code.'
                  )
                ),
                suggestion(
                  'test',
                  localized('补齐测试', 'Add missing tests'),
                  localized(
                    '为当前改动补齐最小且有效的自动化测试。',
                    'Add the smallest effective automated tests for the current changes.'
                  )
                ),
                suggestion(
                  'review',
                  localized('审查改动', 'Review changes'),
                  localized(
                    '审查当前改动，重点检查正确性、回归风险和遗漏。',
                    'Review the current changes for correctness, regression risks, and omissions.'
                  )
                )
              ),
              createElement(
                'button',
                {
                  type: 'button',
                  onClick: analyze,
                  disabled: loading || !workspacePath,
                  'data-testid': 'workspace-copilot-refresh',
                  className:
                    'mt-3 w-full rounded-lg border border-border px-2 py-1.5 text-xs text-text-secondary hover:bg-muted disabled:opacity-40',
                },
                loading
                  ? localized('分析中…', 'Analyzing…')
                  : localized('刷新仓库上下文', 'Refresh workspace context')
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
            const workspacePath = request.workspacePath
            if (!workspacePath) {
              throw new Error(
                localized('当前没有本地代码工作区', 'No local code workspace is currently selected')
              )
            }
            const report = await backend.request('analyze', { cwd: workspacePath })
            return {
              text: contextMarkdown(report, request.prompt),
              metadata: { report },
            }
          },
        })
        WorkspaceCopilotAction.wework = ctx.wework
        ctx.wework.commands.register(
          ctx,
          {
            id: 'workspace-copilot.insert',
            title: localized('插入工作区上下文', 'Insert workspace context'),
            icon: 'sparkles',
          },
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
