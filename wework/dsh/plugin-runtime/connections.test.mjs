import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { satisfies } from 'semver'
import { ConnectionRegistry, dependencyPlan, parseConnections } from './connections.js'
import { ConnectionDependencies } from './connection-dependencies.js'

const declaration = () => ({
  name: '@test/mail',
  wework: {
    connections: {
      apiVersion: 1,
      dependencies: {
        mail: {
          kind: 'codexPlugin',
          source: { marketplaceId: 'company', pluginId: 'mail@company' },
          version: '^1.0.0',
        },
      },
      providers: [
        {
          id: 'inbox',
          displayName: 'Email',
          uses: ['mail'],
          collectionModes: ['poll'],
          resourceKinds: ['folder'],
          resourceLabels: { folder: 'Mail folder' },
          eventTypes: ['mail.received'],
        },
      ],
    },
  },
})
const installed = (patch = {}) => ({
  marketplaceId: 'company',
  pluginId: 'mail@company',
  installed: true,
  enabled: true,
  version: '1.2.0',
  ...patch,
})

test('validates protocol versions, references, versions and duplicate provider identities', () => {
  assert.equal(parseConnections({ name: 'ordinary' }), null)
  for (const mutate of [
    value => (value.apiVersion = 2),
    value => (value.providers[0].uses = ['unknown']),
    value => (value.dependencies.mail.version = 'garbage'),
    value => value.providers.push(value.providers[0]),
  ]) {
    const manifest = declaration()
    mutate(manifest.wework.connections)
    assert.throws(
      () => parseConnections(manifest),
      error => error.code === 'invalid_connection'
    )
  }
})

test('resolves exact source identity and distinguishes disabled and incompatible dependencies', () => {
  const definition = parseConnections(declaration())
  assert.equal(
    dependencyPlan(definition, [installed({ marketplaceId: 'other' })], satisfies)[0].status,
    'missing'
  )
  assert.equal(
    dependencyPlan(definition, [installed({ enabled: false })], satisfies)[0].status,
    'disabled'
  )
  assert.equal(
    dependencyPlan(definition, [installed({ version: '2.0.0' })], satisfies)[0].status,
    'incompatible'
  )
  assert.equal(dependencyPlan(definition, [installed()], satisfies)[0].status, 'ready')
  assert.throws(
    () => dependencyPlan(definition, [installed(), installed()], satisfies),
    /Ambiguous/
  )
})

test('registers providers by package, enforces dependencies on every invocation and disposes with the owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-connections-'))
  try {
    const path = join(root, 'package.json')
    await writeFile(path, JSON.stringify(declaration()))
    let inventory = [installed()]
    let cleanup
    const calls = []
    const registry = new ConnectionRegistry({
      inventory: async () => inventory,
      satisfies,
      context: identity => identity,
    })
    const provider = {
      check: async () => ({ status: 'ready' }),
      listResources: async () => ({ items: [] }),
      validate: async (_ctx, input) => {
        calls.push('validate')
        return input
      },
      initialize: async () => {
        calls.push('initialize')
        return { cursor: 'baseline' }
      },
      collect: async (_ctx, input) => {
        calls.push('collect')
        assert.equal(input.checkpoint.cursor, 'baseline')
        return { events: [], nextCheckpoint: { cursor: 'next' }, hasMore: false }
      },
    }
    await registry.register(
      {
        effect(factory) {
          cleanup = factory()
        },
      },
      pathToFileURL(path),
      { inbox: provider }
    )
    assert.equal((await registry.catalog())[0].id, '@test/mail/inbox')
    await registry.call('@test/mail/inbox', 'collect', {
      source: { providerId: '@test/mail/inbox' },
      checkpoint: null,
    })
    assert.deepEqual(calls, ['validate', 'initialize', 'collect'])
    inventory = [installed({ enabled: false })]
    await assert.rejects(
      registry.call('@test/mail/inbox', 'collect', {}),
      error => error.code === 'dependency_disabled'
    )
    cleanup()
    await assert.rejects(
      registry.call('@test/mail/inbox', 'listResources', {}),
      error => error.code === 'connection_unavailable'
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('installs only explicitly requested missing dependencies and never upgrades shared versions', async () => {
  let present = false
  const calls = []
  const dependencies = new ConnectionDependencies(async (method, params) => {
    calls.push({ method, params })
    if (method === 'plugin/install') {
      present = true
      return {}
    }
    return {
      marketplaces: [
        {
          name: 'company',
          path: '/market/.agents/plugins/marketplace.json',
          plugins:
            present || method === 'plugin/list'
              ? [
                  {
                    id: 'mail@company',
                    name: 'mail',
                    installed: present,
                    enabled: present,
                    localVersion: '1.2.0',
                  },
                ]
              : [],
        },
      ],
    }
  }, satisfies)
  const definition = parseConnections(declaration())
  assert.equal((await dependencies.plan(definition))[0].status, 'missing')
  assert.equal(calls.filter(call => call.method === 'plugin/install').length, 0)
  assert.equal((await dependencies.install(definition, ['mail']))[0].status, 'ready')
  assert.deepEqual(calls.find(call => call.method === 'plugin/install').params, {
    pluginName: 'mail',
    marketplacePath: '/market/.agents/plugins/marketplace.json',
  })
  const incompatible = new ConnectionDependencies(
    async () => ({
      marketplaces: [
        {
          name: 'company',
          plugins: [
            {
              id: 'mail@company',
              name: 'mail',
              installed: true,
              enabled: true,
              localVersion: '2.0.0',
            },
          ],
        },
      ],
    }),
    satisfies
  )
  await assert.rejects(
    incompatible.install(definition, ['mail']),
    error => error.code === 'dependency_conflict'
  )
})

test('independent providers work without querying a Codex catalog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-independent-'))
  try {
    const manifest = declaration()
    manifest.wework.connections.dependencies = {}
    manifest.wework.connections.providers[0].uses = []
    const path = join(root, 'package.json')
    await writeFile(path, JSON.stringify(manifest))
    const registry = new ConnectionRegistry({
      inventory: () => {
        throw Error('unexpected Codex request')
      },
      satisfies,
      context: identity => identity,
    })
    const noop = async () => ({ status: 'ready' })
    await registry.register({ effect() {} }, pathToFileURL(path), {
      inbox: { check: noop, listResources: noop, validate: noop, initialize: noop, collect: noop },
    })
    assert.equal((await registry.catalog())[0].availability.status, 'ready')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
