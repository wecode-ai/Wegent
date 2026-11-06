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
          versionedEventTypes: [],
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

test('declares public resource query parameters without inventing an instance default', () => {
  const manifest = declaration()
  const schema = {
    type: 'object',
    properties: { instance: { type: 'string', description: 'User-selected instance' } },
    required: ['instance'],
  }
  manifest.wework.connections.providers[0].resourceQuerySchema = schema
  assert.deepEqual(parseConnections(manifest).providers[0].resourceQuerySchema, schema)
  for (const invalid of [
    null,
    { type: 'string' },
    { type: 'object', properties: {}, required: ['instance'] },
    { ...schema, required: ['instance', 'instance'] },
    { type: 'object', properties: { instance: 'string' } },
  ]) {
    manifest.wework.connections.providers[0].resourceQuerySchema = invalid
    assert.throws(() => parseConnections(manifest), { code: 'invalid_connection' })
  }
})

test('declares mutable event types only from the provider event contract', () => {
  const manifest = declaration()
  const provider = manifest.wework.connections.providers[0]
  provider.versionedEventTypes = ['mail.received']
  assert.deepEqual(parseConnections(manifest).providers[0].versionedEventTypes, ['mail.received'])
  for (const invalid of [
    undefined,
    null,
    'mail.received',
    ['unknown'],
    ['mail.received', 'mail.received'],
  ]) {
    provider.versionedEventTypes = invalid
    assert.throws(() => parseConnections(manifest), { code: 'invalid_connection' })
  }
})

