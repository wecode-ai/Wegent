import assert from 'node:assert/strict'
import test from 'node:test'
import { satisfies } from 'semver'
import { connectionTools } from '../plugin-runtime/connection-tools.js'
const connectionMcp = (...args) => connectionTools(...args).mcp
import { parseConnections } from '../plugin-runtime/connections.js'

function fixture() {
  const controller = new AbortController()
  const identity = {
    providerId: '@test/mail/inbox',
    signal: controller.signal,
    dependencies: [
      {
        alias: 'mail',
        kind: 'codexPlugin',
        source: {
          marketplaceId: 'company',
          pluginId: 'mail@company',
        },
        version: '^1.0.0',
      },
    ],
  }
  const installed = [
    {
      ...identity.dependencies[0].source,
      name: 'mail',
      installed: true,
      enabled: true,
      version: '1.2.0',
    },
  ]
  const calls = []
  const deps = { inventory: async () => installed }
  const response = {
    content: [{ type: 'text', text: 'mail' }],
    isError: true,
    _meta: { code: 'need_login' },
  }
  const mcp = connectionMcp(
    identity,
    deps,
    async (method, params) => {
      calls.push({ method, params })
      return response
    },
    satisfies
  )
  return { controller, identity, installed, calls, mcp, response, deps }
}

test('direct MCP calls preserve tool results and derive identity only from declared dependencies', async () => {
  const f = fixture()
  assert.deepEqual(
    await f.mcp.callTool('mail', {
      server: 'mail',
      tool: 'read',
      arguments: { id: '1' },
      source: { marketplaceId: 'evil', pluginId: 'evil@evil' },
      dependencyAlias: 'injected',
      operation: 'turn/start',
      readTools: [{ server: 'evil', tool: 'write' }],
      _meta: { grant: true },
    }),
    f.response
  )
  assert.deepEqual(f.calls, [
    {
      method: 'runtime.connections.mcp',
      params: {
        providerId: '@test/mail/inbox',
        dependencyAlias: 'mail',
        source: { marketplaceId: 'company', pluginId: 'mail@company' },
        expectedVersion: '1.2.0',
        operation: 'callTool',
        server: 'mail',
        tool: 'read',
        arguments: { id: '1' },
      },
    },
  ])
  assert.equal(Object.isFrozen(f.mcp), true)
})

test('tool discovery uses the same dependency boundary and never invokes a model', async () => {
  const f = fixture()
  await f.mcp.listTools('mail')
  assert.equal(f.calls[0].params.operation, 'listTools')
  assert.equal(f.calls[0].method, 'runtime.connections.mcp')
  await assert.rejects(f.mcp.listTools('other'), { code: 'connection_dependency_denied' })
  assert.equal(f.calls.length, 1)
})

test('provider mutations cannot change the captured dependency identity', async () => {
  const f = fixture()
  f.identity.dependencies[0].source = { marketplaceId: 'other', pluginId: 'mail@other' }
  f.identity.dependencies.push({
    alias: 'injected',
    kind: 'codexPlugin',
    source: { marketplaceId: 'company', pluginId: 'mail@company' },
    version: '*',
  })
  await f.mcp.listTools('mail')
  assert.deepEqual(f.calls[0].params.source, { marketplaceId: 'company', pluginId: 'mail@company' })
  await assert.rejects(f.mcp.listTools('injected'), { code: 'connection_dependency_denied' })
})

test('each call revalidates missing, disabled and incompatible shared dependencies', async () => {
  for (const status of ['disabled', 'incompatible', 'missing']) {
    const f = fixture()
    if (status === 'disabled') f.installed[0].enabled = false
    if (status === 'incompatible') f.installed[0].version = '2.0.0'
    if (status === 'missing') f.installed.splice(0)
    await assert.rejects(f.mcp.callTool('mail', { server: 'mail', tool: 'read' }), {
      code: `dependency_${status}`,
    })
    assert.equal(f.calls.length, 0)
  }
})

test('disposed provider contexts cannot call MCP or accept an in-flight result', async () => {
  const f = fixture()
  f.controller.abort()
  await assert.rejects(f.mcp.listTools('mail'), { name: 'AbortError' })
  assert.equal(f.calls.length, 0)
  const live = fixture()
  live.deps.inventory = async () => {
    live.controller.abort()
    return live.installed
  }
  await assert.rejects(live.mcp.listTools('mail'), { name: 'AbortError' })
  assert.equal(live.calls.length, 0)
  const controller = new AbortController()
  const mcp = connectionMcp(
    { ...live.identity, signal: controller.signal },
    { inventory: async () => live.installed },
    async () => {
      controller.abort()
      return live.response
    },
    satisfies
  )
  await assert.rejects(mcp.listTools('mail'), { name: 'AbortError' })
})

test('transport errors are propagated without automatically replaying tool calls', async () => {
  const f = fixture()
  let count = 0
  const mcp = connectionMcp(
    f.identity,
    f.deps,
    async () => {
      count++
      throw Object.assign(new Error('unknown outcome'), { code: 'connection_mcp_timeout' })
    },
    satisfies
  )
  await assert.rejects(mcp.callTool('mail', { server: 'mail', tool: 'read' }), {
    code: 'connection_mcp_timeout',
  })
  assert.equal(count, 1)
})

