import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { cp, mkdir, mkdtemp, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { ExecutorRuntimeClient } from '../executor-runtime/executor-runtime-client.js'

test('the DSH host collects through the registered provider and commits with one scoped source lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cloud-connection-host-'))
  // Core packages are installed by the managed DSH profile, not the pnpm workspace.
  const packages = join(root, 'node_modules', '@wegent')
  const directoryLink = process.platform === 'win32' ? 'junction' : 'dir'
  await mkdir(packages, { recursive: true })
  const packageRoot = join(packages, 'dsh-connection-host')
  await cp(fileURLToPath(new URL('.', import.meta.url)), packageRoot, { recursive: true })
  for (const name of ['plugin-runtime', 'executor-runtime'])
    await symlink(
      fileURLToPath(new URL(`../${name}`, import.meta.url)),
      join(packages, `dsh-${name}`),
      directoryLink
    )
  await symlink(
    dirname(createRequire(import.meta.url).resolve('semver/package.json')),
    join(root, 'node_modules', 'semver'),
    directoryLink
  )
  const { apply, BASE_PATH } = await import(pathToFileURL(join(packageRoot, 'index.js')))
  const calls = []
  const cleanups = []
  let host
  let service
  let handler
  let stops = 0
  const source = {
    providerId: '@test/documents/document',
    profile: 'account',
    kind: 'document',
    id: 'release',
    name: 'Release',
    enabledAfter: '2026-11-15T00:00:00Z',
  }
  const backend = createServer(async (req, res) => {
    assert.equal(req.url, '/api/runtime-observations/collector')
    assert.equal(req.headers.authorization, 'Bearer scoped-source-token')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    calls.push(body)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify(
        body.action === 'read_lease'
          ? {
              ownerId: 7,
              observation: {
                id: 'source',
                source,
                checkpoint: { cursor: 40 },
                lease: { id: 'lease', forceVersion: 0 },
                collectedForceVersion: 0,
              },
            }
          : { accepted: true, sequence: 1 }
      )
    )
  })
  const server = createServer((req, res) => handler(req, res))
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const original = ExecutorRuntimeClient.fromEnvironment
  const previousOwner = process.env.WEWORK_CONNECTION_OWNER_ID
  process.env.WEWORK_CONNECTION_OWNER_ID = '7'
  ExecutorRuntimeClient.fromEnvironment = () => ({
    start: async () => {},
    stop: async () => {
      stops++
    },
    request: async (method, params) => {
      assert.equal(
        method,
        'runtime.connections.host',
        'Collection must not invoke a model or task RPC'
      )
      host = params
      return { success: true }
    },
  })
  const ctx = {
    profileContext: { dir: root, name: 'isolated-connections' },
    effect: fn => {
      const dispose = fn()
      if (dispose) cleanups.push(dispose)
    },
    reflect: {
      provide: (name, value) => {
        assert.equal(name, 'weworkConnections')
        service = value
        return () => {}
      },
    },
    webServer: {
      port: server.address().port,
      register: descriptor => {
        assert.equal(descriptor.path, BASE_PATH)
        handler = descriptor.handler
        return () => {}
      },
    },
  }
  try {
    await apply(ctx)
    const manifest = join(root, 'package.json')
    await writeFile(
      manifest,
      JSON.stringify({
        name: '@test/documents',
        wework: {
          connections: {
            apiVersion: 1,
            dependencies: {},
            providers: [
              {
                id: 'document',
                displayName: 'Documents',
                uses: [],
                resourceKinds: ['document'],
                resourceLabels: { document: 'Document' },
                collectionModes: ['poll'],
                eventTypes: ['document.updated'],
                versionedEventTypes: [],
              },
            ],
          },
        },
      })
    )
    await service.register(ctx, pathToFileURL(manifest), {
      document: {
        check: async () => ({ status: 'ready' }),
        listResources: async () => ({ items: [source] }),
        validate: async (_ctx, value) => value,
        initialize: async () => ({ cursor: 40 }),
        collect: async (_ctx, input) => {
          assert.deepEqual(input.source, source)
          assert.deepEqual(input.checkpoint, { cursor: 40 })
          return {
            events: [
              {
                id: 'event-41',
                text: 'Document changed',
                eventType: 'document.updated',
                at: '2026-11-15T00:00:01Z',
              },
            ],
            nextCheckpoint: { cursor: 41 },
            hasMore: false,
          }
        },
      },
    })
    const response = await fetch(`http://127.0.0.1:${server.address().port}${BASE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${host.token}` },
      body: JSON.stringify({
        method: 'collectCloudObservation',
        input: {
          backendUrl: `http://127.0.0.1:${backend.address().port}`,
          collectorToken: 'scoped-source-token',
          expectedOwnerId: 7,
        },
      }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, result: { accepted: true, sequence: 1 } })
    assert.deepEqual(
      calls.map(call => call.action),
      ['read_lease', 'commit']
    )
    assert.deepEqual(calls[1].page.nextCheckpoint, { cursor: 41 })
    assert.equal(calls[1].page.events[0].id, 'event-41')
    const foreign = await fetch(`http://127.0.0.1:${server.address().port}${BASE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${host.token}` },
      body: JSON.stringify({
        method: 'collectCloudObservation',
        input: {
          backendUrl: `http://127.0.0.1:${backend.address().port}`,
          collectorToken: 'another-owner-token',
          expectedOwnerId: 8,
        },
      }),
    })
    assert.equal((await foreign.json()).error.code, 'observation_owner_changed')
    assert.equal(
      calls.length,
      2,
      'A running owner service must reject another account before reading its lease'
    )
  } finally {
    for (const dispose of cleanups.reverse()) dispose()
    ExecutorRuntimeClient.fromEnvironment = original
    if (previousOwner === undefined) delete process.env.WEWORK_CONNECTION_OWNER_ID
    else process.env.WEWORK_CONNECTION_OWNER_ID = previousOwner
    await Promise.all([
      new Promise(resolve => server.close(resolve)),
      new Promise(resolve => backend.close(resolve)),
    ])
    await rm(root, { recursive: true, force: true })
  }
  assert.equal(stops, 1)
})
