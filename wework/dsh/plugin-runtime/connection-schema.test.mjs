import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ConnectionRegistry, parseConnections } from './connections.js'

const querySchema = {
  type: 'object',
  properties: {
    revision: { type: 'string', enum: ['release'] },
    count: { type: 'integer', minimum: 1, maximum: 100 },
  },
  required: ['revision'],
  additionalProperties: false,
}
const itemSchema = {
  type: 'object',
  properties: { id: { type: 'string' }, value: { type: 'number' } },
  required: ['id', 'value'],
  additionalProperties: false,
}
const descriptor = () => ({
  id: 'metrics',
  displayName: 'Metrics',
  uses: [],
  collectionModes: ['poll'],
  resourceKinds: ['dashboard'],
  resourceLabels: { dashboard: 'Dashboard' },
  eventTypes: ['metric.changed'],
  versionedEventTypes: ['metric.changed'],
  read: { inputSchema: querySchema, itemSchema, pagination: 'cursor' },
  actions: [
    {
      id: 'reset',
      resourceKinds: ['dashboard'],
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'number', minimum: 0 } },
        required: ['value'],
        additionalProperties: false,
      },
      resultSchema: {
        type: 'object',
        properties: { accepted: { const: true } },
        required: ['accepted'],
        additionalProperties: false,
      },
    },
  ],
})
const manifest = () => ({
  name: '@independent/metrics',
  wework: { connections: { apiVersion: 1, dependencies: {}, providers: [descriptor()] } },
})
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'connection-schema-'))
  const path = join(root, 'package.json')
  await writeFile(path, JSON.stringify(manifest()))
  const source = {
    providerId: '@independent/metrics/metrics',
    id: 'one',
    kind: 'dashboard',
    profile: 'account',
    name: 'Dashboard',
  }
  const state = {
    reads: [],
    validations: 0,
    writes: 0,
    result: {
      items: Array.from({ length: 32 }, (_, index) => ({ id: String(index), value: index })),
      hasMore: false,
    },
    actionResult: { accepted: true },
  }
  const registry = new ConnectionRegistry({
    inventory: async () => [],
    satisfies: () => true,
    context: value => value,
  })
  await registry.register({ effect() {} }, pathToFileURL(path), {
    metrics: {
      check: async () => ({ status: 'ready' }),
      listResources: async () => ({ items: [source], hasMore: false }),
      validate: async (_ctx, input) => {
        assert.equal(input.id, source.id)
        state.validations++
      },
      initialize: async () => assert.fail('read does not initialize'),
      collect: async () => assert.fail('read does not collect'),
      readSource: async (_ctx, input) => {
        state.reads.push(input)
        return state.result
      },
      executeAction: async () => {
        state.writes++
        return state.actionResult
      },
    },
  })
  t.after(async () => {
    registry.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return { registry, source, state }
}

test('third-party non-message reads use declared query and items without changing core', async t => {
  const { registry, source, state } = await fixture(t)
  assert.deepEqual((await registry.catalog())[0].read.inputSchema, querySchema)
  const result = await registry.call(source.providerId, 'readSource', {
    source,
    query: { revision: 'release', count: 32 },
  })
  assert.equal(result.items.length, 32)
  assert.equal(result.items[0].at, undefined)
  assert.equal(result.items[0].text, undefined)
  assert.deepEqual(state.reads[0].query, { revision: 'release', count: 32 })
  for (const query of [
    null,
    [],
    { revision: 'wrong' },
    { revision: 'release', count: 101 },
    { revision: 'release', count: '2' },
    { revision: 'release', secret: 'x' },
    {},
  ])
    await assert.rejects(registry.call(source.providerId, 'readSource', { source, query }), {
      code: 'invalid_connection',
    })
  assert.equal(state.reads.length, 1)
})

test('schema rejects invalid items, unbounded payloads and missing or stalled continuation', async t => {
  const { registry, source, state } = await fixture(t)
  const query = { revision: 'release' }
  for (const result of [
    { items: [{ id: 'a', value: 'wrong' }], hasMore: false },
    { items: [{ value: 1 }], hasMore: false },
    { items: Array.from({ length: 1001 }, () => ({ id: 'a', value: 1 })), hasMore: false },
    { items: [], hasMore: true },
    { items: [], hasMore: true, nextCursor: 'same' },
    { items: [], hasMore: false, nextCursor: 'extra' },
    { items: [], hasMore: false, metadata: 'x'.repeat(8 * 1024 * 1024) },
  ]) {
    state.result = result
    await assert.rejects(
      registry.call(source.providerId, 'readSource', { source, query, cursor: 'same' }),
      { code: 'invalid_connection' }
    )
  }
  state.result = { items: [{ id: 'a', value: 1 }], hasMore: true, nextCursor: 'next' }
  await registry.call(source.providerId, 'readSource', { source, query })
  state.result = { items: [{ id: 'b', value: 2 }], hasMore: false }
  await registry.call(source.providerId, 'readSource', { source, cursor: 'next' })
  assert.equal(state.validations, state.reads.length)
  assert.equal(state.reads.at(-1).query, undefined)
  await assert.rejects(
    registry.call(source.providerId, 'readSource', {
      source,
      query: { revision: 'release', huge: 'x'.repeat(1024 * 1024) },
    }),
    { code: 'invalid_connection' }
  )
})

test('declared action schemas validate input before execution and the actual result', async t => {
  const { registry, source, state } = await fixture(t)
  for (const input of [{ value: -1 }, { value: '1' }, { value: 1, extra: true }, {}])
    await assert.rejects(
      registry.call(source.providerId, 'executeAction', { source, action: 'reset', ...input }),
      { code: 'invalid_connection' }
    )
  assert.equal(state.writes, 0)
  assert.deepEqual(
    await registry.call(source.providerId, 'executeAction', { source, action: 'reset', value: 1 }),
    { accepted: true }
  )
  state.actionResult = { accepted: false }
  await assert.rejects(
    registry.call(source.providerId, 'executeAction', { source, action: 'reset', value: 1 }),
    { code: 'invalid_connection' }
  )
  assert.equal(state.writes, 2)
})

test('invalid JSON Schemas and the removed parallel readPagination declaration are rejected', () => {
  for (const mutate of [
    p => {
      p.read.inputSchema = { type: 'object', properties: { x: { type: 'invented' } } }
    },
    p => {
      p.read.itemSchema = {
        type: 'object',
        properties: { x: { $ref: 'https://untrusted.invalid/schema' } },
      }
    },
    p => {
      p.readPagination = 'cursor'
    },
    p => {
      p.actions[0].resultSchema = undefined
    },
    p => {
      p.read.pagination = 'offset'
    },
  ]) {
    const value = manifest()
    mutate(value.wework.connections.providers[0])
    assert.throws(() => parseConnections(value), { code: 'invalid_connection' })
  }
})
