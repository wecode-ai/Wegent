import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { ConnectionRegistry } from './connections.js'
import {
  createWebConnectionPackage,
  registerWebConnection,
  trialWebConnection,
} from './web-connection-package.js'

const since = '2026-11-25T08:00:00.000Z'
const until = '2026-11-25T10:00:00.000Z'
const readSchema = {
  type: 'object',
  properties: {
    since: { type: 'string', format: 'date-time' },
    until: { type: 'string', format: 'date-time' },
  },
  required: ['since', 'until'],
  additionalProperties: false,
}
const operations = {
  session: {
    method: 'GET',
    path: '/project/42/status',
    inputSchema: { type: 'object', additionalProperties: false },
  },
  runs: {
    method: 'POST',
    path: '/project/42/runs',
    inputSchema: {
      ...readSchema,
      properties: { ...readSchema.properties, cursor: { type: 'string' } },
    },
    json: { since: { $parameter: 'since' }, until: { $parameter: 'until' } },
    query: { cursor: { $parameter: 'cursor', omitIfMissing: true } },
  },
}
const rows = {
  operation: 'runs',
  rows: ['results'],
  fields: { id: [0], at: [1], durationMs: [2] },
  cursor: ['next'],
}
const definition = {
  origin: 'https://analytics.example.test',
  pathPrefix: '/project/42',
  resource: { id: '42', name: 'Agent runs', kind: 'project', profile: 'device-account' },
  check: { operation: 'session', accountPath: ['account'], accountId: 'device-account' },
  operations,
  read: {
    ...rows,
    inputSchema: readSchema,
    itemSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        at: { type: 'string', format: 'date-time' },
        durationMs: { type: 'integer' },
      },
      required: ['id', 'at', 'durationMs'],
      additionalProperties: false,
    },
  },
  poll: { ...rows, minimum: { field: 'durationMs', value: 1800000 } },
}

test('a trial and a registered web package use the same queries, mapping and poll checkpoint', async () => {
  const generated = createWebConnectionPackage({
    name: 'wework-web-agent-runs',
    version: '0.1.0',
    definition,
  })
  assert.deepEqual(Object.keys(generated.files).sort(), [
    'connection.json',
    'cordis.patch.yml',
    'index.js',
    'package.json',
  ])
  const first = {
    results: [
      [71, '2026-11-25T08:30:00.000Z', 9000],
      [72, '2026-11-25T09:00:00.000Z', 2400000],
    ],
    next: 'page-2',
  }
  const second = { results: [[73, '2026-11-25T09:10:00.000Z', 2000000]] }
  let result = first
  let account = 'device-account'
  const request = async operation => {
    if (operation.path === '/project/42/status') return { account }
    assert.equal(operation.path, '/project/42/runs')
    assert.deepEqual(operation.json, { since, until })
    return operation.query.cursor === 'page-2' && result === first ? second : result
  }
  const trial = await trialWebConnection({
    definition,
    read: { since, until },
    observation: { since, until },
    request,
  })
  assert.deepEqual(
    trial.page.items.map(item => item.id),
    ['71', '72']
  )
  assert.deepEqual(
    trial.collection.events.map(event => event.objectId),
    ['72']
  )
  assert.deepEqual(trial.collection.nextCheckpoint, { since, until, cursor: 'page-2' })
  assert.deepEqual(
    trial.continuation.items.map(item => item.id),
    ['73']
  )
  assert.deepEqual(trial.collectionContinuation.nextCheckpoint, { since: until })

  const directory = await mkdtemp(join(tmpdir(), 'wework-web-test-'))
  const registry = new ConnectionRegistry({
    inventory: async () => [],
    satisfies: () => true,
    context: identity => identity,
  })
  try {
    await Promise.all(
      Object.entries(generated.files).map(([name, content]) =>
        writeFile(join(directory, name), content)
      )
    )
    const manifestUrl = pathToFileURL(await realpath(join(directory, 'package.json')))
    const entry = await import(pathToFileURL(join(directory, 'index.js')))
    const owner = {
      effect: () => {},
      weworkConnections: {
        registerWeb(ctx, url, content) {
          assert.equal(url.href, manifestUrl.href)
          return registerWebConnection(registry, ctx, url, content, async binding => {
            assert.equal(binding.providerId, generated.providerId)
            assert.equal(binding.definitionDigest, generated.definitionDigest)
            return request(binding.operation)
          })
        },
      },
    }
    await entry.apply(owner)
    const { providerId } = generated
    const resources = await registry.call(providerId, 'listResources', {
      kind: 'project',
      query: '',
    })
    const [source] = resources.items
    assert.deepEqual(await registry.call(providerId, 'validate', source), source)
    const read = await registry.call(providerId, 'readSource', { source, query: { since, until } })
    assert.deepEqual(read, trial.page)
    const collected = await registry.call(providerId, 'collect', {
      source,
      checkpoint: { since, until },
    })
    assert.deepEqual(collected, trial.collection)
    const next = await registry.call(providerId, 'readSource', { source, cursor: read.nextCursor })
    assert.deepEqual(
      next.items.map(item => item.id),
      ['73']
    )
    const complete = await registry.call(providerId, 'collect', {
      source,
      checkpoint: collected.nextCheckpoint,
    })
    assert.equal(complete.events[0].objectId, '73')
    assert.deepEqual(complete.nextCheckpoint, { since: until })
    await assert.rejects(
      registry.call(providerId, 'readSource', {
        source: { ...source, id: '43' },
        query: { since, until },
      }),
      { code: 'invalid_web_connection' }
    )
    result = { records: second.results }
    await assert.rejects(
      registry.call(providerId, 'collect', { source, checkpoint: collected.nextCheckpoint }),
      { code: 'connection_response_invalid' }
    )
    account = 'other-account'
    await assert.rejects(
      registry.call(providerId, 'readSource', { source, query: { since, until } }),
      { code: 'connector_auth_required' }
    )
  } finally {
    registry.dispose()
    await rm(directory, { force: true, recursive: true })
  }
})
