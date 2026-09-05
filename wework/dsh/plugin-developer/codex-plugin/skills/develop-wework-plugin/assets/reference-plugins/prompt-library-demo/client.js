window.__ModuleLoader__.load({
  id: '@wegent/dsh-prompt-library-demo',
  factory: require => {
    const React = require('react')
    const { createElement, useState } = React
    const CONFIGURATION_ID = 'prompt-library.settings'
    const CONTEXT_KEY = 'prompt-library.enabled'

    const prompts = [
      {
        accent: '#8b5cf6',
        aliases: ['review', 'code review', '审查'],
        description: '从正确性、边界条件、可维护性和测试证据四个维度审查当前改动。',
        id: 'review',
        label: '审查改动',
        template:
          '请审查当前改动。重点检查：\n1. 正确性与边界条件\n2. 重复或冲突逻辑\n3. 安全与性能风险\n4. 缺失的测试证据\n\n请按严重程度给出可执行建议。',
      },
      {
        accent: '#0ea5e9',
        aliases: ['plan', 'implementation plan', '计划'],
        description: '把目标拆成有顺序、可验证、可回滚的实施步骤。',
        id: 'plan',
        label: '制定计划',
        template:
          '请先从第一性原理澄清目标与约束，再给出实施计划。每一步必须包含：产出、验证方式、主要风险，以及与前后步骤的依赖。',
      },
      {
        accent: '#10b981',
        aliases: ['explain', 'teach', '解释'],
        description: '用结构、数据流和一个具体例子解释复杂实现。',
        id: 'explain',
        label: '解释实现',
        template:
          '请解释当前实现：先给出一句话结论，再描述关键模块和数据流，最后用一个具体输入演示执行过程。避免只复述代码。',
      },
    ]

    function workspaceTabPath(path, id, title) {
      const params = new URLSearchParams({ workspaceTab: id, workspaceTabTitle: title })
      return `${path}?${params}`
    }

    function PromptLibraryPage({ service }) {
      const initial = service.configuration.get(CONFIGURATION_ID)?.defaultPrompt ?? 'review'
      const [defaultPrompt, setDefaultPrompt] = useState(initial)
      const selectDefault = id => {
        service.configuration.update(CONFIGURATION_ID, { defaultPrompt: id })
        setDefaultPrompt(id)
      }

      return createElement(
        'main',
        {
          'data-testid': 'prompt-library-page',
          style: {
            background:
              'radial-gradient(circle at 12% 8%, rgba(139,92,246,.14), transparent 34%), rgb(var(--color-background))',
            color: 'rgb(var(--color-text-primary))',
            height: '100%',
            overflow: 'auto',
            padding: '38px clamp(24px, 5vw, 72px)',
          },
        },
        createElement(
          'div',
          { style: { margin: '0 auto', maxWidth: '980px' } },
          createElement(
            'header',
            {
              style: {
                alignItems: 'end',
                display: 'flex',
                gap: '24px',
                justifyContent: 'space-between',
              },
            },
            createElement(
              'div',
              null,
              createElement(
                'div',
                {
                  style: {
                    color: '#8b5cf6',
                    fontSize: '12px',
                    fontWeight: 700,
                    letterSpacing: '.14em',
                    textTransform: 'uppercase',
                  },
                },
                'Composer Toolkit'
              ),
              createElement(
                'h1',
                { style: { fontSize: '34px', letterSpacing: '-.03em', margin: '8px 0 10px' } },
                'Prompt Library'
              ),
              createElement(
                'p',
                {
                  style: {
                    color: 'rgb(var(--color-text-secondary))',
                    lineHeight: 1.65,
                    margin: 0,
                    maxWidth: '620px',
                  },
                },
                '把团队常用的高质量提示词变成可发现、可配置、可复用的 Composer 命令。'
              )
            ),
            createElement(
              'div',
              {
                style: {
                  background: 'rgba(139,92,246,.1)',
                  border: '1px solid rgba(139,92,246,.25)',
                  borderRadius: '14px',
                  color: '#7c3aed',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '13px',
                  padding: '10px 14px',
                },
              },
              '输入 / 打开命令'
            )
          ),
          createElement(
            'section',
            {
              style: {
                display: 'grid',
                gap: '16px',
                gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
                marginTop: '34px',
              },
            },
            ...prompts.map(prompt =>
              createElement(
                'article',
                {
                  'data-testid': `prompt-library-card-${prompt.id}`,
                  key: prompt.id,
                  style: {
                    background: 'rgb(var(--color-bg-surface))',
                    border: `1px solid ${defaultPrompt === prompt.id ? prompt.accent : 'rgb(var(--color-border))'}`,
                    borderRadius: '18px',
                    boxShadow:
                      defaultPrompt === prompt.id
                        ? `0 18px 50px ${prompt.accent}1f`
                        : '0 10px 30px rgba(15,23,42,.04)',
                    display: 'flex',
                    flexDirection: 'column',
                    minHeight: '286px',
                    padding: '22px',
                  },
                },
                createElement(
                  'div',
                  {
                    style: {
                      alignItems: 'center',
                      display: 'flex',
                      justifyContent: 'space-between',
                    },
                  },
                  createElement(
                    'span',
                    {
                      style: {
                        background: `${prompt.accent}18`,
                        borderRadius: '999px',
                        color: prompt.accent,
                        fontFamily: 'var(--font-mono)',
                        fontSize: '12px',
                        fontWeight: 700,
                        padding: '6px 10px',
                      },
                    },
                    `/${prompt.id}`
                  ),
                  defaultPrompt === prompt.id
                    ? createElement(
                        'span',
                        { style: { color: prompt.accent, fontSize: '12px', fontWeight: 700 } },
                        '默认'
                      )
                    : null
                ),
                createElement(
                  'h2',
                  { style: { fontSize: '18px', margin: '20px 0 8px' } },
                  prompt.label
                ),
                createElement(
                  'p',
                  {
                    style: {
                      color: 'rgb(var(--color-text-secondary))',
                      fontSize: '14px',
                      lineHeight: 1.65,
                      margin: 0,
                    },
                  },
                  prompt.description
                ),
                createElement(
                  'button',
                  {
                    'data-testid': `prompt-library-default-${prompt.id}`,
                    disabled: defaultPrompt === prompt.id,
                    onClick: () => selectDefault(prompt.id),
                    style: {
                      background:
                        defaultPrompt === prompt.id ? `${prompt.accent}12` : 'transparent',
                      border: `1px solid ${defaultPrompt === prompt.id ? prompt.accent : 'rgb(var(--color-border))'}`,
                      borderRadius: '10px',
                      color:
                        defaultPrompt === prompt.id
                          ? prompt.accent
                          : 'rgb(var(--color-text-primary))',
                      cursor: defaultPrompt === prompt.id ? 'default' : 'pointer',
                      marginTop: 'auto',
                      minHeight: '38px',
                    },
                    type: 'button',
                  },
                  defaultPrompt === prompt.id ? '当前默认模板' : '设为默认模板'
                )
              )
            )
          )
        )
      )
    }

    function registerPrompt(ctx, prompt) {
      const command = `prompt-library.insert-${prompt.id}`
      ctx.wework.commands.register(
        ctx,
        {
          category: 'Prompt Library',
          description: prompt.description,
          id: command,
          title: prompt.label,
        },
        (_args, invocation) => {
          if (!invocation.composer) {
            return ctx.wework.host.notification.show({
              body: `在 Composer 中输入 /${prompt.id} 使用此模板。`,
              title: 'Prompt Library',
            })
          }
          invocation.composer.insertText(`${prompt.template}\n`)
          return prompt.id
        }
      )
      ctx.wework.menus.register(ctx, 'composer.slash', {
        command,
        group: 'Prompt Library',
        id: `prompt-library.slash-${prompt.id}`,
        order: 30 + prompts.indexOf(prompt),
      })
    }

    return {
      inject: ['slots', 'wework'],
      apply(ctx) {
        ctx.wework.context.set(ctx, CONTEXT_KEY, true)
        ctx.wework.configuration.register(ctx, {
          defaults: { defaultPrompt: 'review' },
          description: 'Prompt Library preferences.',
          id: CONFIGURATION_ID,
          properties: { defaultPrompt: { enum: prompts.map(prompt => prompt.id), type: 'string' } },
          title: 'Prompt Library',
        })
        for (const prompt of prompts) registerPrompt(ctx, prompt)

        ctx.wework.composer.references.register(ctx, {
          description: 'Reusable review, planning, and explanation templates.',
          id: 'prompt-library.catalog-reference',
          metaLabel: 'Prompt Library',
          reference: '[$Prompt Library](prompt-library://catalog)',
          searchAliases: ['prompt', 'template', '提示词'],
          title: 'Prompt Library 模板集',
          when: CONTEXT_KEY,
        })

        const Page = () => createElement(PromptLibraryPage, { service: ctx.wework })
        ctx.slots.inject('wework.route', function* () {
          const descriptor = {
            icon: 'sparkles',
            id: 'prompt-library.route',
            path: '/prompt-library',
            restorePolicy: 'session',
            telemetryFeature: 'plugins',
            title: 'Prompt Library',
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
            activeItem: 'prompt-library',
            icon: 'sparkles',
            id: 'prompt-library.navigation',
            label: 'Prompt Library',
            order: 41,
            path: workspaceTabPath('/prompt-library', 'plugin-prompt-library', 'Prompt Library'),
            testId: 'prompt-library-navigation',
          })
        )
      },
    }
  },
})
