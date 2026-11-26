import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createConnectionHttp } from './connection-http.js'
import { ConnectionError, parseConnections } from './connections.js'
import { boundedJson } from './connection-schema.js'
import { createWebConnectionProvider } from './web-connection-provider.js'

const ENTRY = `import { readFile } from 'node:fs/promises'

export const inject = ['weworkConnections']

export async function apply(ctx) {
  const manifest = new URL('./package.json', import.meta.url)
  const definition = await readFile(new URL('./connection.json', import.meta.url), 'utf8')
  await ctx.weworkConnections.registerWeb(ctx, manifest, definition)
}
`

function formatJson(value) {
  return JSON.stringify(value, null, 2) + '\n'
}

/** Produces the complete DSH package from a data definition and a host-selected identity. */
export function createWebConnectionPackage({ name, version, definition }) {
  if (!/^wework-web-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !/^\d+\.\d+\.\d+$/.test(version))
    throw new ConnectionError('invalid_web_connection', 'Invalid local package identity')
  boundedJson(definition, 262144, 'Web connection definition exceeds the JSON budget')
  createConnectionHttp(definition.operations, () => {
    throw new Error('HTTP is unavailable during package validation')
  })
  createWebConnectionProvider(definition, () => {
    throw new Error('HTTP is unavailable during package validation')
  })
  const { resource, origin, pathPrefix, read } = definition
  const descriptor = {
    id: 'web',
    displayName: resource.name,
    singleResource: true,
    webMatch: [{ origin, ...(pathPrefix === undefined ? {} : { pathPrefix }) }],
    uses: [],
    resourceKinds: [resource.kind],
    resourceLabels: { [resource.kind]: resource.name },
    collectionModes: ['poll'],
    collectionPagination: 'staged',
    eventTypes: ['web.record'],
    versionedEventTypes: ['web.record'],
    read: {
      inputSchema: read.inputSchema,
      itemSchema: read.itemSchema,
      pagination: read.cursor === undefined ? 'none' : 'cursor',
    },
  }
  const manifest = {
    name,
    version,
    private: true,
    type: 'module',
    main: 'index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    wework: { connections: { apiVersion: 1, providers: [descriptor] } },
  }
  parseConnections(manifest)
  const content = formatJson(definition)
  if (Buffer.byteLength(content) > 262144)
    throw new ConnectionError(
      'invalid_web_connection',
      'Generated connection definition is too large'
    )
  return {
    providerId: `${name}/web`,
    definitionDigest: createHash('sha256').update(content).digest('hex'),
    files: {
      'package.json': formatJson(manifest),
      'index.js': ENTRY,
      'connection.json': content,
      'cordis.patch.yml': `- insert:
    - id: ${name}
      name: ${name}
      inject:
        - weworkConnections
`,
    },
  }
}

/** Reuses the package provider and its normal schemas during a trial. */
export async function trialWebConnection({ definition, read, observation, request, signal }) {
  const trialPackage = createWebConnectionPackage({
    name: 'wework-web-trial',
    version: '0.0.0',
    definition,
  })
  const context = { providerId: trialPackage.providerId, signal }
  const http = createConnectionHttp(definition.operations, request, signal)
  const provider = createWebConnectionProvider(definition, () => http)
  const status = await provider.check(context)
  if (status.status !== 'ready') {
    throw new ConnectionError(status.code, 'The site session check did not succeed')
  }
  const page = await provider.readSource(context, { query: read })
  const collection = await provider.collect(context, { checkpoint: observation })
  const continuation = page.hasMore
    ? await provider.readSource(context, { cursor: page.nextCursor })
    : undefined
  if (!page.items.length && !continuation?.items.length)
    throw new ConnectionError(
      'web_connection_sample_empty',
      'Choose a trial window that contains records'
    )
  const collectionContinuation = collection.hasMore
    ? await provider.collect(context, { checkpoint: collection.nextCheckpoint })
    : undefined
  return { page, collection, continuation, collectionContinuation }
}

export async function registerWebConnection(registry, owner, manifestUrl, content, request) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 262144)
    throw new ConnectionError('invalid_web_connection', 'Invalid connection definition size')
  const storedManifest = await readFile(manifestUrl, 'utf8')
  const { name, version } = JSON.parse(storedManifest)
  const definition = JSON.parse(content)
  const { providerId, definitionDigest, files } = createWebConnectionPackage({
    name,
    version,
    definition,
  })
  if (content !== files['connection.json'] || storedManifest !== files['package.json'])
    throw new ConnectionError('invalid_web_connection', 'Generated connection files have changed')
  const implementation = createWebConnectionProvider(definition, context =>
    createConnectionHttp(
      definition.operations,
      operation => request({ providerId, definitionDigest, operation }, context.signal),
      context.signal
    )
  )
  return registry.register(owner, manifestUrl, { web: implementation })
}
