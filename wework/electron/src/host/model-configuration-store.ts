import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isMap, isSeq, type Document, type YAMLMap, type YAMLSeq } from 'yaml'
import {
  MAX_MODEL_CONFIGURATION_BYTES,
  parseModelConfiguration,
  validateModelConfiguration,
  type ModelConfiguration,
  type ModelConfigurationSnapshot,
  type ModelProvider,
  type ResolvedProviderModel,
} from './model-configuration-schema.js'
import type { SecureValueStore } from './secure-value-store.js'

const EMPTY_FILE =
  '# WeWork local model connections. Cloud models are managed separately.\nversion: 1\nproviders: []\n'
const LAST_GOOD_KEY = 'wework-models.last-good'

interface LoadedConfiguration {
  path: string
  source: string
  revision: string
  config: ModelConfiguration
}

/** Bind a revision to both the selected file path and its exact contents. */
function digest(path: string, source: string): string {
  return createHash('sha256').update(path).update('\0').update(source).digest('hex')
}

/** Replace a configuration through an owner-only temporary file in the same directory. */
async function atomicWrite(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, source, { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
    await chmod(path, 0o600)
  } finally {
    await rm(temporary, { force: true })
  }
}

/** One file owns local connections; renderer caches and catalogs are derived. */
export class ModelConfigurationStore {
  private operation: Promise<unknown> = Promise.resolve()
  private lastGood: LoadedConfiguration | null = null
  private lastError: string | undefined

  /** Use an application configuration directory and the existing encrypted credential store. */
  constructor(
    private readonly directory: string,
    private readonly secrets: Pick<SecureValueStore, 'get' | 'set' | 'delete'>
  ) {}

