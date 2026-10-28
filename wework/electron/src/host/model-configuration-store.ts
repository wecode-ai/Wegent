import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
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
import {
  commitModelConfiguration,
  recoverModelConfiguration,
  pendingModelPublication,
  MODEL_LAST_GOOD,
  MODEL_FILES,
  ModelPublicationConflictError,
  type ModelSecrets,
} from './model-configuration-transaction.js'
import { durableWrite } from './durable-file.js'
import { legacyModelProviders } from './legacy-model-configuration.js'
import { CredentialMirrorMigration } from './credential-mirror-migration.js'
import {
  independentRecoveryProviders,
  modelRecoveryRevision,
  readModelRecovery,
  recoveryReceipt,
} from './model-configuration-recovery.js'
import type { ModelRecoverySnapshot } from './model-configuration-contract.js'

const EMPTY_FILE =
  '# WeWork local model connections. Cloud models are managed separately.\nversion: 1\ncredential_protocol: 3\nproviders: []\n'
const LAST_GOOD_KEY = MODEL_LAST_GOOD
const LEGACY_KEY = 'wework-models.legacy'
const LEGACY_RESOLUTION = 'wework-models.legacy-resolution'

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
const atomicWrite = durableWrite

/** One file owns local connections; renderer caches and catalogs are derived. */
export class ModelConfigurationStore {
  private operation: Promise<unknown> = Promise.resolve()
  private lastGood: LoadedConfiguration | null = null
  private lastError: string | undefined

  /** Use an application configuration directory and the OS credential repository. */
  constructor(
    private readonly directory: string,
    private readonly secrets: ModelSecrets
  ) {}

