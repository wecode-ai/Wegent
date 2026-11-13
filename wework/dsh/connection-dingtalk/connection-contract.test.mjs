import assert from 'node:assert/strict'
import test from 'node:test'
import { satisfies } from 'semver'
import { parseConnections } from '../plugin-runtime/connections.js'
import { connectionTools } from '../plugin-runtime/connection-tools.js'

test('DingTalk declares its bounded read operations against its exact dependency', async () => {
  const { readFile } = await import('node:fs/promises')
  const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
  const parsed = parseConnections(manifest)
  const declaration = parsed.providers[0].cliReadTools.dingtalk
  assert.deepEqual(Object.keys(declaration.operations).sort(), [
    'downloadImage',
    'listConversation',
    'listDirectConversation',
    'listMentions',
    'listProfiles',
    'listTopicReplies',
    'searchGroups',
    'searchMessages',
    'searchUsers',
  ])
  assert.deepEqual(declaration.operations.listProfiles.command, ['profile', 'list'])
  assert.equal(declaration.operations.listMentions.parameters.group, '--group')
  assert.deepEqual(declaration.outputArgs, ['--format', 'json'])
  assert.deepEqual(declaration.operations.listTopicReplies.command, [
    'chat',
    'message',
    'list-topic-replies',
  ])
  assert.equal(declaration.operations.listTopicReplies.parameters.topicId, '--topic-id')
  assert.equal(declaration.operations.listTopicReplies.parameters.direction, '--direction')
  assert.equal(
    declaration.operations.searchMessages.parameters.conversationIds,
    '--conversation-ids'
  )
  assert.deepEqual(declaration.operations.listConversation.command, [
    'chat',
    '+messages-list',
    '--forward=false',
  ])
  assert.equal(declaration.operations.listDirectConversation.parameters.peer, '--open-dingtalk-id')
  assert.equal(declaration.toolId, 'dws')
  assert.equal(declaration.connectorSlug, undefined)
})

test('DingTalk CLI reads bind to the actual declared installed marketplace', async () => {
  const { readFile } = await import('node:fs/promises')
  const definition = parseConnections(
    JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
  )
  for (const marketplaceId of ['wegent', 'wework']) {
    const source = { marketplaceId, pluginId: `dingtalk@${marketplaceId}` }
    const calls = []
    const tools = connectionTools(
      {
        providerId: '@wegent/dsh-connection-dingtalk/dingtalk',
        signal: new AbortController().signal,
        dependencies: [{ alias: 'dingtalk', ...definition.dependencies.dingtalk }],
      },
      {
        inventory: async () => [
          { ...source, name: 'dingtalk', installed: true, enabled: true, version: '0.2.2' },
        ],
      },
      async (method, params) => {
        calls.push({ method, params })
        return { success: true, currentProfile: 'existing-account' }
      },
      satisfies
    )
    assert.equal(
      (await tools.cli.callTool('dingtalk', { tool: 'listProfiles' })).currentProfile,
      'existing-account'
    )
    assert.deepEqual(calls[0].params.source, source)
    assert.equal(calls[0].params.expectedVersion, '0.2.2')
  }
})