  /** Serialize mutations and reads while allowing later operations after a rejected request. */
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation)
    this.operation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  /** Resolve the explicit file binding or the default per-user configuration file. */
  private async boundPath(): Promise<string> {
    try {
      const binding = JSON.parse(
        await readFile(join(this.directory, 'model-binding.json'), 'utf8')
      ) as { path?: unknown }
      if (typeof binding.path !== 'string' || !binding.path)
        throw new Error('Invalid model file binding')
      return binding.path
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return join(this.directory, 'model.yml')
    }
  }

  /** Read and validate a bounded file, allowing an empty initial configuration only when requested. */
  private async load(path: string, allowEmpty: boolean): Promise<LoadedConfiguration> {
    let source: string
    try {
      if ((await stat(path)).size > MAX_MODEL_CONFIGURATION_BYTES)
        throw new Error('model.yml exceeds 2 MiB')
      source = await readFile(path, 'utf8')
    } catch (error) {
      if (!allowEmpty || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      source = EMPTY_FILE
    }
    return {
      path,
      source,
      revision: digest(path, source),
      config: parseModelConfiguration(source).config,
    }
  }

  /** Persist the encrypted recovery snapshot before publishing a new valid configuration. */
  private async accept(loaded: LoadedConfiguration): Promise<void> {
    // Persist only a recovery snapshot, never a second editable configuration.
    // The existing encrypted credential store protects inline keys in this snapshot.
    if (this.lastGood?.revision !== loaded.revision || this.lastGood.path !== loaded.path) {
      await this.secrets.set(
        LAST_GOOD_KEY,
        JSON.stringify({ path: loaded.path, source: loaded.source })
      )
    }
    this.lastGood = loaded
    this.lastError = undefined
  }

  /** Resolve one credential without making unrelated providers or the recovery UI unavailable. */
  private async credential(provider: ModelProvider): Promise<string | null> {
    if (provider.api_key) return provider.api_key
    if (!provider.api_key_ref) return null
    try {
      return await this.secrets.get(provider.api_key_ref)
    } catch {
      // The settings snapshot reports the key as unavailable; never leak storage error details.
      return null
    }
  }

  /** Expose editable connection metadata and credential availability without plaintext keys. */
  private async publicSnapshot(loaded: LoadedConfiguration): Promise<ModelConfigurationSnapshot> {
    return {
      path: loaded.path,
      revision: loaded.revision,
      loadedAt: new Date().toISOString(),
      ...(this.lastError ? { error: this.lastError } : {}),
      providers: await Promise.all(
        loaded.config.providers.map(async provider => {
          const { api_key: key, ...safe } = provider
          return {
            ...safe,
            api_key_configured: Boolean(key || (await this.credential(provider))),
          }
        })
      ),
    }
  }

  /** Load the selected configuration or retain its last valid snapshot with a visible file error. */
  async read(): Promise<ModelConfigurationSnapshot> {
    return this.serial(async () => {
      const path = await this.boundPath()
      if (!this.lastGood) {
        const saved = await this.secrets.get(LAST_GOOD_KEY)
        if (saved) {
          const recovery = JSON.parse(saved) as { path: string; source: string }
          if (recovery.path === path) {
            this.lastGood = {
              path,
              source: recovery.source,
              revision: digest(path, recovery.source),
              config: parseModelConfiguration(recovery.source).config,
            }
          }
        }
      }
      try {
        const loaded = await this.load(
          path,
          (!this.lastGood || this.lastGood.config.providers.length === 0) &&
            path === join(this.directory, 'model.yml')
        )
        await this.accept(loaded)
        return this.publicSnapshot(loaded)
      } catch (error) {
        this.lastError =
          error instanceof Error && error.message.startsWith('model.yml')
            ? error.message
            : 'model.yml could not be read; the previous valid configuration is retained'
        if (!this.lastGood) {
          const saved = await this.secrets.get(LAST_GOOD_KEY)
          if (saved) {
            const recovery = JSON.parse(saved) as { path: string; source: string }
            if (recovery.path === path) {
              this.lastGood = {
                path,
                source: recovery.source,
                revision: digest(path, recovery.source),
                config: parseModelConfiguration(recovery.source).config,
              }
            }
          }
        }
        return this.publicSnapshot(
          this.lastGood ?? {
            path,
            source: EMPTY_FILE,
            revision: digest(path, EMPTY_FILE),
            config: { version: 1, providers: [] },
          }
        )
      }
    })
  }

  /** Validate a selected file before atomically changing the persisted binding. */
  async bind(path: string): Promise<ModelConfigurationSnapshot> {
    return this.serial(async () => {
      const canonical = await realpath(path)
      const loaded = await this.load(canonical, false)
      await atomicWrite(
        join(this.directory, 'model-binding.json'),
        JSON.stringify({ path: canonical })
      )
      await this.accept(loaded)
      return this.publicSnapshot(loaded)
    })
  }

  /** Create only a fresh default file; never recreate a missing populated configuration. */
  async ensureFile(): Promise<string> {
    return this.serial(async () => {
      const path = await this.boundPath()
      try {
        await stat(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (this.lastGood?.config.providers.length)
          throw new Error('model.yml is missing; restore it before opening', { cause: error })
        await atomicWrite(path, EMPTY_FILE)
      }
      return path
    })
  }

  /** Commit a revision-checked provider document, protect new keys, and retire unused credentials. */
  async save(expectedRevision: string, providers: unknown): Promise<ModelConfigurationSnapshot> {
    return this.serial(async () => {
      if (this.lastError) throw new Error('Fix and reload model.yml before saving')
      const path = await this.boundPath()
      const current = await this.load(
        path,
        path === join(this.directory, 'model.yml') && !this.lastGood?.config.providers.length
      )
      if (current.revision !== expectedRevision)
        throw new Error(
          'model.yml changed externally. Reload before saving; no changes were overwritten.'
        )
      if (!Array.isArray(providers)) throw new Error('providers must be an array')
      const previous = new Map(current.config.providers.map(provider => [provider.id, provider]))
      const newSecretReferences: string[] = []
      try {
        const prepared = providers.map(value => {
          if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error('Invalid provider')
          const provider = { ...(value as Record<string, unknown>) }
          delete provider.api_key_configured
          const before = previous.get(provider.id as string)
          if (provider.api_key === undefined && provider.api_key_ref === undefined && before) {
            if (before.api_key) provider.api_key = before.api_key
            if (before.api_key_ref) provider.api_key_ref = before.api_key_ref
          }
          // Blank password means keep the existing credential, never erase it.
          if (provider.api_key === '') {
            delete provider.api_key
            if (before?.api_key) provider.api_key = before.api_key
            if (before?.api_key_ref) provider.api_key_ref = before.api_key_ref
          }
          if (provider.api_key) delete provider.api_key_ref
          return provider
        })
        const config = validateModelConfiguration({ version: 1, providers: prepared })
        for (const provider of config.providers) {
          if (provider.api_key) {
            const ref = `wework-model-key.${randomUUID()}`
            await this.secrets.set(ref, provider.api_key)
            newSecretReferences.push(ref)
            delete provider.api_key
            provider.api_key_ref = ref
          }
        }
        const { document } = parseModelConfiguration(current.source)
        patchProviders(document, config.providers)
        const source = document.toString({ lineWidth: 100 })
        parseModelConfiguration(source)
        // Check again after asynchronous credential writes to catch external edits.
        const latest = await this.load(
          path,
          path === join(this.directory, 'model.yml') && !this.lastGood?.config.providers.length
        )
        if (latest.revision !== expectedRevision)
          throw new Error(
            'model.yml changed externally. Reload before saving; no changes were overwritten.'
          )
        await atomicWrite(path, source)
        const loaded = { path, source, revision: digest(path, source), config }
        await this.accept(loaded)
        // Update recovery before retiring old keys, and preserve references still shared by a provider.
        const retained = new Set(config.providers.map(provider => provider.api_key_ref))
        const retired = new Set(current.config.providers.map(provider => provider.api_key_ref))
        for (const reference of retired) {
          if (reference && !retained.has(reference)) {
            try {
              await this.secrets.delete(reference)
            } catch {
              // Saving succeeded. Cleanup must not roll back keys that the committed file needs.
              console.warn('An unused model credential could not be removed from secure storage')
            }
          }
        }
        return this.publicSnapshot(loaded)
      } catch (error) {
        // Do not remove references after a successful file write if backup storage fails.
        let currentText = ''
        try {
          currentText = await readFile(path, 'utf8')
        } catch {
          /* no file committed */
        }
        for (const ref of newSecretReferences) {
          if (!currentText.includes(ref)) await this.secrets.delete(ref)
        }
        throw error
      }
    })
  }

  /** Resolve usable providers independently; unavailable credentials must not disable other connections. */
  async runtime(): Promise<{ revision: string; models: ResolvedProviderModel[] }> {
    return this.serial(async () => {
      if (!this.lastGood) return { revision: '', models: [] }
      const models: ResolvedProviderModel[] = []
      for (const provider of this.lastGood.config.providers) {
        const { models: entries, ...connection } = provider
        const key = await this.credential(provider)
        // Do not expose an authenticated connection as an unauthenticated runtime model.
        // Keep its public settings row editable so the user can supply a replacement key.
        if (connection.api_key_ref && !key) continue
        for (const model of entries)
          models.push({ provider: { ...connection, ...(key ? { api_key: key } : {}) }, model })
      }
      return { revision: this.lastGood.revision, models }
    })
  }

  /** Fetch model IDs from a validated saved connection or unsaved draft without persisting the draft. */
  async discover(providerId: string, draft?: unknown): Promise<string[]> {
    const connection = await this.serial(async () => {
      const saved = this.lastGood?.config.providers.find(entry => entry.id === providerId)
      let provider = saved
      if (draft !== undefined) {
        if (!draft || typeof draft !== 'object' || Array.isArray(draft))
          throw new Error('Model discovery requires connection settings')
        const input = draft as Record<string, unknown>
        // Validate only connection fields: unfinished model rows must not block discovery.
        // Never trust a credential reference supplied by the renderer or persist a draft here.
        provider = validateModelConfiguration({
          version: 1,
          providers: [
            {
              id: providerId,
              name: 'Model discovery',
              base_url: input.base_url,
              api_format: input.api_format,
              api_key: input.api_key === '' ? undefined : input.api_key,
              models_path: input.models_path,
              models_api_key_header: input.models_api_key_header,
              models: [],
            },
          ],
        }).providers[0]
      }
      if (!provider) throw new Error('Enter the connection address before retrieving models')
      const apiKey = provider.api_key ?? (saved ? await this.credential(saved) : null)
      if (saved?.api_key_ref && !apiKey)
        throw new Error('The saved API key is unavailable. Enter it again to retrieve models.')
      return { provider, apiKey }
    })
    const { provider, apiKey } = connection
    const path = provider.models_path ?? '/models'
    const headers: Record<string, string> = {}
    if (apiKey)
      headers[provider.models_api_key_header ?? 'Authorization'] =
        provider.models_api_key_header === 'X-Api-Key' ? apiKey : `Bearer ${apiKey}`
    let response: Response
    try {
      response = await fetch(`${provider.base_url}${path}`, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      throw new Error('Model discovery failed or timed out. Manual model entry is still available.')
    }
    if (!response.ok)
      throw new Error(
        `Model discovery returned HTTP ${response.status}. Manual model entry is still available.`
      )
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > MAX_MODEL_CONFIGURATION_BYTES) throw new Error('Model list is too large')
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Empty model list response')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > MAX_MODEL_CONFIGURATION_BYTES) throw new Error('Model list is too large')
        chunks.push(chunk.value)
      }
    } catch {
      throw new Error(
        'Model list could not be read or is too large. Manual model entry is still available.'
      )
    } finally {
      await reader.cancel().catch(() => {})
    }
    let body: { data?: unknown }
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { data?: unknown }
    } catch {
      throw new Error('Model list is not valid JSON')
    }
    if (!body || typeof body !== 'object' || !Array.isArray(body.data))
      throw new Error('Model list must contain a data array')
    return [
      ...new Set(
        body.data.flatMap(item =>
          item && typeof item.id === 'string' && item.id.trim() ? [item.id.trim()] : []
        )
      ),
    ].sort()
  }
}

