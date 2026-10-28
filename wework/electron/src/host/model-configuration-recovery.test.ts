import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { CredentialMirrorMigration } from './credential-mirror-migration.js'
import { ModelConfigurationStore } from './model-configuration-store.js'
import { MODEL_LAST_GOOD } from './model-configuration-transaction.js'
import type { ModelSecrets } from './model-configuration-transaction.js'

let directory: string
let values: Record<string, string>
let store: ModelConfigurationStore
let beforeUpdate: ((next: Record<string, string>) => void) | null
let afterUpdate: (() => void) | null
let unavailable: boolean
const secrets: ModelSecrets = {
  get: async key => {
    if (unavailable) throw new Error('vault unavailable')
    return values[key] ?? null
  },
  set: async (key, value) => {
    values[key] = value
  },
  delete: async key => {
    delete values[key]
  },
  update: async change => {
    if (unavailable) throw new Error('vault unavailable')
    beforeUpdate?.(values)
    const next = { ...values }
    change(next)
    values = next
    afterUpdate?.()
  },
}
const legacy = JSON.stringify([
  {
    id: 'same',
    modelId: 'old-model',
    baseUrl: 'https://old.example/v1',
    apiKey: 'old-canary',
    visionModelConfigId: 'vision',
    catalogEntry: { slug: 'catalog-same' },
  },
  {
    id: 'vision',
    modelId: 'vision-model',
    baseUrl: 'https://vision.example/v1',
    apiKey: 'vision-canary',
  },
])
const provider = {
  id: 'existing',
  name: 'Existing',
  base_url: 'https://existing.example/v1',
  api_format: 'openai-responses',
  api_key: 'current-canary',
  models: [{ id: 'same', model_id: 'current-model', catalog_entry: { slug: 'catalog-same' } }],
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'wework-recovery-'))
  values = {}
  beforeUpdate = null
  afterUpdate = null
  unavailable = false
  store = new ModelConfigurationStore(directory, secrets)
  const empty = await store.read()
  await store.save(empty.revision, [provider])
  await new CredentialMirrorMigration(secrets).archive('legacy-model-settings', legacy)
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

const candidate = async (kind: string) => {
  const snapshot = await store.recovery()
  return { ...snapshot, selected: snapshot.candidates.find(item => item.kind === kind)! }
}
const restore = async (kind = 'legacy-models') => {
  const recovery = await candidate(kind)
  const current = await store.read().catch(() => null)
  return store.restoreRecovery(recovery.selected.id, recovery.revision, current?.revision ?? '')
}

test('conflicting keys restore as independent connections with original targets, vision links and catalogs', async () => {
  const original = await store.read()
  const recovery = await candidate('legacy-models')
  expect(recovery.selected).toBeDefined()
  expect(JSON.stringify(recovery)).not.toMatch(
    /old-canary|vision-canary|current-canary|api_key_ref|base64/
  )
  const restored = await store.restoreRecovery(
    recovery.selected.id,
    recovery.revision,
    original.revision
  )
  expect(restored.providers).toHaveLength(3)
  expect(restored.providers[0]).toEqual(original.providers[0])
  const runtime = (await store.runtime()).models
  const old = runtime.find(entry => entry.model.model_id === 'old-model')!
  const vision = runtime.find(entry => entry.model.model_id === 'vision-model')!
  expect(old.provider.api_key).toBe('old-canary')
  expect(old.provider.base_url).toBe('https://old.example/v1')
  expect(vision.provider.api_key).toBe('vision-canary')
  expect(old.model.id).not.toBe('same')
  expect(old.model.vision_model_config_id).toBe(vision.model.id)
  expect(old.model.catalog_entry?.slug).toBe(old.model.id)
  expect(JSON.stringify(restored)).not.toMatch(/old-canary|vision-canary|current-canary/)
  expect(await readFile(restored.path, 'utf8')).not.toMatch(
    /old-canary|vision-canary|current-canary/
  )
  expect(
    Object.values(values).some(value => value.includes(Buffer.from(legacy).toString('base64')))
  ).toBe(true)
  expect((await new ModelConfigurationStore(directory, secrets).read()).providers).toEqual(
    restored.providers
  )
  await expect(
    store.restoreRecovery(recovery.selected.id, recovery.revision, original.revision)
  ).rejects.toThrow(/changed|already restored/)
  expect((await store.read()).providers).toHaveLength(3)
  expect((await store.recovery()).candidates.some(item => item.kind === 'legacy-models')).toBe(
    false
  )
})

