import { createHash, randomUUID } from 'node:crypto'
import type {
  ModelRecoveryCandidate,
  ModelRecoverySnapshot,
} from './model-configuration-contract.js'
import { legacyModelProviders } from './legacy-model-configuration.js'
import { parseModelConfiguration, type ModelProvider } from './model-configuration-schema.js'
import { MODEL_LAST_GOOD, type ModelSecrets } from './model-configuration-transaction.js'

interface RecoverySource {
  id: string
  kind: ModelRecoveryCandidate['kind']
  providers: ModelProvider[]
}

export interface ModelRecoveryState {
  values: Record<string, string>
  sources: RecoverySource[]
  snapshot: ModelRecoverySnapshot
}

const hash = (source: string) => createHash('sha256').update(source).digest('hex')
export const recoveryReceipt = (id: string) => `wework-models.recovered.${id}`

export function modelRecoveryRevision(current: Record<string, string>): string {
  return hash(JSON.stringify(recoveryValues(current)))
}

function recoveryValues(current: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(current)
      .filter(([key]) => /^(wework-models\.|wework-model-key\.|wework-mirrors\.)/.test(key))
      .sort(([a], [b]) => a.localeCompare(b))
  )
}

/** Read candidates and their authorization revision in one protected transaction. */
export async function readModelRecovery(secrets: ModelSecrets): Promise<ModelRecoveryState> {
  let values: Record<string, string> = {}
  await secrets.update(current => {
    values = recoveryValues(current)
  })
  const sources = new Map<string, RecoverySource>()
  let unreadableArchives = 0
  const legacy = (source: string) => {
    const id = hash(`legacy-models\0${source}`)
    const providers = legacyModelProviders(source)
    if (!values[recoveryReceipt(id)] && providers.length)
      sources.set(id, { id, kind: 'legacy-models', providers })
  }
  if (values['wework-models.legacy']) {
    try {
      legacy(values['wework-models.legacy'])
    } catch {
      unreadableArchives++
    }
  }
  for (const [key, source] of Object.entries(values)) {
    if (!key.startsWith('wework-mirrors.recovery.')) continue
    try {
      const archive = JSON.parse(source) as { name?: unknown; base64?: unknown }
      if (typeof archive.name !== 'string' || typeof archive.base64 !== 'string') throw new Error()
      const bytes = Buffer.from(archive.base64, 'base64')
      if (bytes.toString('base64') !== archive.base64) throw new Error()
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (archive.name === 'legacy-model-settings') legacy(content)
      else if (
        /^renderer-local-storage\.json(?:\.corrupt-[0-9]+|\.[a-zA-Z0-9.-]+\.tmp)?$/.test(
          archive.name
        )
      ) {
        const renderer = JSON.parse(content)
        if (renderer?.version !== 1 || !renderer.entries || Array.isArray(renderer.entries))
          throw new Error()
        const models = renderer?.entries?.['wework.localModelSettings.v1']
        if (typeof models === 'string') legacy(models)
        else unreadableArchives++
      } else unreadableArchives++
    } catch {
      // Raw damaged bytes remain private and untouched; never expose parser excerpts.
      unreadableArchives++
    }
  }
  if (values[MODEL_LAST_GOOD]) {
    try {
      const saved = JSON.parse(values[MODEL_LAST_GOOD]) as { path: string; source: string }
      if (typeof saved.path !== 'string' || typeof saved.source !== 'string') throw new Error()
      const providers = parseModelConfiguration(saved.source).config.providers
      const id = hash(`saved-configuration\0${values[MODEL_LAST_GOOD]}`)
      if (providers.length) sources.set(id, { id, kind: 'saved-configuration', providers })
    } catch {
      unreadableArchives++
    }
  }
  return {
    values,
    sources: [...sources.values()],
    snapshot: {
      revision: hash(JSON.stringify(values)),
      candidates: [...sources.values()].map(({ id, kind, providers }) => ({
        id,
        kind,
        providers: providers.map(provider => ({
          name: provider.name,
          baseUrl: provider.base_url,
          apiFormat: provider.api_format,
          models: provider.models.map(model => model.display_name || model.model_id),
        })),
      })),
      unreadableArchives,
      cloudConflicts: Object.keys(values).filter(key => key.startsWith('wework-mirrors.conflict.'))
        .length,
    },
  }
}

/** Restore complete connections, retaining targets while separating every local identity. */
export function independentRecoveryProviders(providers: ModelProvider[]): ModelProvider[] {
  const models = new Map(
    providers.flatMap(provider =>
      provider.models.map(model => [model.id, `recovered-${randomUUID()}`] as const)
    )
  )
  return providers.map(provider => ({
    ...structuredClone(provider),
    id: `recovered-${randomUUID()}`,
    models: provider.models.map(model => {
      const id = models.get(model.id)!
      const result = { ...structuredClone(model), id }
      if (result.vision_model_config_id) {
        const target = models.get(result.vision_model_config_id)
        if (!target)
          throw new Error('Archived vision connection is unavailable; reconfigure it explicitly')
        result.vision_model_config_id = target
      }
      if (result.catalog_entry) {
        result.catalog_entry.slug = id
        result.codex_catalog_model_id = id
      }
      return result
    }),
  }))
}
