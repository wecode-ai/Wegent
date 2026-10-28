import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SecureValueStore } from './secure-value-store.js'
import { durableWrite } from './durable-file.js'
import { parseModelConfiguration } from './model-configuration-schema.js'

export const MODEL_LAST_GOOD = 'wework-models.last-good'
const PENDING = 'wework-models.pending'
export const MODEL_FILES = 'wework-models.files'
const FILES = MODEL_FILES
export type ModelSecrets = Pick<SecureValueStore, 'get' | 'set' | 'delete' | 'update'>
interface Publication {
  version: 3
  path: string
  previous: string | null
  source: string
  bindingDirectory: string
  retired: string[]
  expectedAnchor: string | null
}

export class ModelPublicationConflictError extends Error {
  constructor() {
    super('model.yml changed during publication; recovery did not overwrite it')
    this.name = 'ModelPublicationConflictError'
  }
}

/** The OS-vault commit owns the new keys, snapshot and recoverable publication intent. */
export async function commitModelConfiguration(
  secrets: ModelSecrets,
  publication: Publication,
  additions: Record<string, string>,
  supersededPublication?: string,
  precondition?: (values: Record<string, string>) => void
): Promise<void> {
  parseModelConfiguration(publication.source)
  await secrets.update(values => {
    precondition?.(values)
    if (values[PENDING] && values[PENDING] !== supersededPublication)
      throw new Error(
        'model.yml publication requires recovery; choose a valid file to continue without overwriting external edits'
      )
    if ((values[MODEL_LAST_GOOD] ?? null) !== publication.expectedAnchor)
      throw new Error(
        'model.yml changed externally. Reload before saving; no changes were overwritten.'
      )
    const files = JSON.parse(values[FILES] ?? '{}') as Record<string, string>
    files[publication.path] = publication.source
    Object.assign(values, additions)
    values[FILES] = JSON.stringify(files)
    values[MODEL_LAST_GOOD] = JSON.stringify({ path: publication.path, source: publication.source })
    values[PENDING] = JSON.stringify(publication)
  })
  await recoverModelConfiguration(secrets)
}

export function pendingModelPublication(secrets: ModelSecrets): Promise<string | null> {
  return secrets.get(PENDING)
}

export async function recoverModelConfiguration(secrets: ModelSecrets): Promise<void> {
  const stored = await secrets.get(PENDING)
  if (!stored) return
  const pending = JSON.parse(stored) as Publication
  if (
    pending.version !== 3 ||
    typeof pending.path !== 'string' ||
    typeof pending.source !== 'string' ||
    typeof pending.bindingDirectory !== 'string' ||
    !Array.isArray(pending.retired)
  ) {
    throw new Error('model.yml recovery metadata is invalid')
  }
  parseModelConfiguration(pending.source)
  let current: string | null = null
  try {
    current = await readFile(pending.path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (current !== pending.source && current !== pending.previous) {
    throw new ModelPublicationConflictError()
  }
  if (current !== pending.source) await durableWrite(pending.path, pending.source)
  await durableWrite(
    join(pending.bindingDirectory, 'model-binding.json'),
    JSON.stringify({ path: pending.path, credential_protocol: 3 })
  )
  await secrets.update(values => {
    if (values[PENDING] !== stored) throw new Error('model.yml recovery revision changed')
    const files = JSON.parse(values[FILES] ?? '{}') as Record<string, string>
    const retained = new Set(
      Object.values(files).flatMap(source =>
        parseModelConfiguration(source).config.providers.flatMap(provider =>
          provider.api_key_ref ? [provider.api_key_ref] : []
        )
      )
    )
    for (const key of pending.retired) if (!retained.has(key)) delete values[key]
    delete values[PENDING]
  })
}