test.each(['missing', 'damaged'])(
  'a %s file restores to a new file without overwriting original bytes',
  async mode => {
    const initial = await store.read()
    if (mode === 'missing') await rm(initial.path)
    else await writeFile(initial.path, 'bad: [private-damaged-canary')
    expect((await store.read()).error).toBeTruthy()
    const recovered = await restore('saved-configuration')
    expect(recovered.path).not.toBe(initial.path)
    expect(recovered.error).toBeUndefined()
    if (mode === 'damaged')
      expect(await readFile(initial.path, 'utf8')).toBe('bad: [private-damaged-canary')
    else await expect(readFile(initial.path)).rejects.toMatchObject({ code: 'ENOENT' })
    const restarted = new ModelConfigurationStore(directory, secrets)
    expect((await restarted.read()).path).toBe(recovered.path)
    expect((await restarted.runtime()).models[0].provider.api_key).toBe('current-canary')
  }
)

test('pending publication conflict allows startup recovery and preserves externally edited files', async () => {
  const initial = await store.read()
  let injected = false
  beforeUpdate = () => {
    if (!injected && values['wework-models.pending']) {
      injected = true
      throw new Error('interrupt publication')
    }
  }
  await expect(restore()).rejects.toThrow('interrupt publication')
  beforeUpdate = null
  expect(values['wework-models.pending']).toBeTruthy()
  await writeFile(initial.path, 'external: [do-not-overwrite')
  store = new ModelConfigurationStore(directory, secrets)
  await expect(store.initialize()).resolves.toBeUndefined()
  await expect(store.read()).rejects.toThrow(/changed during publication/)
  const recovered = await restore('saved-configuration')
  expect(recovered.path).not.toBe(initial.path)
  expect(await readFile(initial.path, 'utf8')).toBe('external: [do-not-overwrite')
  expect((await store.runtime()).models.map(entry => entry.provider.api_key).sort()).toEqual([
    'current-canary',
    'old-canary',
    'vision-canary',
  ])
  expect(values['wework-models.pending']).toBeUndefined()
})

test.each(['source', 'credential', 'anchor'])(
  'a concurrent protected %s change is rejected inside the commit',
  async kind => {
    const recovery = await candidate('legacy-models')
    const current = await store.read()
    let updates = 0
    beforeUpdate = state => {
      // The first transaction reads recovery state; mutate only at the following commit.
      if (++updates !== 2) return
      if (kind === 'source') state['wework-mirrors.recovery.changed'] = 'changed'
      if (kind === 'credential') state['wework-model-key.other'] = 'new-secret'
      if (kind === 'anchor')
        state[MODEL_LAST_GOOD] = JSON.stringify({ path: current.path, source: 'changed' })
    }
    await expect(
      store.restoreRecovery(recovery.selected.id, recovery.revision, current.revision)
    ).rejects.toThrow(/changed/)
    beforeUpdate = null
    expect(values['wework-models.pending']).toBeUndefined()
    expect(await readFile(current.path, 'utf8')).not.toContain('recovered-')
  }
)

test('two store instances cannot both restore one archive', async () => {
  const recovery = await candidate('legacy-models')
  const current = await store.read()
  const second = new ModelConfigurationStore(directory, secrets)
  const results = await Promise.allSettled(
    [store, second].map(instance =>
      instance.restoreRecovery(recovery.selected.id, recovery.revision, current.revision)
    )
  )
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  expect((await new ModelConfigurationStore(directory, secrets).read()).providers).toHaveLength(3)
})

