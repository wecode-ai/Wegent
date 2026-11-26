import { ConnectionError } from './connections.js'
import { boundedJson, compileSchema } from './connection-schema.js'

const operationId = /^[a-z][a-z0-9_.-]{0,79}$/

function invalid(message) {
  throw new ConnectionError('invalid_connection_http', message)
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function materialize(value, parameters) {
  if (Array.isArray(value)) return value.map(item => materialize(item, parameters))
  if (!object(value)) return value
  if (Object.hasOwn(value, '$parameter')) {
    const name = value.$parameter
    if (
      typeof name !== 'string' ||
      Object.keys(value).some(key => key !== '$parameter' && key !== 'omitIfMissing') ||
      (value.omitIfMissing !== undefined && value.omitIfMissing !== true) ||
      (!Object.hasOwn(parameters, name) && value.omitIfMissing !== true)
    )
      invalid('HTTP operation references an unavailable parameter')
    return Object.hasOwn(parameters, name) ? parameters[name] : undefined
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [key, materialize(item, parameters)])
      .filter(([, item]) => item !== undefined)
  )
}

/** Creates the plugin-facing SDK for one host-approved set of operations. */
export function createConnectionHttp(operations, request, signal) {
  boundedJson(operations, 262144, 'HTTP operation definitions exceed the JSON budget')
  if (!object(operations)) invalid('Expected HTTP operation definitions')
  const entries = Object.entries(structuredClone(operations))
  if (!entries.length || entries.length > 32) invalid('Invalid number of HTTP operations')
  const approved = new Map(
    entries.map(([id, definition]) => {
      if (
        !operationId.test(id) ||
        !object(definition) ||
        !['GET', 'POST'].includes(definition.method) ||
        typeof definition.path !== 'string' ||
        !definition.path.startsWith('/') ||
        (definition.query !== undefined && !object(definition.query)) ||
        (definition.method === 'GET' && definition.json !== undefined)
      )
        invalid('Invalid HTTP operation definition')
      return [id, { definition, validate: compileSchema(definition.inputSchema, true) }]
    })
  )
  return Object.freeze({
    async read(id, parameters = {}) {
      signal?.throwIfAborted()
      const operation = approved.get(id)
      if (!operation) invalid('HTTP operation is not declared')
      boundedJson(parameters, 65536, 'HTTP parameters exceed the JSON budget')
      if (!operation.validate(parameters)) invalid('Invalid HTTP operation parameters')
      const { method, path, query, json } = operation.definition
      return request(
        {
          method,
          path,
          ...(query === undefined ? {} : { query: materialize(query, parameters) }),
          ...(json === undefined ? {} : { json: materialize(json, parameters) }),
        },
        signal
      )
    },
  })
}
