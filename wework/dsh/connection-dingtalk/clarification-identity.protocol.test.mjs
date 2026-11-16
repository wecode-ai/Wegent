import assert from 'node:assert/strict'
import test from 'node:test'
import { ConnectionRegistry } from '../plugin-runtime/connections.js'
import { createProvider } from './provider.js'

// Only the external DingTalk responses are simulated; registry and schemas stay real.
test('protocol integration preserves account-verified clarification identity on native reads', async t => {
  const profile = 'corp:owner'
  const registry = new ConnectionRegistry({
    inventory: async () => [
      {
        marketplaceId: 'wework',
        pluginId: 'dingtalk@wework',
        name: 'dingtalk',
        installed: true,
        enabled: true,
        version: '0.3.4',
      },
    ],
    satisfies: () => true,
    context: context => ({
      ...context,
      cli: {
        async callTool(alias, { tool, arguments: args }) {
          assert.equal(alias, 'dingtalk')
          if (tool === 'listProfiles')
            return { profiles: [{ profile, userId: 'owner', userName: 'Same name' }] }
          if (tool === 'searchUsers')
            return { result: [{ userId: 'owner', openDingTalkId: 'own' }] }
          assert.ok(['listDirectConversation', 'listConversation'].includes(tool))
          assert.equal(args.profile, profile)
          return {
            contractVersion: 'im.message-list.v1',
            paginationKnown: true,
            failedCount: 0,
            hasMore: false,
            messages: [
              {
                messageId: 'clarification',
                conversationId: args.group ?? `chat-${args.peer}`,
                senderId: 'own',
                sender: 'Same name',
                text: 'Which tasks?',
                createTime: new Date(Date.now() - 60000).toISOString(),
                isSelfConversation: true,
              },
            ],
          }
        },
      },
    }),
  })
  await registry.register({ effect() {} }, new URL('./package.json', import.meta.url), {
    dingtalk: createProvider(),
  })
  t.after(() => registry.dispose())
  for (const [kind, id, selfChat] of [
    ['direct', 'own', true],
    ['direct', 'someone-else', false],
    ['group', 'group', false],
  ]) {
    const source = {
      providerId: '@wegent/dsh-connection-dingtalk/dingtalk',
      profile,
      kind,
      id,
      name: 'Same name',
    }
    const result = await registry.call(source.providerId, 'readSource', { source })
    assert.equal(result.items[0].isOwn, true)
    assert.equal(result.items[0].isSelfConversation, selfChat)
    assert.equal(result.hasMore, false)
  }
})