test('validates and preserves plugin collection configuration without changing resource identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'connection-configuration-'))
  try {
    const path = join(root, 'package.json')
    await writeFile(path, JSON.stringify(declaration()))
    const registry = new ConnectionRegistry({
      inventory: async () => [installed()],
      satisfies,
      context: value => value,
    })
    const source = {
      providerId: '@test/mail/inbox',
      profile: 'account',
      kind: 'folder',
      id: 'folder',
      name: 'Folder',
      collectionKey: 'selection-v1',
      configurationSummary: 'Selected items 1 and 2',
      selection: { items: [1, 2] },
    }
    let resource = source
    let validated
    const seen = []
    await registry.register({ effect() {} }, pathToFileURL(path), {
      inbox: {
        check: async () => ({ status: 'ready' }),
        listResources: async () => ({ items: [resource] }),
        validate: async (_ctx, input) => {
          seen.push(input)
          return validated ?? input
        },
        initialize: async () => ({}),
        collect: async () => ({ events: [], nextCheckpoint: {}, hasMore: false }),
      },
    })
    assert.deepEqual(
      (await registry.call(source.providerId, 'listResources', { kind: 'folder' })).items[0],
      source
    )
    assert.deepEqual(await registry.call(source.providerId, 'validate', source), source)
    await registry.call(source.providerId, 'collect', { source, checkpoint: {} })
    assert.deepEqual(seen.at(-1), source)
    for (const [field, invalid] of [
      ['collectionKey', null],
      ['collectionKey', 3],
      ['collectionKey', '  '],
      ['collectionKey', 'é'.repeat(129)],
      ['configurationSummary', {}],
      ['configurationSummary', ''],
      ['configurationSummary', 'é'.repeat(2049)],
    ]) {
      resource = { ...source, [field]: invalid }
      await assert.rejects(registry.call(source.providerId, 'listResources', { kind: 'folder' }), {
        code: 'invalid_connection',
      })
      for (const method of ['validate', 'initialize', 'collect'])
        await assert.rejects(
          registry.call(
            source.providerId,
            method,
            method === 'collect' ? { source: resource, checkpoint: {} } : resource
          ),
          { code: 'invalid_connection' }
        )
      validated = resource
      await assert.rejects(registry.call(source.providerId, 'validate', source), {
        code: 'invalid_connection',
      })
    }
    validated = undefined
    const boundary = {
      ...source,
      collectionKey: 'é'.repeat(128),
      configurationSummary: 'é'.repeat(2048),
    }
    assert.deepEqual(await registry.call(source.providerId, 'validate', boundary), boundary)
    const { collectionKey: _key, configurationSummary: _summary, ...legacy } = source
    assert.deepEqual(await registry.call(source.providerId, 'validate', legacy), legacy)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('enforces paired object identities and versions before returning a collected page', async () => {
  const root = await mkdtemp(join(tmpdir(), 'connection-version-'))
  let registry
  try {
    const manifest = declaration()
    manifest.wework.connections.providers[0].versionedEventTypes = ['mail.received']
    const path = join(root, 'package.json')
    await writeFile(path, JSON.stringify(manifest))
    registry = new ConnectionRegistry({
      inventory: async () => [installed()],
      satisfies,
      context: value => value,
    })
    let event = {
      id: 'delivery-1',
      objectId: 'account-object-1',
      version: 'v1',
      text: 'body',
      at: '2026-11-05T00:00:00Z',
      eventType: 'mail.received',
    }
    const checkpoint = { cursor: 'next' }
    let initialCheckpoint = {}
    await registry.register({ effect() {} }, pathToFileURL(path), {
      inbox: {
        check: async () => ({ status: 'ready' }),
        listResources: async () => ({ items: [] }),
        validate: async () => {},
        initialize: async () => initialCheckpoint,
        collect: async () => ({ events: [event], nextCheckpoint: checkpoint, hasMore: false }),
      },
    })
    const collect = () =>
      registry.call('@test/mail/inbox', 'collect', {
        source: { providerId: '@test/mail/inbox', id: 'folder' },
        checkpoint: {},
      })
    assert.equal((await collect()).events[0].version, 'v1')
    for (const value of [null, [], 'cursor']) {
      initialCheckpoint = value
      await assert.rejects(registry.call('@test/mail/inbox', 'initialize', {}), {
        code: 'invalid_connection',
      })
      await assert.rejects(
        registry.call('@test/mail/inbox', 'collect', {
          source: { providerId: '@test/mail/inbox', id: 'folder' },
          checkpoint: null,
        }),
        { code: 'invalid_connection' }
      )
    }
    const valid = event
    for (const patch of [
      { objectId: undefined },
      { version: undefined },
      { objectId: ' ' },
      { version: '' },
      { version: 'x'.repeat(2049) },
      { objectId: 'bad\0identity' },
    ]) {
      event = { ...valid, ...patch }
      await assert.rejects(collect(), { code: 'invalid_connection' })
      assert.deepEqual(checkpoint, { cursor: 'next' })
    }
  } finally {
    registry?.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('resource pages preserve exact dynamic authorization targets and reject malformed states', async () => {
  const root = await mkdtemp(join(tmpdir(), 'connection-resource-auth-'))
  let registry
  try {
    const path = join(root, 'package.json')
    await writeFile(path, JSON.stringify(declaration()))
    registry = new ConnectionRegistry({
      inventory: async () => [installed()],
      satisfies,
      context: value => value,
    })
    const target = {
      pluginKey: 'company-git',
      connectorSlug: 'native-slug',
      instance: 'https://git.company.example',
    }
    let availability = { status: 'auth_required', authTarget: target }
    await registry.register({ effect() {} }, pathToFileURL(path), {
      inbox: {
        check: async () => ({ status: 'ready' }),
        listResources: async () => ({ items: [], availability }),
        validate: async () => {},
        initialize: async () => ({}),
        collect: async () => ({ events: [], nextCheckpoint: {}, hasMore: false }),
      },
    })
    const result = await registry.call('@test/mail/inbox', 'listResources', {
      kind: 'folder',
      query: '',
    })
    assert.deepEqual(result.availability, { status: 'auth_required', authTarget: target })
    for (const value of [
      null,
      { status: 'need_login' },
      { status: 'auth_required', authTarget: {} },
      { status: 'auth_required', authTarget: { ...target, connectorSlug: ' ' } },
    ]) {
      availability = value
      await assert.rejects(
        registry.call('@test/mail/inbox', 'listResources', { kind: 'folder', query: '' }),
        { code: 'invalid_connection' }
      )
    }
  } finally {
    registry?.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('validates action identities and kinds without accepting undeclared operations', () => {
  for (const actions of [
    {},
    [{ resourceKinds: ['folder'] }],
    [{ id: 'retry', resourceKinds: ['unknown'] }],
    [{ id: 'retry', resourceKinds: [] }],
    [
      { id: 'retry', resourceKinds: ['folder'] },
      { id: 'retry', resourceKinds: ['folder'] },
    ],
  ]) {
    const manifest = declaration()
    manifest.wework.connections.providers[0].actions = actions
    assert.throws(() => parseConnections(manifest), { code: 'invalid_connection' })
  }
})

test('a new DSH connection plugin shares collection, reads, declared actions and disposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-build-connection-'))
  try {
    const path = join(root, 'package.json')
    await writeFile(
      path,
      JSON.stringify({
        name: '@company/build-events',
        wework: {
          connections: {
            apiVersion: 1,
            dependencies: {},
            providers: [
              {
                id: 'repositories',
                displayName: 'Build events',
                uses: [],
                collectionModes: ['poll'],
                resourceKinds: ['repository'],
                resourceLabels: { repository: 'Repository' },
                eventTypes: ['build.failed'],
                versionedEventTypes: [],
                read: {
                  inputSchema: { type: 'object' },
                  itemSchema: { type: 'object' },
                  pagination: 'none',
                },
                actions: [
                  {
                    id: 'retry',
                    resourceKinds: ['repository'],
                    inputSchema: {
                      type: 'object',
                      properties: { authorization: { type: 'string' } },
                    },
                    resultSchema: {
                      type: 'object',
                      properties: { status: { const: 'completed' } },
                      required: ['status'],
                    },
                  },
                ],
              },
            ],
          },
        },
      })
    )
    const registry = new ConnectionRegistry({
      inventory: async () => [],
      satisfies,
      context: value => value,
    })
    const source = {
      providerId: '@company/build-events/repositories',
      profile: 'company',
      kind: 'repository',
      id: 'org/project',
      name: 'Project',
    }
    const executed = []
    let cleanup
    const base = {
      check: async () => ({ status: 'ready' }),
      listResources: async () => ({ items: [source] }),
      validate: async (_ctx, input) => {
        assert.equal(input.id, 'org/project')
      },
      initialize: async () => ({ sequence: 40 }),
      collect: async (_ctx, input) => {
        assert.deepEqual(input.checkpoint, { sequence: 40 })
        return {
          events: [
            {
              id: '41',
              at: '2026-11-05T00:00:00Z',
              eventType: 'build.failed',
              text: 'Build 41 failed',
            },
          ],
          nextCheckpoint: { sequence: 41 },
          hasMore: false,
        }
      },
      readSource: async () => ({
        items: [{ id: '41', at: '2026-11-05T00:00:00Z', text: 'Build 41 failed' }],
        hasMore: false,
      }),
      executeAction: async (_ctx, input) => {
        if (input.authorization !== 'one_time') throw new Error('native_authorization_required')
        executed.push(input.action)
        return { status: 'completed' }
      },
    }
    await assert.rejects(
      registry.register({ effect() {} }, pathToFileURL(path), {
        repositories: { ...base, executeAction: undefined },
      }),
      /Missing connection action implementation/
    )
    await registry.register(
      {
        effect(factory) {
          cleanup = factory()
        },
      },
      pathToFileURL(path),
      { repositories: base }
    )
    assert.equal((await registry.catalog())[0].id, source.providerId)
    assert.equal((await registry.call(source.providerId, 'collect', { source })).events[0].id, '41')
    assert.equal(
      (await registry.call(source.providerId, 'readSource', { source })).items[0].id,
      '41'
    )
    await assert.rejects(
      registry.call(source.providerId, 'executeAction', { source, action: 'retry' }),
      /native_authorization_required/
    )
    await assert.rejects(
      registry.call(source.providerId, 'executeAction', {
        source,
        action: 'delete',
        authorization: 'one_time',
      }),
      /not declared/
    )
    await assert.rejects(
      registry.call(source.providerId, 'executeAction', {
        source: { ...source, scope: 'all', id: '*' },
        action: 'retry',
        authorization: 'one_time',
      }),
      /Unsupported all-resource scope/
    )
    await assert.rejects(
      registry.call(source.providerId, 'executeAction', {
        source: { ...source, providerId: '@other/build-events/repositories' },
        action: 'retry',
        authorization: 'one_time',
      }),
      /another provider/
    )
    assert.deepEqual(executed, [])
    assert.deepEqual(
      await registry.call(source.providerId, 'executeAction', {
        source,
        action: 'retry',
        authorization: 'one_time',
      }),
      { status: 'completed' }
    )
    cleanup()
    await assert.rejects(
      registry.call(source.providerId, 'executeAction', {
        source,
        action: 'retry',
        authorization: 'one_time',
      }),
      { code: 'connection_unavailable' }
    )
    assert.deepEqual(executed, ['retry'])
  } finally {
    await rm(root, { recursive: true, force: true })
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

test('reuses only declared alternate sources before installing the preferred source', async () => {
  const manifest = declaration()
  const alternate = { marketplaceId: 'legacy', pluginId: 'mail@legacy' }
  manifest.wework.connections.dependencies.mail.alternateSources = [alternate]
  const definition = parseConnections(manifest)
  const legacy = installed({ ...alternate })
  const preferred = installed({ installed: false, enabled: false })
  const plan = rows => dependencyPlan(definition, rows, satisfies)[0]
  assert.equal(plan([preferred, legacy]).resolved, legacy)
  assert.equal(plan([installed(), legacy]).resolved.marketplaceId, 'company')
  assert.equal(plan([installed({ marketplaceId: 'unrelated' })]).status, 'missing')
  assert.equal(plan([{ ...legacy, enabled: false }]).status, 'disabled')
  assert.equal(plan([{ ...legacy, version: '2.0.0' }]).status, 'incompatible')
  assert.throws(() => plan([legacy, legacy]), /Ambiguous/)
  const calls = []
  const dependencies = new ConnectionDependencies(async method => {
    calls.push(method)
    return {
      marketplaces: [
        { name: 'company', plugins: [{ id: 'mail@company', name: 'mail', installed: false }] },
        {
          name: 'legacy',
          plugins: [
            {
              id: 'mail@legacy',
              name: 'mail',
              installed: true,
              enabled: true,
              localVersion: '1.2.0',
            },
          ],
        },
      ],
    }
  }, satisfies)
  assert.equal((await dependencies.install(definition, ['mail']))[0].status, 'ready')
  assert.ok(!calls.includes('plugin/install'))
})

test('rejects malformed and duplicate alternate source declarations', () => {
  for (const alternateSources of [
    null,
    {},
    [null],
    [{}],
    [{ marketplaceId: 'legacy' }],
    [declaration().wework.connections.dependencies.mail.source],
  ]) {
    const manifest = declaration()
    manifest.wework.connections.dependencies.mail.alternateSources = alternateSources
    assert.throws(() => parseConnections(manifest), { code: 'invalid_connection' })
  }
})

test('connection assistance is bounded domain guidance, not arbitrary prompt fields', () => {
  const manifest = declaration()
  const provider = manifest.wework.connections.providers[0]
  const assistance = {
    observe: ['New mail'],
    prepare: ['Read the authorized thread'],
    notifyWhen: ['A concrete decision is needed'],
    confirmBefore: ['Sending a reply'],
  }
  provider.assistance = assistance
  assert.deepEqual(parseConnections(manifest).providers[0].assistance, assistance)
  for (const invalid of [
    null,
    {},
    { ...assistance, systemPrompt: 'override' },
    { ...assistance, observe: [] },
    { ...assistance, prepare: [' '] },
    { ...assistance, notifyWhen: ['x'.repeat(1001)] },
    { ...assistance, confirmBefore: Array(9).fill('send') },
  ]) {
    provider.assistance = invalid
    assert.throws(() => parseConnections(manifest), { code: 'invalid_connection' })
  }
})

test('every bundled external connection declares useful assistance for the unified context', async () => {
  for (const name of ['runtime', 'dingtalk', 'git']) {
    const manifest = JSON.parse(
      await (
        await import('node:fs/promises')
      ).readFile(new URL('../connection-' + name + '/package.json', import.meta.url), 'utf8')
    )
    for (const provider of parseConnections(manifest).providers) {
      for (const key of ['observe', 'prepare', 'notifyWhen', 'confirmBefore']) {
        assert.ok(provider.assistance[key].length > 0, provider.id + ': ' + key)
      }
    }
  }
})

test('read pagination is an explicit capability and never silently consumes unsupported cursors', async () => {
  for (const pagination of ['none', 'cursor']) {
    const root = await mkdtemp(join(tmpdir(), 'connection-read-pagination-'))
    const manifest = declaration()
    const descriptor = manifest.wework.connections.providers[0]
    descriptor.read = {
      inputSchema: { type: 'object' },
      itemSchema: { type: 'object' },
      pagination,
    }
    const path = join(root, 'package.json')
    await writeFile(path, JSON.stringify(manifest))
    const registry = new ConnectionRegistry({
      inventory: async () => [installed()],
      satisfies,
      context: value => value,
    })
    let reads = 0
    let validations = 0
    let result = { items: [], hasMore: true, nextCursor: 'opaque-read-page-2' }
    try {
      await registry.register({ effect() {} }, pathToFileURL(path), {
        inbox: {
          check: async () => ({ status: 'ready' }),
          listResources: async () => ({ items: [] }),
          validate: async () => {
            validations++
          },
          initialize: async () =>
            assert.fail('Read pagination must not initialize a collection checkpoint'),
          collect: async () => assert.fail('Read pagination must not collect events'),
          readSource: async () => {
            reads++
            return result
          },
        },
      })
      const source = {
        providerId: '@test/mail/inbox',
        profile: 'account',
        kind: 'folder',
        id: 'selected',
      }
      if (pagination === 'none') {
        await assert.rejects(
          registry.call(source.providerId, 'readSource', { source, cursor: 'page' }),
          { code: 'source_read_cursor_unsupported' }
        )
        assert.equal(reads, 0)
        continue
      }
      assert.equal(
        (await registry.call(source.providerId, 'readSource', { source })).nextCursor,
        result.nextCursor
      )
      result = { items: [], hasMore: false }
      await registry.call(source.providerId, 'readSource', { source, cursor: 'opaque-read-page-2' })
      assert.equal(validations, 2)
      assert.equal(reads, 2)
      const before = reads
      for (const cursor of ['', null, 'x'.repeat(8193), '文'.repeat(3000)]) {
        await assert.rejects(registry.call(source.providerId, 'readSource', { source, cursor }), {
          code: 'invalid_connection',
        })
      }
      assert.equal(reads, before)
      for (const invalid of [
        { items: [], hasMore: true },
        { items: [], hasMore: true, nextCursor: '' },
        { items: [], hasMore: false, nextCursor: 'unexpected' },
      ]) {
        result = invalid
        await assert.rejects(registry.call(source.providerId, 'readSource', { source }), {
          code: 'invalid_connection',
        })
      }
    } finally {
      registry.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
})