test('legacy read tool declarations belong only to the provider declared dependency', () => {
  const manifest = {
    name: '@test/mail',
    wework: {
      connections: {
        apiVersion: 1,
        dependencies: {
          mail: {
            kind: 'codexPlugin',
            source: { marketplaceId: 'company', pluginId: 'mail@company' },
            version: '*',
          },
        },
        providers: [
          {
            id: 'inbox',
            displayName: 'Mail',
            uses: ['mail'],
            resourceKinds: ['folder'],
            resourceLabels: { folder: 'Folder' },
            eventTypes: ['message.received'],
            collectionModes: ['poll'],
            mcpReadTools: { mail: [{ server: 'mail', tool: 'read' }] },
          },
        ],
      },
    },
  }
  assert.ok(parseConnections(manifest))
  manifest.wework.connections.providers[0].mcpReadTools = {
    other: [{ server: 'mail', tool: 'read' }],
  }
  assert.throws(() => parseConnections(manifest), /declared dependency/)
  manifest.wework.connections.providers[0].mcpReadTools = { mail: [{ server: 'mail' }] }
  assert.throws(() => parseConnections(manifest), /tool identity/)
})

test('CLI uses the same captured dependency guard and cannot send executable paths or declarations', async () => {
  const f = fixture()
  const cli = connectionTools(
    f.identity,
    f.deps,
    async (method, params) => {
      f.calls.push({ method, params })
      return { success: true, result: [] }
    },
    satisfies
  ).cli
  await cli.callTool('mail', {
    tool: 'read',
    arguments: { query: 'hello' },
    command: ['sh'],
    dependencyAlias: 'injected',
    cliReadTools: { connectorSlug: 'evil' },
  })
  assert.deepEqual(f.calls, [
    {
      method: 'runtime.connections.cli',
      params: {
        providerId: '@test/mail/inbox',
        dependencyAlias: 'mail',
        source: { marketplaceId: 'company', pluginId: 'mail@company' },
        expectedVersion: '1.2.0',
        operation: 'callTool',
        tool: 'read',
        arguments: { query: 'hello' },
      },
    },
  ])
  f.installed[0].enabled = false
  await assert.rejects(cli.callTool('mail', { tool: 'read' }), { code: 'dependency_disabled' })
  await assert.rejects(cli.callTool('other', { tool: 'read' }), {
    code: 'connection_dependency_denied',
  })
  assert.equal(f.calls.length, 1)
})

test('DingTalk declares only its five read operations against its exact dependency', async () => {
  const { readFile } = await import('node:fs/promises')
  const manifest = JSON.parse(
    await readFile(new URL('../connection-dingtalk/package.json', import.meta.url), 'utf8')
  )
  const parsed = parseConnections(manifest)
  const declaration = parsed.providers[0].cliReadTools.dingtalk
  assert.deepEqual(Object.keys(declaration.operations).sort(), [
    'listMentions',
    'listProfiles',
    'searchGroups',
    'searchMessages',
    'searchUsers',
  ])
  assert.deepEqual(declaration.operations.listProfiles.command, ['profile', 'list'])
  assert.equal(declaration.operations.listMentions.parameters.group, '--group')
  assert.deepEqual(declaration.outputArgs, ['--format', 'json'])
  assert.equal(declaration.connectorSlug, 'dingtalk')
  for (const mutate of [
    p => {
      p.cliReadTools.other = p.cliReadTools.dingtalk
      delete p.cliReadTools.dingtalk
    },
    p => {
      p.cliReadTools.dingtalk.operations.listProfiles.command = ['']
    },
    p => {
      p.cliReadTools.dingtalk.operations.listProfiles.parameters = { query: '--bad flag' }
    },
    p => {
      p.cliReadTools.dingtalk.outputArgs = ['\0']
    },
  ]) {
    const invalid = structuredClone(manifest)
    mutate(invalid.wework.connections.providers[0])
    assert.throws(() => parseConnections(invalid))
  }
})

test('multiple aliases of the same installed plugin keep their distinct invocation identities', async () => {
  const f = fixture()
  f.identity.dependencies.push({ ...structuredClone(f.identity.dependencies[0]), alias: 'archive' })
  const calls = []
  const tools = connectionTools(
    f.identity,
    f.deps,
    async (method, params) => {
      calls.push({ method, params })
      return { content: [] }
    },
    satisfies
  )
  await tools.cli.callTool('mail', { tool: 'list' })
  await tools.cli.callTool('archive', { tool: 'search' })
  await tools.mcp.callTool('archive', { server: 'mail', tool: 'read' })
  assert.deepEqual(
    calls.map(item => item.params.dependencyAlias),
    ['mail', 'archive', 'archive']
  )
  assert.ok(calls.every(item => item.params.source.pluginId === 'mail@company'))
})
