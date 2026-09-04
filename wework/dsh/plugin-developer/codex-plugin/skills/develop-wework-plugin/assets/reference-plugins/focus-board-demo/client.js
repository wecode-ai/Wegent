window.__ModuleLoader__.load({
  id: '@wegent/dsh-focus-board-demo',
  factory: require => {
    const React = require('react')
    const { createElement, useEffect, useState } = React
    const CONTEXT_KEY = 'focus-board.enabled'
    const STORAGE_NAMESPACE = 'focus-board'

    const initialItems = [
      { done: true, id: 'foundation', title: '确认插件扩展点契约' },
      { done: false, id: 'demo', title: '完成三个真实插件 Demo' },
      { done: false, id: 'verify', title: '在隔离 Wework 中验证并截图' },
    ]

    function workspaceTabPath(path, id, title) {
      const params = new URLSearchParams({ workspaceTab: id, workspaceTabTitle: title })
      return `${path}?${params}`
    }

    function createBoardStore(storage) {
      let items = storage.get('items', initialItems)
      const listeners = new Set()
      const publish = next => {
        items = next
        storage.set('items', items)
        for (const listener of listeners) listener(items)
      }
      return {
        add(title) {
          const normalized = title.trim()
          if (!normalized) return
          publish([
            ...items,
            { done: false, id: `item-${Date.now().toString(36)}`, title: normalized },
          ])
        },
        clearCompleted() {
          publish(items.filter(item => !item.done))
        },
        getItems() {
          return items
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        toggle(id) {
          publish(items.map(item => (item.id === id ? { ...item, done: !item.done } : item)))
        },
      }
    }

    function useBoard(store) {
      const [items, setItems] = useState(store.getItems())
      useEffect(() => store.subscribe(setItems), [store])
      return items
    }

    function ProgressRing({ completed, total }) {
      const ratio = total === 0 ? 0 : Math.round((completed / total) * 100)
      return createElement(
        'div',
        {
          style: {
            alignItems: 'center',
            background: `conic-gradient(#14b8a6 ${ratio}%, rgba(20,184,166,.12) 0)`,
            borderRadius: '50%',
            display: 'flex',
            height: '86px',
            justifyContent: 'center',
            width: '86px',
          },
        },
        createElement(
          'div',
          {
            style: {
              alignItems: 'center',
              background: 'rgb(var(--color-background))',
              borderRadius: '50%',
              display: 'flex',
              flexDirection: 'column',
              height: '66px',
              justifyContent: 'center',
              width: '66px',
            },
          },
          createElement('strong', { style: { fontSize: '20px' } }, `${ratio}%`),
          createElement(
            'span',
            { style: { color: 'rgb(var(--color-text-muted))', fontSize: '10px' } },
            'DONE'
          )
        )
      )
    }

    function FocusBoardPage({ store }) {
      const items = useBoard(store)
      const [draft, setDraft] = useState('')
      const completed = items.filter(item => item.done).length
      const add = () => {
        store.add(draft)
        setDraft('')
      }

      return createElement(
        'main',
        {
          'data-testid': 'focus-board-page',
          style: {
            background:
              'linear-gradient(135deg, rgba(20,184,166,.10), transparent 42%), rgb(var(--color-background))',
            color: 'rgb(var(--color-text-primary))',
            height: '100%',
            overflow: 'auto',
            padding: '36px clamp(24px, 5vw, 68px)',
          },
        },
        createElement(
          'div',
          { style: { margin: '0 auto', maxWidth: '920px' } },
          createElement(
            'header',
            {
              style: {
                alignItems: 'center',
                display: 'flex',
                gap: '28px',
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
                    color: '#0f9f91',
                    fontSize: '12px',
                    fontWeight: 700,
                    letterSpacing: '.14em',
                    textTransform: 'uppercase',
                  },
                },
                'Today · Focus Queue'
              ),
              createElement(
                'h1',
                { style: { fontSize: '34px', letterSpacing: '-.035em', margin: '8px 0' } },
                'Focus Board'
              ),
              createElement(
                'p',
                { style: { color: 'rgb(var(--color-text-secondary))', margin: 0 } },
                `${items.length - completed} 项待推进 · ${completed} 项已完成`
              )
            ),
            createElement(ProgressRing, { completed, total: items.length })
          ),
          createElement(
            'section',
            {
              style: {
                background: 'rgb(var(--color-bg-surface))',
                border: '1px solid rgb(var(--color-border))',
                borderRadius: '18px',
                boxShadow: '0 18px 55px rgba(15,23,42,.06)',
                marginTop: '30px',
                overflow: 'hidden',
              },
            },
            createElement(
              'form',
              {
                onSubmit: event => {
                  event.preventDefault()
                  add()
                },
                style: {
                  borderBottom: '1px solid rgb(var(--color-border))',
                  display: 'flex',
                  gap: '10px',
                  padding: '16px',
                },
              },
              createElement('input', {
                'data-testid': 'focus-board-input',
                onChange: event => setDraft(event.target.value),
                placeholder: '添加下一件需要专注完成的事…',
                style: {
                  background: 'rgb(var(--color-background))',
                  border: '1px solid rgb(var(--color-border))',
                  borderRadius: '10px',
                  color: 'inherit',
                  flex: 1,
                  minHeight: '42px',
                  outline: 'none',
                  padding: '0 13px',
                },
                value: draft,
              }),
              createElement(
                'button',
                {
                  'data-testid': 'focus-board-add',
                  disabled: !draft.trim(),
                  style: {
                    background: '#0f9f91',
                    border: 0,
                    borderRadius: '10px',
                    color: 'white',
                    cursor: 'pointer',
                    fontWeight: 700,
                    minWidth: '88px',
                  },
                  type: 'submit',
                },
                '添加'
              )
            ),
            createElement(
              'div',
              { style: { padding: '8px 16px 4px' } },
              ...items.map((item, index) =>
                createElement(
                  'button',
                  {
                    'data-testid': `focus-board-item-${item.id}`,
                    key: item.id,
                    onClick: () => store.toggle(item.id),
                    style: {
                      alignItems: 'center',
                      background: 'transparent',
                      border: 0,
                      borderBottom:
                        index === items.length - 1 ? 0 : '1px solid rgb(var(--color-border) / .55)',
                      color: 'inherit',
                      cursor: 'pointer',
                      display: 'flex',
                      gap: '13px',
                      minHeight: '58px',
                      padding: '0 4px',
                      textAlign: 'left',
                      width: '100%',
                    },
                    type: 'button',
                  },
                  createElement(
                    'span',
                    {
                      style: {
                        alignItems: 'center',
                        background: item.done ? '#14b8a6' : 'transparent',
                        border: `2px solid ${item.done ? '#14b8a6' : 'rgb(var(--color-border))'}`,
                        borderRadius: '50%',
                        color: 'white',
                        display: 'flex',
                        flexShrink: 0,
                        fontSize: '11px',
                        height: '22px',
                        justifyContent: 'center',
                        width: '22px',
                      },
                    },
                    item.done ? '✓' : ''
                  ),
                  createElement(
                    'span',
                    {
                      style: {
                        color: item.done
                          ? 'rgb(var(--color-text-muted))'
                          : 'rgb(var(--color-text-primary))',
                        textDecoration: item.done ? 'line-through' : 'none',
                      },
                    },
                    item.title
                  )
                )
              )
            ),
            createElement(
              'footer',
              {
                style: {
                  alignItems: 'center',
                  background: 'rgba(20,184,166,.05)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '12px 18px',
                },
              },
              createElement(
                'span',
                { style: { color: 'rgb(var(--color-text-muted))', fontSize: '12px' } },
                '输入 /focus 可把当前进度插入对话'
              ),
              createElement(
                'button',
                {
                  'data-testid': 'focus-board-clear-completed',
                  onClick: () => store.clearCompleted(),
                  style: {
                    background: 'transparent',
                    border: 0,
                    color: '#0f9f91',
                    cursor: 'pointer',
                    fontWeight: 700,
                  },
                  type: 'button',
                },
                '清除已完成'
              )
            )
          )
        )
      )
    }

    function FocusBottomPanel({ store, visible }) {
      const items = useBoard(store)
      const pending = items.filter(item => !item.done)
      return createElement(
        'div',
        {
          'data-testid': 'focus-board-bottom-panel',
          hidden: !visible,
          style: {
            color: 'rgb(var(--color-text-primary))',
            display: visible ? 'grid' : 'none',
            gap: '8px',
            gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
            padding: '14px',
          },
        },
        ...(pending.length > 0
          ? pending.map(item =>
              createElement(
                'button',
                {
                  key: item.id,
                  onClick: () => store.toggle(item.id),
                  style: {
                    background: 'rgb(var(--color-bg-surface))',
                    border: '1px solid rgb(var(--color-border))',
                    borderRadius: '10px',
                    color: 'inherit',
                    cursor: 'pointer',
                    padding: '11px 12px',
                    textAlign: 'left',
                  },
                  type: 'button',
                },
                `○ ${item.title}`
              )
            )
          : [createElement('span', { key: 'empty' }, '今天的 Focus Queue 已全部完成。')])
      )
    }

    return {
      inject: ['slots', 'wework'],
      apply(ctx) {
        const store = createBoardStore(ctx.wework.storage.scope(STORAGE_NAMESPACE))
        ctx.wework.context.set(ctx, CONTEXT_KEY, true)
        ctx.wework.commands.register(
          ctx,
          {
            category: 'Focus Board',
            description: 'Insert the current Focus Board summary into the Composer.',
            id: 'focus-board.insert-summary',
            title: '插入 Focus Board 进度',
          },
          (_args, invocation) => {
            const items = store.getItems()
            const lines = items.map(item => `- [${item.done ? 'x' : ' '}] ${item.title}`)
            const summary = `当前 Focus Board：\n${lines.join('\n')}\n`
            if (invocation.composer) invocation.composer.insertText(summary)
            return summary
          }
        )
        ctx.wework.menus.register(ctx, 'composer.slash', {
          command: 'focus-board.insert-summary',
          group: 'Focus Board',
          id: 'focus-board.slash-summary',
          order: 42,
        })
        ctx.wework.composer.references.register(ctx, {
          description: 'Reference the persistent personal Focus Board.',
          id: 'focus-board.reference',
          metaLabel: 'Focus Board',
          reference: '[$Focus Board](focus-board://today)',
          searchAliases: ['focus', 'todo', '任务'],
          title: '今天的 Focus Board',
          when: CONTEXT_KEY,
        })

        const Page = () => createElement(FocusBoardPage, { store })
        const BottomPanel = props => createElement(FocusBottomPanel, { ...props, store })
        ctx.slots.inject('wework.route', function* () {
          const descriptor = {
            icon: 'list-checks',
            id: 'focus-board.route',
            path: '/focus-board',
            restorePolicy: 'session',
            telemetryFeature: 'plugins',
            title: 'Focus Board',
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
            activeItem: 'focus-board',
            icon: 'list-checks',
            id: 'focus-board.navigation',
            label: 'Focus Board',
            order: 42,
            path: workspaceTabPath('/focus-board', 'plugin-focus-board', 'Focus Board'),
            testId: 'focus-board-navigation',
          })
        )
        ctx.slots.inject('wework.workspace.bottom-panel.tab', function* () {
          const descriptor = {
            icon: 'list-checks',
            id: 'focus-board.bottom-panel',
            label: 'Focus',
            order: 42,
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
