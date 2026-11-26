import { createHash } from 'node:crypto'
import { ConnectionError } from './connections.js'
import { compileSchema } from './connection-schema.js'

function invalid(message) {
  throw new ConnectionError('invalid_web_connection', message)
}

function responseError(message) {
  throw new ConnectionError('connection_response_invalid', message)
}

function pathAt(value, path) {
  for (const key of path) {
    if (value == null || !Object.hasOwn(value, key)) return undefined
    value = value[key]
  }
  return value
}

function validPath(path) {
  return (
    Array.isArray(path) &&
    path.length <= 16 &&
    path.every(
      key =>
        (typeof key === 'string' && key.length > 0 && key.length <= 100) ||
        (Number.isSafeInteger(key) && key >= 0)
    )
  )
}

function compileView(view, operations) {
  const fields = Object.entries(view?.fields ?? {})
  if (
    typeof view?.operation !== 'string' ||
    !Object.hasOwn(operations, view.operation) ||
    !validPath(view.rows) ||
    !Object.hasOwn(view.fields ?? {}, 'id') ||
    fields.length > 64 ||
    !fields.every(([key, path]) => /^[a-z][a-zA-Z0-9_]{0,79}$/.test(key) && validPath(path)) ||
    (view.cursor !== undefined && !validPath(view.cursor))
  )
    invalid('Invalid response mapping')
  return async (http, parameters) => {
    const response = await http.read(view.operation, parameters)
    const rows = pathAt(response, view.rows)
    if (!Array.isArray(rows) || rows.length > 1000) responseError('Expected a bounded page of rows')
    const items = rows.map(row => {
      const values = Object.fromEntries(
        fields
          .map(([key, path]) => [key, pathAt(row, path)])
          .filter(([, value]) => value !== undefined)
      )
      if (typeof values.id === 'number' && Number.isSafeInteger(values.id))
        values.id = String(values.id)
      if (typeof values.id !== 'string' || !values.id || values.id.length > 512)
        responseError('A row is missing its stable ID')
      return values
    })
    const cursor = view.cursor === undefined ? undefined : pathAt(response, view.cursor)
    if (cursor != null && (typeof cursor !== 'string' || !cursor || cursor.length > 4096))
      responseError('The site returned an invalid continuation')
    return { items, ...(cursor == null ? {} : { cursor }) }
  }
}

function decodeCursor(cursor, scope) {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (value.scope === scope && typeof value.cursor === 'string') return value
  } catch {
    // Invalid cursors are rejected below.
  }
  invalid('This continuation does not belong to the connected source')
}

function encodeCursor(value) {
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64url')
  if (encoded.length > 8192) responseError('The continuation exceeds the supported size')
  return encoded
}

function eventFor(row) {
  const version = createHash('sha256').update(JSON.stringify(row)).digest('hex')
  return {
    id: version,
    objectId: row.id,
    version,
    at: row.at,
    eventType: 'web.record',
    text: typeof row.text === 'string' && row.text ? row.text : JSON.stringify(row),
  }
}

/** Interprets a generated connection using only the HTTP operations supplied by the host. */
export function createWebConnectionProvider(input, httpFor, now = () => new Date()) {
  const definition = structuredClone(input)
  const { resource, operations, check, read, poll } = definition
  if (
    !resource ||
    !['id', 'name', 'profile', 'kind'].every(
      key => typeof resource[key] === 'string' && resource[key]
    ) ||
    resource.id === '*' ||
    typeof check?.operation !== 'string' ||
    !Object.hasOwn(operations ?? {}, check.operation) ||
    !validPath(check.accountPath) ||
    !['string', 'number'].includes(typeof check.accountId) ||
    String(check.accountId) !== resource.profile ||
    !Object.hasOwn(poll?.fields ?? {}, 'at')
  )
    invalid('Missing resource, session check or event timestamp')
  const readPage = compileView(read, operations)
  const pollPage = compileView(poll, operations)
  const validateRead = compileSchema(read.inputSchema, true)
  const validateItem = compileSchema(read.itemSchema, true)
  const sourceScope = JSON.stringify([resource.profile, resource.kind, resource.id])
  if (
    poll.minimum !== undefined &&
    (!Object.hasOwn(poll.fields, poll.minimum.field) || !Number.isFinite(poll.minimum.value))
  )
    invalid('Invalid event threshold')

  async function sessionHttp(context) {
    const http = httpFor(context)
    const response = await http.read(check.operation, check.parameters ?? {})
    if (pathAt(response, check.accountPath) !== check.accountId)
      throw new ConnectionError('connector_auth_required', 'The active site account has changed')
    return http
  }

  async function availability(context) {
    try {
      await sessionHttp(context)
      return { status: 'ready' }
    } catch (error) {
      return error.code === 'connector_auth_required'
        ? { status: 'auth_required', code: error.code }
        : { status: 'error', code: error.code ?? 'connection_http_failed' }
    }
  }

  return {
    check: availability,
    async listResources(context, { kind }) {
      if (kind !== resource.kind) return { items: [] }
      const ready = await availability(context)
      return ready.status === 'ready'
        ? { items: [{ ...resource, providerId: context.providerId }] }
        : { items: [], availability: ready }
    },
    async validate(context, source) {
      if (
        source.providerId !== context.providerId ||
        source.scope !== undefined ||
        JSON.stringify([source.profile, source.kind, source.id]) !== sourceScope
      )
        invalid('The source is outside this connection')
      return source
    },
    async initialize() {
      return { since: now().toISOString() }
    },
    async readSource(context, { query, cursor }) {
      const decoded = cursor === undefined ? undefined : decodeCursor(cursor, sourceScope)
      const parameters = decoded?.query ?? query ?? {}
      if (!validateRead(parameters)) invalid('Invalid web connection query')
      const page = await readPage(await sessionHttp(context), {
        ...parameters,
        ...(decoded ? { cursor: decoded.cursor } : {}),
      })
      if (!page.items.every(validateItem)) responseError('The site returned unexpected row fields')
      if (page.cursor && page.cursor === decoded?.cursor)
        responseError('The site repeated its continuation')
      return {
        items: page.items,
        hasMore: page.cursor !== undefined,
        ...(page.cursor === undefined
          ? {}
          : {
              nextCursor: encodeCursor({
                scope: sourceScope,
                query: parameters,
                cursor: page.cursor,
              }),
            }),
      }
    },
    async collect(context, { checkpoint = {} }) {
      const { since, cursor, until = now().toISOString() } = checkpoint
      const start = Date.parse(since)
      const end = Date.parse(until)
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
        invalid('Invalid observation checkpoint')
      if (end === start) return { events: [], nextCheckpoint: { since }, hasMore: false }
      const page = await pollPage(await sessionHttp(context), {
        ...poll.parameters,
        since,
        until,
        ...(cursor === undefined ? {} : { cursor }),
      })
      if (page.cursor && page.cursor === cursor) responseError('The site repeated its continuation')
      const events = []
      for (const row of page.items) {
        const at = Date.parse(row.at)
        if (!Number.isFinite(at) || at <= start || at > end)
          responseError('The site returned an event outside the requested time window')
        if (poll.minimum !== undefined) {
          const value = row[poll.minimum.field]
          if (!Number.isFinite(value)) responseError('An event is missing its numeric measurement')
          if (value <= poll.minimum.value) continue
        }
        events.push(eventFor(row))
      }
      return {
        events,
        nextCheckpoint:
          page.cursor === undefined ? { since: until } : { since, until, cursor: page.cursor },
        hasMore: page.cursor !== undefined,
      }
    },
  }
}
