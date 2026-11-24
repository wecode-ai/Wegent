import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { satisfies } from 'semver'
import { createConnectionRuntime } from './connection-runtime.js'
import { initializeObservation } from './connection-observations.js'

test('runs providers with injected read capabilities without an Executor or model process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'connection-runtime-'))
  const calls = []
  let enabled = true
  let registered = 0
  let waitForAbort = false
  let beginBlocked
  const blockedStarted = new Promise(resolve => {
    beginBlocked = resolve
  })
  const runtime = createConnectionRuntime({
    dependencies: {
      inventory: async () => [
        {
          marketplaceId: 'company',
          pluginId: 'mail@company',
          installed: true,
          enabled,
          version: '1.2.0',
        },
      ],
    },
    satisfies,
    beforeRequest: async () => {
      registered++
    },
    request: async (method, params, { signal }) => {
      if (waitForAbort) {
        beginBlocked()
        await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      assert.equal(method, 'runtime.connections.mcp')
      calls.push(params)
      return { tools: [] }
    },
  })
  try {
    const manifest = join(root, 'package.json')
    await writeFile(
      manifest,
      JSON.stringify({
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
                displayName: 'Mail',
                uses: ['mail'],
                collectionModes: ['poll'],
                resourceKinds: ['folder', 'thread'],
                resourceLabels: { folder: 'Folder', thread: 'Thread' },
                read: {
                  pagination: 'cursor',
                  inputSchema: { type: 'object' },
                  itemSchema: { type: 'object' },
                },
                reviewHistory: { resourceKinds: ['thread'] },
                eventTypes: ['mail.received'],
                versionedEventTypes: [],
              },
            ],
          },
        },
      })
    )
    await runtime.registry.register({ effect() {} }, pathToFileURL(manifest), {
      inbox: {
        check: async () => ({ status: 'ready' }),
        listResources: async () => ({ items: [] }),
        validate: async (_ctx, source) => source,
        readSource: async () => ({ items: [], hasMore: false, reviewCoverage: 'complete' }),
        initialize: async ctx => {
          assert.equal(ctx.initializationMode, 'fresh')
          return {}
        },
        collect: async ctx => {
          await ctx.mcp.listTools('mail')
          return { events: [], nextCheckpoint: { cursor: 1 }, hasMore: false }
        },
      },
    })
    const source = {
      providerId: '@test/mail/inbox',
      profile: 'account',
      kind: 'folder',
      id: 'inbox',
      name: 'Inbox',
    }
    const initialized = await initializeObservation(runtime.registry, source.providerId, {
      ...source,
      enabledAfter: '2026-11-15T00:00:00Z',
      boundary: { partition: 'stale', sequence: 1 },
    })
    assert.equal(
      initialized.source.boundary,
      undefined,
      'Opaque cursor fields cannot restore a previous activation'
    )
    assert.deepEqual(
      await runtime.registry.call(source.providerId, 'collect', { source, checkpoint: {} }),
      { events: [], nextCheckpoint: { cursor: 1 }, hasMore: false }
    )
    assert.equal(registered, 1)
    assert.deepEqual(calls, [
      {
        providerId: source.providerId,
        dependencyAlias: 'mail',
        source: { marketplaceId: 'company', pluginId: 'mail@company' },
        expectedVersion: '1.2.0',
        operation: 'listTools',
      },
    ])
    const registration = runtime.registration()
    assert.deepEqual(registration.reviewHistoryProviders, [
      { providerId: source.providerId, resourceKinds: ['thread'] },
    ])
    assert.deepEqual(registration.observationOnlyProviders, [
      { providerId: source.providerId, resourceKinds: ['folder'] },
    ])
    assert.deepEqual(registration.dependencyReferences, [
      {
        providerId: source.providerId,
        alias: 'mail',
        marketplaceId: 'company',
        pluginId: 'mail@company',
        version: '^1.0.0',
        readTools: [],
        cliReadTools: null,
      },
    ])
    waitForAbort = true
    const controller = new AbortController()
    const lost = new Error('Collection lease lost')
    const pending = runtime.registry.call(
      source.providerId,
      'collect',
      { source, checkpoint: {} },
      { signal: controller.signal }
    )
    const rejected = assert.rejects(pending, error => error === lost)
    await blockedStarted
    controller.abort(lost)
    await rejected
    assert.equal(calls.length, 1, 'A revoked collection never invokes another capability read')
    waitForAbort = false
    enabled = false
    await assert.rejects(
      runtime.registry.call(source.providerId, 'collect', { source, checkpoint: {} }),
      error => error.code.startsWith('dependency_')
    )
    assert.equal(calls.length, 1, 'Revoked dependency never reaches the read capability adapter')
  } finally {
    runtime.registry.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
