import { parseDocument, type Document } from 'yaml'

import type { ModelConfiguration } from './model-configuration-contract.js'

export type {
  ModelApiFormat,
  ModelProvider,
  ProviderModel,
  PublicModelProvider,
  ModelConfiguration,
  ModelConfigurationSnapshot,
  ResolvedProviderModel,
} from './model-configuration-contract.js'
export { MODEL_API_FORMATS } from './model-configuration-contract.js'

export { validateModelConfiguration } from './model-configuration-validation.js'
import { validateModelConfiguration } from './model-configuration-validation.js'

export const MAX_MODEL_CONFIGURATION_BYTES = 2 * 1024 * 1024

function fail(path: string, reason: string): never {
  throw new Error(`model.yml: ${path}: ${reason}`)
}

/** Parse bounded YAML without aliases and report syntax locations without secret excerpts. */
export function parseModelConfiguration(source: string): {
  document: Document
  config: ModelConfiguration
} {
  if (Buffer.byteLength(source, 'utf8') > MAX_MODEL_CONFIGURATION_BYTES)
    fail('root', 'file exceeds 2 MiB')
  const document = parseDocument(source, { uniqueKeys: true, prettyErrors: false })
  if (document.errors.length) {
    const error = document.errors[0]
    const line = source.slice(0, error.pos[0]).split('\n').length
    fail(`line ${line}`, `invalid YAML (${error.code})`)
  }
  let value: unknown
  try {
    value = document.toJS({ maxAliasCount: 0 })
  } catch {
    fail('root', 'YAML aliases are not supported')
  }
  return { document, config: validateModelConfiguration(value) }
}
