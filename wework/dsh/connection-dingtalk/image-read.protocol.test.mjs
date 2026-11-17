import assert from 'node:assert/strict'
import test from 'node:test'
import { ConnectionRegistry, parseConnections } from '../plugin-runtime/connections.js'
import { createProvider } from './provider.js'
import { readFile } from 'node:fs/promises'

test('download declarations cannot expose their host-owned output flag as a caller argument', async () => {
  const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
  const operation =
    manifest.wework.connections.providers[0].cliReadTools.dingtalk.operations.downloadImage
  operation.parameters.output = '--output'
  assert.throws(() => parseConnections(manifest), /host-owned CLI output file/)
})

// External DingTalk protocol double; the registry, schemas, source checks and cursor are real.
async function fixture(t) {
  const calls = []
  const source = {
    providerId: '@wegent/dsh-connection-dingtalk/dingtalk',
    kind: 'group',
    id: 'selected',
    profile: 'corp:user',
  }
  const message = {
    messageId: 'image-message',
    conversationId: source.id,
    text: '[图片消息](mediaId=@image-1)[图片消息](mediaId=@image-1)',
    senderId: 'sender',
    createTime: new Date().toISOString(),
  }
  const state = { message, download: { path: '/host/generated/image.png', readOnly: true } }
  const cli = {
    async callTool(alias, input) {
      assert.equal(alias, 'dingtalk')
      calls.push(input)
      if (input.tool === 'listProfiles')
        return { profiles: [{ profile: source.profile, userId: 'me', userName: 'Me' }] }
      if (input.tool === 'searchUsers') return { result: [{ userId: 'me', openDingTalkId: 'own' }] }
      if (input.tool === 'downloadImage') return state.download
      assert.equal(input.tool, 'listConversation')
      return {
        contractVersion: 'im.message-list.v1',
        paginationKnown: true,
        complete: true,
        failedCount: 0,
        failures: [],
        hasMore: false,
        messages: [state.message],
      }
    },
  }
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
    context: context => ({ ...context, cli }),
  })
  await registry.register({ effect() {} }, new URL('./package.json', import.meta.url), {
    dingtalk: createProvider(),
  })
  t.after(() => registry.dispose())
  return { calls, source, registry, state }
}

test('source image reads use native message/account tuples without Shell or caller output paths', async t => {
  const { calls, source, registry } = await fixture(t)
  const result = await registry.call(source.providerId, 'readSource', {
    source,
    query: { includeImages: true },
  })
  assert.equal(result.readOnly, true)
  assert.deepEqual(result.items[0].images, [
    { resourceId: '@image-1', path: '/host/generated/image.png' },
  ])
  assert.deepEqual(
    calls.filter(call => call.tool === 'downloadImage'),
    [
      {
        tool: 'downloadImage',
        arguments: {
          resourceId: '@image-1',
          messageId: 'image-message',
          conversationId: 'selected',
          profile: 'corp:user',
        },
      },
    ]
  )
  const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
  const operation =
    parseConnections(manifest).providers[0].cliReadTools.dingtalk.operations.downloadImage
  assert.deepEqual(operation.outputFile, { flag: '--output' })
  assert.equal(operation.parameters.output, undefined)
})

test('text-only reads do not download and foreign source messages cannot trigger downloads', async t => {
  const { calls, source, registry, state } = await fixture(t)
  await registry.call(source.providerId, 'readSource', { source })
  assert.equal(
    calls.some(call => call.tool === 'downloadImage'),
    false
  )
  state.message.conversationId = 'foreign'
  await assert.rejects(
    registry.call(source.providerId, 'readSource', {
      source,
      query: { includeImages: true },
    }),
    /another conversation/
  )
  assert.equal(
    calls.some(call => call.tool === 'downloadImage'),
    false
  )
})

test('image failures remain visible and never trigger another transport or login', async t => {
  const { calls, source, registry, state } = await fixture(t)
  state.download = { success: false, errorCode: 'connector_auth_required' }
  await assert.rejects(
    registry.call(source.providerId, 'readSource', {
      source,
      query: { includeImages: true },
    }),
    { code: 'connector_auth_required' }
  )
  assert.equal(calls.filter(call => call.tool === 'downloadImage').length, 1)
  assert.equal(
    calls.some(call => /login|reply|shell/i.test(call.tool)),
    false
  )
})