  /** A file conflict may open settings for explicit recovery; vault failures still stop startup. */
  async initialize(): Promise<void> {
    try {
      await this.read()
    } catch (error) {
      if (!(error instanceof ModelPublicationConflictError)) throw error
    }
  }

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
    const committed = await this.secrets.get(LAST_GOOD_KEY)
    if (committed) {
      const saved = JSON.parse(committed) as { path: string; source: string }
      if (parseModelConfiguration(saved.source).config.credential_protocol === 3) return saved.path
    }
    try {
      const binding = JSON.parse(
        await readFile(join(this.directory, 'model-binding.json'), 'utf8')
      ) as { path?: unknown }
      if (typeof binding.path !== 'string' || !binding.path)
        throw new Error('Invalid model file binding')
      return binding.path
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const path = join(this.directory, 'model.yml')
      return realpath(path).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path
        throw error
      })
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

  /** Persist the protected recovery snapshot before publishing a new valid configuration. */
  private async accept(
    loaded: LoadedConfiguration,
    additions: Record<string, string> = {},
    expectedSource: string | null = loaded.source,
    supersededPublication?: string,
    recoveryRevision?: string
  ): Promise<void> {
    if (
      !supersededPublication &&
      Object.keys(additions).length === 0 &&
      this.lastGood?.revision === loaded.revision &&
      this.lastGood.path === loaded.path
    ) {
      this.lastError = undefined
      return
    }
    const expectedAnchor = await this.secrets.get(LAST_GOOD_KEY)
    if (
      this.lastGood &&
      expectedAnchor !== JSON.stringify({ path: this.lastGood.path, source: this.lastGood.source })
    )
      throw new Error(
        'model.yml changed externally. Reload before saving; no changes were overwritten.'
      )
    const previous = await readFile(loaded.path, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (previous !== expectedSource && !(previous === null && expectedSource === EMPTY_FILE))
      throw new Error(
        'model.yml changed externally. Reload before saving; no changes were overwritten.'
      )
    const config = structuredClone(loaded.config)
    const document = parseModelConfiguration(loaded.source).document
    for (const provider of config.providers) {
      if (provider.api_key) {
        const ref = 'wework-model-key.' + randomUUID()
        additions[ref] = provider.api_key
        delete provider.api_key
        provider.api_key_ref = ref
      }
    }
    config.credential_protocol = 3
    document.set('credential_protocol', 3)
    patchProviders(document, config.providers)
    const source = document.toString({ lineWidth: 100 })
    const retired =
      this.lastGood?.path === loaded.path
        ? this.lastGood.config.providers.flatMap(provider =>
            provider.api_key_ref ? [provider.api_key_ref] : []
          )
        : []
    await commitModelConfiguration(
      this.secrets,
      {
        version: 3,
        path: loaded.path,
        previous,
        source,
        bindingDirectory: this.directory,
        retired,
        expectedAnchor,
      },
      additions,
      supersededPublication,
      recoveryRevision === undefined
        ? undefined
        : values => {
            if (modelRecoveryRevision(values) !== recoveryRevision)
              throw new Error('Recovery sources changed; refresh before restoring')
          }
    )
    this.lastGood = { path: loaded.path, source, revision: digest(loaded.path, source), config }
    this.lastError = undefined
  }

  /** List private recovery sources as metadata, even when the selected YAML is unusable. */
  recovery(): Promise<ModelRecoverySnapshot> {
    return this.serial(async () => (await readModelRecovery(this.secrets)).snapshot)
  }

  /** Explicitly recover into independent connections or a new file; never overwrite damaged input. */
  restoreRecovery(
    id: string,
    revision: string,
    configurationRevision: string
  ): Promise<ModelConfigurationSnapshot> {
    return this.serial(async () => {
      const state = await readModelRecovery(this.secrets)
      if (state.snapshot.revision !== revision)
        throw new Error('Recovery sources changed; refresh before restoring')
      const candidate = state.sources.find(source => source.id === id)
      if (!candidate) throw new Error('Recovery source is unavailable or already restored')
      const anchor = state.values[LAST_GOOD_KEY]
      if (!anchor) throw new Error('A valid configuration must be selected before restoring')
      const saved = JSON.parse(anchor) as { path: string; source: string }
      const previous = {
        ...saved,
        config: parseModelConfiguration(saved.source).config,
        revision: digest(saved.path, saved.source),
      }
      const additions = {
        [recoveryReceipt(id)]: '3',
        [LEGACY_RESOLUTION]: 'recovery-selected',
      }
      const pending = state.values['wework-models.pending']
      if (candidate.kind === 'saved-configuration') {
        for (const provider of candidate.providers) {
          if (provider.api_key_ref && !state.values[provider.api_key_ref])
            throw new Error('A saved API key is unavailable; unlock storage or enter it again')
        }
        this.lastGood = previous
        const path = join(this.directory, `recovered-${randomUUID()}.yml`)
        const loaded = {
          path,
          source: saved.source,
          config: previous.config,
          revision: digest(path, saved.source),
        }
        // The destination must still be absent when the journal commits.
        await this.accept(loaded, additions, null, pending, revision)
      } else {
        if (pending)
          throw new Error('Recover the saved configuration before importing archived connections')
        const current = await this.load(saved.path, false)
        if (current.revision !== configurationRevision || current.source !== saved.source)
          throw new Error('model.yml changed; reload before restoring archived connections')
        this.lastGood = previous
        const config = validateModelConfiguration({
          version: 1,
          credential_protocol: 3,
          providers: [
            ...current.config.providers,
            ...independentRecoveryProviders(candidate.providers),
          ],
        })
        const { document } = parseModelConfiguration(current.source)
        patchProviders(document, config.providers)
        const source = document.toString({ lineWidth: 100 })
        await this.accept(
          { path: current.path, source, config, revision: digest(current.path, source) },
          additions,
          current.source,
          undefined,
          revision
        )
      }
      return this.publicSnapshot(this.lastGood!)
    })
  }

  private validateReferences(providers: ModelProvider[]): void {
    if (!this.lastGood || this.lastGood.config.credential_protocol !== 3) return
    for (const provider of providers) {
      const before = this.lastGood.config.providers.find(entry => entry.id === provider.id)
      if (
        !before ||
        provider.api_key_ref !== before.api_key_ref ||
        !sameCredentialTarget(before, provider)
      )
        throw new Error(
          'model.yml: credential ownership or endpoint changed; authorize it in settings'
        )
    }
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
      await recoverModelConfiguration(this.secrets)
      const path = await this.boundPath()
      {
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
        if (
          this.lastGood?.config.credential_protocol === 3 &&
          loaded.config.credential_protocol !== 3
        )
          throw new Error('model.yml: legacy files cannot replace a migrated configuration')
        if (
          this.lastGood?.config.credential_protocol === 3 &&
          loaded.config.providers.some(provider => provider.api_key)
        )
          throw new Error('model.yml: enter new keys through model settings')
        this.validateReferences(loaded.config.providers)
        await this.accept(loaded)
        const legacy = (await this.secrets.get(LEGACY_RESOLUTION))
          ? null
          : await this.secrets.get(LEGACY_KEY)
        if (legacy) {
          const existingIds = new Set(
            this.lastGood!.config.providers.flatMap(provider =>
              provider.models.map(model => model.id)
            )
          )
          const legacyProviders = legacyModelProviders(legacy)
          if (
            legacyProviders.some(provider =>
              provider.models.some(model => existingIds.has(model.id))
            )
          )
            await new CredentialMirrorMigration(this.secrets).archive(
              'legacy-model-settings',
              legacy
            )
          const additions = legacyProviders
            .map(provider => ({
              ...provider,
              models: provider.models.filter(model => !existingIds.has(model.id)),
            }))
            .filter(provider => provider.models.length > 0)
          if (additions.length) {
            const previous = this.lastGood!
            const config = {
              ...previous.config,
              providers: [...previous.config.providers, ...additions],
            }
            const document = parseModelConfiguration(previous.source).document
            patchProviders(document, config.providers)
            const source = document.toString({ lineWidth: 100 })
            await this.accept(
              { path, source, config, revision: digest(path, source) },
              {},
              previous.source
            )
          }
          await this.secrets.delete(LEGACY_KEY)
        }
        return this.publicSnapshot(this.lastGood!)
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
      const pending = await pendingModelPublication(this.secrets)
      if (pending) {
        const committed = await this.secrets.get(LAST_GOOD_KEY)
        if (!committed) throw new Error('model.yml recovery snapshot is missing')
        const saved = JSON.parse(committed) as { path: string; source: string }
        this.lastGood = {
          ...saved,
          revision: digest(saved.path, saved.source),
          config: parseModelConfiguration(saved.source).config,
        }
      }
      const files = JSON.parse((await this.secrets.get(MODEL_FILES)) ?? '{}') as Record<
        string,
        string
      >
      const trusted = Object.values(files).flatMap(
        source => parseModelConfiguration(source).config.providers
      )
      for (const provider of loaded.config.providers) {
        if (
          provider.api_key_ref &&
          !trusted.some(
            before =>
              before.id === provider.id &&
              before.api_key_ref === provider.api_key_ref &&
              sameCredentialTarget(before, provider)
          )
        )
          throw new Error('Enter the API key again to authorize this file and endpoint')
      }
      // Native file selection explicitly replaces a blocked publication. Its protected
      // snapshot remains in MODEL_FILES; the externally edited file is never overwritten.
      // Selection resolves automatic legacy import in the same protected commit.
      // Keep its exact source privately available for recovery instead of deleting it.
      await this.accept(
        loaded,
        { [LEGACY_RESOLUTION]: 'file-selected' },
        loaded.source,
        pending ?? undefined
      )
      return this.publicSnapshot(this.lastGood!)
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
      const newSecretValues: Record<string, string> = {}
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
        if (
          before &&
          (before.api_key || before.api_key_ref) &&
          !provider.api_key &&
          !sameCredentialTarget(before, provider)
        ) {
          throw new Error('Enter the API key again to authorize a changed endpoint or path')
        }
        if (provider.api_key_ref && provider.api_key_ref !== before?.api_key_ref)
          throw new Error('A credential reference cannot be imported from another provider')
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
          newSecretValues[ref] = provider.api_key
          delete provider.api_key
          provider.api_key_ref = ref
        }
      }
      const { document } = parseModelConfiguration(current.source)
      patchProviders(document, config.providers)
      const source = document.toString({ lineWidth: 100 })
      parseModelConfiguration(source)
      // Recheck the file before committing its protected publication.
      const latest = await this.load(
        path,
        path === join(this.directory, 'model.yml') && !this.lastGood?.config.providers.length
      )
      if (latest.revision !== expectedRevision)
        throw new Error(
          'model.yml changed externally. Reload before saving; no changes were overwritten.'
        )
      const loaded = { path, source, revision: digest(path, source), config }
      await this.accept(loaded, newSecretValues, current.source)
      return this.publicSnapshot(this.lastGood!)
    })
  }

  /** Resolve usable providers independently; unavailable credentials must not disable other connections. */
  async runtime(draft?: unknown): Promise<{ revision: string; models: ResolvedProviderModel[] }> {
    return this.serial(async () => {
      let providers = this.lastGood?.config.providers ?? []
      if (draft !== undefined) {
        const provider = validateModelConfiguration({ version: 1, providers: [draft] }).providers[0]
        const saved = providers.find(entry => entry.id === provider.id)
        if (saved && !provider.api_key && !sameCredentialTarget(saved, provider))
          throw new Error('Enter the API key again to authorize a changed endpoint or path')
        // Drafts may reuse only the credential owned by their saved provider.
        delete provider.api_key_ref
        if (!provider.api_key && saved) {
          provider.api_key = saved.api_key
          provider.api_key_ref = saved.api_key_ref
        }
        providers = [provider]
      }
      const models: ResolvedProviderModel[] = []
      for (const provider of providers) {
        const { models: entries, ...connection } = provider
        const key = await this.credential(provider)
        // Do not expose an authenticated connection as an unauthenticated runtime model.
        // Keep its public settings row editable so the user can supply a replacement key.
        if (connection.api_key_ref && !key) continue
        for (const model of entries)
          models.push({ provider: { ...connection, ...(key ? { api_key: key } : {}) }, model })
      }
      return { revision: this.lastGood?.revision ?? '', models }
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
      if (
        saved &&
        !provider.api_key &&
        !['base_url', 'models_path', 'models_api_key_header'].every(
          key =>
            (saved as unknown as Record<string, unknown>)[key] ===
            (provider as unknown as Record<string, unknown>)[key]
        )
      )
        throw new Error('Enter the API key again to authorize a changed endpoint or path')
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

/** A saved key is authorized for its endpoint, protocol and API paths only. */
function sameCredentialTarget(
  left: ModelProvider,
  right: Record<string, unknown> | ModelProvider
): boolean {
  const sameConnection = [
    'base_url',
    'api_format',
    'request_path',
    'models_path',
    'models_api_key_header',
  ].every(
    key =>
      (left as unknown as Record<string, unknown>)[key] ===
      (right as unknown as Record<string, unknown>)[key]
  )
  if (!sameConnection) return false
  const before = new Map(left.models.map(model => [model.id, model]))
  return ((right.models as ModelProvider['models']) ?? []).every(model => {
    const previous = before.get(model.id)
    return previous
      ? previous.request_path === model.request_path && previous.api_format === model.api_format
      : model.request_path === undefined && model.api_format === undefined
  })
}