/** Update changed mapping values while retaining compatible YAML nodes and their comments. */
function patchMap(document: Document, node: YAMLMap, value: Record<string, unknown>): void {
  for (const pair of [...node.items]) {
    const key = String(pair.key)
    if (!Object.hasOwn(value, key)) node.delete(key)
  }
  for (const [key, next] of Object.entries(value)) {
    if (key === 'models' && Array.isArray(next)) {
      patchSequence(document, node, key, next as Array<Record<string, unknown>>)
    } else if (
      JSON.stringify((node.toJSON() as Record<string, unknown>)[key]) !== JSON.stringify(next)
    ) {
      node.set(key, document.createNode(next))
    }
  }
}

/** Reconcile an ID-keyed sequence in the requested order while reusing unchanged nodes. */
function patchSequence(
  document: Document,
  parent: Document | YAMLMap,
  key: string,
  values: Array<Record<string, unknown>>
): void {
  const existing = parent.get(key, true)
  const sequence: YAMLSeq = isSeq(existing) ? existing : (document.createNode([]) as YAMLSeq)
  const byId = new Map(sequence.items.filter(isMap).map(node => [node.get('id'), node]))
  sequence.items = values.map(value => {
    const node = byId.get(value.id) ?? (document.createNode({}) as YAMLMap)
    patchMap(document, node, value)
    return node
  })
  parent.set(key, sequence)
}

/** Write the provider sequence through the comment-preserving document updater. */
function patchProviders(document: Document, providers: ModelProvider[]): void {
  patchSequence(
    document,
    document,
    'providers',
    providers as unknown as Array<Record<string, unknown>>
  )
}