test('failed publication retains the recovery receipt and keys, then resumes without duplicate import', async () => {
  let fail = true
  beforeUpdate = () => {
    if (fail && values['wework-models.pending']) {
      fail = false
      throw new Error('simulated failure after file publication')
    }
  }
  await expect(restore()).rejects.toThrow('simulated failure')
  beforeUpdate = null
  expect(values['wework-models.pending']).toBeTruthy()
  store = new ModelConfigurationStore(directory, secrets)
  expect((await store.read()).providers).toHaveLength(3)
  expect((await store.runtime()).models.map(entry => entry.provider.api_key).sort()).toEqual([
    'current-canary',
    'old-canary',
    'vision-canary',
  ])
  expect(
    (await store.recovery()).candidates.filter(item => item.kind === 'legacy-models')
  ).toHaveLength(0)
})

test('an external edit rejects legacy restore without overwriting the file or consuming the archive', async () => {
  const recovery = await candidate('legacy-models')
  const current = await store.read()
  const original = await readFile(current.path, 'utf8')
  await writeFile(current.path, `${original}\n# external edit\n`)
  await expect(
    store.restoreRecovery(recovery.selected.id, recovery.revision, current.revision)
  ).rejects.toThrow(/changed/)
  expect(await readFile(current.path, 'utf8')).toBe(`${original}\n# external edit\n`)
  expect(
    (await store.recovery()).candidates.filter(item => item.kind === 'legacy-models')
  ).toHaveLength(1)
})

test('missing saved keys cannot be reported as successful recovery', async () => {
  const initial = await store.read()
  delete values[initial.providers[0].api_key_ref!]
  const recovery = await candidate('saved-configuration')
  await expect(
    store.restoreRecovery(recovery.selected.id, recovery.revision, initial.revision)
  ).rejects.toThrow(/API key is unavailable/)
  expect((await readdir(directory)).some(file => file.startsWith('recovered-'))).toBe(false)
  expect(values['wework-models.pending']).toBeUndefined()
})

test('vault failure never clears recovery data and restart failures remain visible', async () => {
  const original = JSON.stringify(values)
  unavailable = true
  await expect(store.recovery()).rejects.toThrow('vault unavailable')
  await expect(new ModelConfigurationStore(directory, secrets).initialize()).rejects.toThrow(
    'vault unavailable'
  )
  expect(JSON.stringify(values)).toBe(original)
  unavailable = false
  expect((await restore()).providers).toHaveLength(3)
})

test('malformed archives are isolated and secret excerpts never enter recovery metadata', async () => {
  values['wework-mirrors.recovery.invalid-json'] = '{"secret":"private-canary"'
  await new CredentialMirrorMigration(secrets).archive(
    'legacy-model-settings',
    '[{"apiKey":"broken-canary"'
  )
  values['wework-models.legacy'] = '[{"apiKey":"other-broken-canary"'
  const recovery = await candidate('legacy-models')
  expect(recovery.unreadableArchives).toBe(3)
  expect(recovery.selected).toBeDefined()
  expect(JSON.stringify(recovery)).not.toMatch(/private-canary|broken-canary/)
  const saved = await candidate('saved-configuration')
  await store.restoreRecovery(saved.selected.id, saved.revision, '')
  expect((await store.read()).error).toBeUndefined()
  expect(values['wework-models.legacy']).toContain('other-broken-canary')
})

test('forged candidates and revisions do not create files or write vault values', async () => {
  const recovery = await candidate('legacy-models')
  const current = await store.read()
  const original = JSON.stringify(values)
  await expect(
    store.restoreRecovery('forged', recovery.revision, current.revision)
  ).rejects.toThrow(/unavailable/)
  await expect(
    store.restoreRecovery(recovery.selected.id, 'stale', current.revision)
  ).rejects.toThrow(/changed/)
  expect(JSON.stringify(values)).toBe(original)
})

