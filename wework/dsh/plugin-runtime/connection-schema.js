import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { ConnectionError } from './connections.js'

const ajv = new Ajv({ allErrors: false, addUsedSchema: false })
addFormats(ajv)
const validators = new WeakMap()

export function boundedJson(value, maximum, message) {
  try {
    const encoded = JSON.stringify(value)
    if (encoded === undefined || Buffer.byteLength(encoded) > maximum) throw new Error()
  } catch {
    throw new ConnectionError('invalid_connection', message)
  }
}

export function compileSchema(schema, object = false) {
  boundedJson(schema, 65536, 'Connection schema exceeds the JSON budget')
  if (
    !schema ||
    typeof schema !== 'object' ||
    Array.isArray(schema) ||
    (object && schema.type !== 'object')
  )
    throw new ConnectionError('invalid_connection', 'Invalid connection JSON Schema')
  let validate = validators.get(schema)
  if (!validate) {
    try {
      validate = ajv.compile(schema)
      ajv.removeSchema(schema)
      if (validate.$async) throw new Error()
    } catch {
      throw new ConnectionError('invalid_connection', 'Invalid connection JSON Schema')
    }
    validators.set(schema, validate)
  }
  return validate
}

export function validateSchema(schema, value, message) {
  if (!compileSchema(schema)(value)) throw new ConnectionError('invalid_connection', message)
}
