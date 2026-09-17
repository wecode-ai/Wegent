const OPEN_EVENT = 'wework:conversation-export:open'

window.__ModuleLoader__.load({
  id: '@wegent/dsh-conversation-export',
  factory: () => ({
    inject: ['slots', 'wework'],
    apply(ctx) {
      const title = ctx.wework.localization.translate(
        { en: 'Export conversation', 'zh-CN': '导出会话' },
        'Export conversation'
      )
      ctx.wework.commands.register(
        ctx,
        {
          id: 'conversation-export.open',
          title,
          description: ctx.wework.localization.translate(
            {
              en: 'Export the complete conversation as Markdown or HTML.',
              'zh-CN': '将完整会话导出为 Markdown 或 HTML。',
            },
            'Export the complete conversation as Markdown or HTML.'
          ),
          icon: 'download',
        },
        reference => {
          if (!isConversationReference(reference)) {
            throw new Error('Conversation export requires a conversation reference')
          }
          window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: reference }))
        }
      )
      for (const location of ['conversation.toolbar', 'conversation.context']) {
        ctx.wework.menus.register(ctx, location, {
          id: `conversation-export.${location}`,
          command: 'conversation-export.open',
          group: 'export',
          order: 100,
        })
      }
      ctx.slots.inject('wework.shell.overlay', () =>
        ctx.wework.contributions.register(ctx, 'wework.shell.overlay', {
          id: 'conversation-export.dialog',
          module: 'plugins/wework-ui-conversation-export.js',
          order: 100,
        })
      )
    },
  }),
})

function isConversationReference(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof value.deviceId === 'string' &&
    value.deviceId &&
    typeof value.taskId === 'string' &&
    value.taskId
  )
}