const recoveryFaultCases = ['legacy-models', 'saved-configuration'].flatMap(kind =>
  [1, 2, 3].flatMap(transaction => ['before', 'after'].map(stage => ({ kind, transaction, stage })))
)
test.each(recoveryFaultCases)(
  'recovery resumes after $stage transaction $transaction for $kind',
  async ({ kind, transaction, stage }) => {
    const current = await store.read()
    if (kind === 'saved-configuration') {
      await writeFile(current.path, 'bad: [original-kept')
      await store.read()
    }
    const recovery = await candidate(kind)
    let count = 0
    let fired = false
    beforeUpdate = () => {
      count++
      if (stage === 'before' && count === transaction) {
        fired = true
        throw new Error('injected transaction fault')
      }
    }
    afterUpdate = () => {
      if (stage === 'after' && count === transaction) {
        fired = true
        throw new Error('injected transaction fault')
      }
    }
    await expect(
      store.restoreRecovery(recovery.selected.id, recovery.revision, current.revision)
    ).rejects.toThrow('injected transaction fault')
    expect(fired).toBe(true)
    beforeUpdate = null
    afterUpdate = null
    store = new ModelConfigurationStore(directory, secrets)
    let snapshot = await store.read()
    if (
      (kind === 'legacy-models' && snapshot.providers.length === 1) ||
      (kind === 'saved-configuration' && snapshot.error)
    ) {
      const refreshed = await candidate(kind)
      snapshot = await store.restoreRecovery(
        refreshed.selected.id,
        refreshed.revision,
        snapshot.revision
      )
    }
    expect(snapshot.error).toBeUndefined()
    expect(snapshot.providers).toHaveLength(kind === 'legacy-models' ? 3 : 1)
    const keys = (await store.runtime()).models.map(entry => entry.provider.api_key).sort()
    expect(keys).toEqual(
      kind === 'legacy-models'
        ? ['current-canary', 'old-canary', 'vision-canary']
        : ['current-canary']
    )
    expect(values['wework-models.pending']).toBeUndefined()
    if (kind === 'saved-configuration')
      expect(await readFile(current.path, 'utf8')).toBe('bad: [original-kept')
    expect((await new ModelConfigurationStore(directory, secrets).read()).providers).toEqual(
      snapshot.providers
    )
  }
)

test('future renderer archives and invalid UTF-8 remain private instead of being interpreted as historical models', async () => {
  await new CredentialMirrorMigration(secrets).archive(
    'renderer-local-storage.json.corrupt-1',
    JSON.stringify({
      version: 999,
      entries: { 'wework.localModelSettings.v1': legacy.replace('old-canary', 'future-canary') },
    })
  )
  await new CredentialMirrorMigration(secrets).archive('legacy-model-settings', Buffer.from([0xff]))
  const recovery = await store.recovery()
  expect(recovery.unreadableArchives).toBe(2)
  expect(recovery.candidates.filter(item => item.kind === 'legacy-models')).toHaveLength(1)
  expect(JSON.stringify(recovery)).not.toContain('future-canary')
})

test('an incomplete archived vision graph cannot borrow a current connection when restoring', async () => {
  const models = JSON.parse(legacy)
  models[0].visionModelConfigId = 'external-model'
  models[0].displayName = 'Missing vision fixture'
  await new CredentialMirrorMigration(secrets).archive(
    'legacy-model-settings',
    JSON.stringify(models)
  )
  const recovery = await store.recovery()
  const before = JSON.stringify(values)
  const original = await store.read()
  const selected = recovery.candidates.find(item =>
    item.providers.some(provider => provider.models.includes('Missing vision fixture'))
  )!
  await expect(
    store.restoreRecovery(selected.id, recovery.revision, original.revision)
  ).rejects.toThrow(/vision connection/)
  expect(JSON.stringify(values)).toBe(before)
  expect((await store.read()).providers).toHaveLength(1)
})

test('a valid historical renderer archive is restored with its exact original key', async () => {
  values = Object.fromEntries(
    Object.entries(values).filter(([key]) => !key.startsWith('wework-mirrors.recovery.'))
  )
  await new CredentialMirrorMigration(secrets).archive(
    'renderer-local-storage.json.corrupt-2',
    JSON.stringify({ version: 1, entries: { 'wework.localModelSettings.v1': legacy } })
  )
  const recovered = await restore()
  expect(recovered.providers).toHaveLength(3)
  expect(
    (await store.runtime()).models.find(entry => entry.model.model_id === 'old-model')?.provider
      .api_key
  ).toBe('old-canary')
})
