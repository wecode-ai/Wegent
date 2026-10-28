import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ModelConfigurationStore } from './model-configuration-store.js'
import {
  parseModelConfiguration,
  validateModelConfiguration,
} from './model-configuration-schema.js'

const YAML = `# user comment\nversion: 1\nproviders:\n  - id: relay\n    name: My relay\n    base_url: https://relay.example/v1\n    api_format: openai-responses\n    api_key: secret-not-for-output\n    models:\n      - id: first\n        model_id: upstream-a # retain model comment\n      - id: second\n        model_id: upstream-b\n`
let directory: string
let values: Map<string, string>
const secrets = {
  get: async (key: string) => values.get(key) ?? null,
  set: async (key: string, value: string) => {
    values.set(key, value)
  },
  delete: async (key: string) => {
    values.delete(key)
  },
  update: async (change: (values: Record<string, string>) => void) => {
    const next = Object.fromEntries(values)
    change(next)
    values = new Map(Object.entries(next))
  },
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'wework-models-'))
  values = new Map()
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(directory, { recursive: true, force: true })
})

describe('Provider YAML schema', () => {
  test('validates and retains output budgets', () => {
    const config = parseModelConfiguration(YAML).config
    const model = config.providers[0].models[0]
    model.context_window = 128000
    model.max_output_tokens = 16000
    expect(validateModelConfiguration(config).providers[0].models[0].max_output_tokens).toBe(16000)
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 128000, 128001]) {
      model.max_output_tokens = value
      expect(() => validateModelConfiguration(config)).toThrow(/max_output_tokens/)
    }
  })
  test('accepts shared connections and per-model protocol overrides', () => {
    const config = parseModelConfiguration(YAML).config
    config.providers[0].models[1].api_format = 'anthropic-messages'
    expect(validateModelConfiguration(config).providers[0].models).toHaveLength(2)
  })
  test('rejects unknown fields, duplicate IDs, incompatible tools and unsafe URLs', () => {
    for (const source of [
      YAML.replace('base_url:', 'base_urll:'),
      YAML.replace('id: second', 'id: first'),
      YAML.replace('openai-responses', 'made-up-protocol'),
      YAML.replace('https://relay.example/v1', 'https://user:password@relay.example/v1'),
      YAML.replace(
        'model_id: upstream-b',
        'model_id: upstream-b\n        api_format: anthropic-messages\n        tool_profile: custom'
      ),
    ])
      expect(() => parseModelConfiguration(source)).toThrow()
  })
  test('does not include a secret or YAML source excerpt in syntax errors', () => {
    expect(() => parseModelConfiguration(YAML + 'bad: [secret-not-for-output')).toThrow(/line/)
    try {
      parseModelConfiguration(YAML + 'bad: [secret-not-for-output')
    } catch (error) {
      expect(String(error)).not.toContain('secret-not-for-output')
    }
  })
})

describe('Provider configuration file store', () => {
  test('independent store instances cannot overwrite a concurrent protected revision', async () => {
    const first = new ModelConfigurationStore(directory, secrets)
    const second = new ModelConfigurationStore(directory, secrets)
    const initial = await first.read()
    await second.read()
    const result = await Promise.allSettled([
      first.save(initial.revision, parseModelConfiguration(YAML).config.providers),
      second.save(
        initial.revision,
        parseModelConfiguration(YAML.replace('secret-not-for-output', 'other-key')).config.providers
      ),
    ])
    expect(result.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect(result.filter(value => value.status === 'rejected')).toHaveLength(1)
    const recovered = new ModelConfigurationStore(directory, secrets)
    expect((await recovered.read()).error).toBeUndefined()
    expect(['secret-not-for-output', 'other-key']).toContain(
      (await recovered.runtime()).models[0].provider.api_key
    )
    expect(values.has('wework-models.pending')).toBe(false)
  })

  test('legacy migration is native, idempotent, and never publishes a malformed aggregate', async () => {
    const legacy = JSON.stringify([
      {
        id: 'legacy-a',
        modelId: 'a',
        baseUrl: 'https://legacy.example/v1',
        apiKey: 'legacy-canary',
      },
      {
        id: 'legacy-b',
        modelId: 'b',
        baseUrl: 'https://legacy.example/v1',
        apiKey: 'legacy-canary',
      },
    ])
    values.set('wework-models.legacy', legacy)
    const store = new ModelConfigurationStore(directory, secrets)
    const migrated = await store.read()
    expect(migrated.providers).toHaveLength(1)
    expect(migrated.providers[0].models.map(model => model.id)).toEqual(['legacy-a', 'legacy-b'])
    expect(JSON.stringify(migrated)).not.toContain('legacy-canary')
    expect(await readFile(migrated.path, 'utf8')).not.toContain('legacy-canary')
    expect(values.has('wework-models.legacy')).toBe(false)
    values.set('wework-models.legacy', legacy)
    expect((await new ModelConfigurationStore(directory, secrets).read()).providers).toHaveLength(1)
    const duplicate = JSON.stringify([
      { id: 'duplicate', modelId: 'a', baseUrl: 'https://legacy.example' },
      { id: 'duplicate', modelId: 'b', baseUrl: 'https://legacy.example' },
    ])
    values.set('wework-models.legacy', duplicate)
    expect((await store.read()).error).toBeTruthy()
    expect(values.get('wework-models.legacy')).toBe(duplicate)
    expect(values.has('wework-models.pending')).toBe(false)
  })

  test('explicit file selection resolves malformed legacy import while preserving its protected source', async () => {
    const source = '[{"apiKey":"protected-legacy-canary"'
    values.set('wework-models.legacy', source)
    const store = new ModelConfigurationStore(directory, secrets)
    expect((await store.read()).error).toBeTruthy()
    const selected = join(directory, 'selected.yml')
    await writeFile(selected, YAML)
    const bound = await store.bind(selected)
    expect(bound.error).toBeUndefined()
    const restarted = new ModelConfigurationStore(directory, secrets)
    const restored = await restarted.read()
    expect(restored.error).toBeUndefined()
    expect(restored.providers[0].id).toBe('relay')
    await expect(restarted.save(restored.revision, restored.providers)).resolves.toMatchObject({
      path: await realpath(selected),
    })
    expect(values.get('wework-models.legacy')).toBe(source)
    expect(await readFile(selected, 'utf8')).not.toContain('protected-legacy-canary')
  })

  test.each(['before-intent', 'after-intent', 'before-cleanup', 'after-cleanup'])(
    'publication recovers a consistent file and secret after %s failure',
    async failure => {
      const original = new ModelConfigurationStore(directory, secrets)
      const empty = await original.read()
      const saved = await original.save(
        empty.revision,
        parseModelConfiguration(YAML).config.providers
      )
      let calls = 0
      const faulty = new ModelConfigurationStore(directory, {
        ...secrets,
        update: async change => {
          calls++
          const fail = calls === (failure.endsWith('intent') ? 1 : 2)
          if (fail && failure.startsWith('before')) throw new Error('injected publication failure')
          await secrets.update(change)
          if (fail && failure.startsWith('after')) throw new Error('injected publication failure')
        },
      })
      // Reading an unchanged committed file performs no protected mutation.
      const before = await faulty.read()
      calls = 0
      await expect(
        faulty.save(before.revision, [{ ...saved.providers[0], api_key: 'rotated-key' }])
      ).rejects.toThrow('injected publication failure')
      const restarted = new ModelConfigurationStore(directory, secrets)
      const current = await restarted.read()
      expect(current.error).toBeUndefined()
      const key = values.get(current.providers[0].api_key_ref!)
      expect(['rotated-key', 'secret-not-for-output']).toContain(key)
      expect((await restarted.runtime()).models[0].provider.api_key).toBe(key)
      expect(values.has('wework-models.pending')).toBe(false)
    }
  )
  test('external endpoint changes, removed credentials and restored legacy files cannot redirect existing models', async () => {
    const store = new ModelConfigurationStore(directory, secrets)
    const empty = await store.read()
    const saved = await store.save(empty.revision, parseModelConfiguration(YAML).config.providers)
    const source = await readFile(saved.path, 'utf8')
    for (const tampered of [
      source.replace('https://relay.example/v1', 'https://attacker.example/v1'),
      source
        .replace(/\s+api_key_ref:.*\n/, '\n')
        .replace('https://relay.example/v1', 'https://attacker.example/v1'),
      YAML,
    ]) {
      await writeFile(saved.path, tampered)
      expect((await store.read()).error).toBeTruthy()
      expect((await store.runtime()).models[0].provider.base_url).toBe('https://relay.example/v1')
    }
    const other = join(directory, 'untrusted.yml')
    await writeFile(
      other,
      source.replace('https://relay.example/v1', 'https://attacker.example/v1')
    )
    await expect(store.bind(other)).rejects.toThrow(/authorize this file/)
    expect(await readFile(other, 'utf8')).toContain('https://attacker.example')
  })
  test('resolves draft credentials from its saved provider without persisting changes', async () => {
    const store = new ModelConfigurationStore(directory, secrets)
    const empty = await store.read()
    const snapshot = await store.save(
      empty.revision,
      parseModelConfiguration(YAML).config.providers
    )
    const original = await readFile(join(directory, 'model.yml'), 'utf8')
    const { api_key_configured, ...draft } = snapshot.providers[0]
    expect(api_key_configured).toBe(true)
    draft.base_url = 'https://draft.example/v1'
    draft.api_key_ref = 'wework-model-key.untrusted-ref'
    await expect(store.runtime(draft)).rejects.toThrow(/authorize a changed endpoint/)
    draft.base_url = snapshot.providers[0].base_url
    expect((await store.runtime(draft)).models[0].provider.api_key).toBe('secret-not-for-output')
    delete draft.api_key_ref
    expect(
      (await store.runtime({ ...draft, api_key: 'replacement' })).models[0].provider.api_key
    ).toBe('replacement')
    expect(await readFile(join(directory, 'model.yml'), 'utf8')).toBe(original)
    expect((await store.runtime()).models[0].provider.base_url).toBe('https://relay.example/v1')
  })
  test('creates a fresh configuration and shares one credential across models', async () => {
    const store = new ModelConfigurationStore(directory, secrets)
    const empty = await store.read()
    expect(empty.providers).toEqual([])
    expect((await store.read()).error).toBeUndefined()
    expect((await new ModelConfigurationStore(directory, secrets).read()).error).toBeUndefined()
    const config = parseModelConfiguration(YAML).config
    const snapshot = await store.save(empty.revision, config.providers)
    expect(JSON.stringify(snapshot)).not.toContain('secret-not-for-output')
    const source = await readFile(join(directory, 'model.yml'), 'utf8')
    expect(source).toContain('api_key_ref:')
    expect(source).not.toContain('secret-not-for-output')
    const runtime = await store.runtime()
    expect(runtime.models.map(entry => entry.provider.api_key)).toEqual([
      'secret-not-for-output',
      'secret-not-for-output',
    ])
    expect(runtime.models.map(entry => entry.model.id)).toEqual(['first', 'second'])
  })
  test('page changes preserve model IDs, comments, capabilities and an unchanged key', async () => {
    await writeFile(join(directory, 'model.yml'), YAML)
    const store = new ModelConfigurationStore(directory, secrets)
    const snapshot = await store.read()
    snapshot.providers[0].name = 'Renamed'
    snapshot.providers[0].models[0].catalog_entry = {
      slug: 'existing-slug',
      supports_parallel_tool_calls: true,
    }
    await store.save(snapshot.revision, snapshot.providers)
    const source = await readFile(join(directory, 'model.yml'), 'utf8')
    expect(source).toContain('# user comment')
    expect(source).toContain('# retain model comment')
    expect(source).toContain('existing-slug')
    expect((await store.runtime()).models[0].provider.api_key).toBe('secret-not-for-output')
    expect((await store.runtime()).models[0].model.id).toBe('first')
  })
  test('rejects stale page saves after an external edit without overwriting the file', async () => {
    await writeFile(join(directory, 'model.yml'), YAML)
    const store = new ModelConfigurationStore(directory, secrets)
    const snapshot = await store.read()
    const changed = (await readFile(snapshot.path, 'utf8')).replace('My relay', 'External rename')
    await writeFile(join(directory, 'model.yml'), changed)
    await expect(store.save(snapshot.revision, snapshot.providers)).rejects.toThrow(
      /changed externally/
    )
    expect(await readFile(join(directory, 'model.yml'), 'utf8')).toBe(changed)
    expect((await store.read()).providers[0].name).toBe('External rename')
  })
  test('serializes concurrent page saves; exactly one writer wins', async () => {
    const store = new ModelConfigurationStore(directory, secrets)
    const snapshot = await store.read()
    const results = await Promise.allSettled([
      store.save(snapshot.revision, parseModelConfiguration(YAML).config.providers),
      store.save(snapshot.revision, parseModelConfiguration(YAML).config.providers),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  })
  test('malformed files retain the last valid configuration, including after restart', async () => {
    await writeFile(join(directory, 'model.yml'), YAML)
    const store = new ModelConfigurationStore(directory, secrets)
    await store.read()
    await writeFile(join(directory, 'model.yml'), 'version: [')
    expect((await store.read()).error).toBeTruthy()
    expect((await store.runtime()).models).toHaveLength(2)
    const restarted = new ModelConfigurationStore(directory, secrets)
    const snapshot = await restarted.read()
    expect(snapshot.error).toBeTruthy()
    expect(snapshot.providers).toHaveLength(1)
    expect((await restarted.runtime()).models).toHaveLength(2)
    await expect(restarted.save(snapshot.revision, [])).rejects.toThrow(/Fix and reload/)
  })
  test('missing files retain the saved configuration after restart', async () => {
    const store = new ModelConfigurationStore(directory, secrets)
    const snapshot = await store.read()
    await store.save(snapshot.revision, parseModelConfiguration(YAML).config.providers)
    await rm(join(directory, 'model.yml'))
    const restarted = new ModelConfigurationStore(directory, secrets)
    expect((await restarted.read()).error).toBeTruthy()
    expect((await restarted.runtime()).models).toHaveLength(2)
  })
  test('rotating a provider key updates all models and never changes their IDs', async () => {
    const store = new ModelConfigurationStore(directory, secrets)
    const empty = await store.read()
    const snapshot = await store.save(
      empty.revision,
      parseModelConfiguration(YAML).config.providers
    )
    await store.save(
      snapshot.revision,
      snapshot.providers.map(provider => ({ ...provider, api_key: 'rotated-key' }))
    )
    const runtime = await store.runtime()
    expect(runtime.models.map(entry => entry.provider.api_key)).toEqual([
      'rotated-key',
      'rotated-key',
    ])
    expect(runtime.models.map(entry => entry.model.id)).toEqual(['first', 'second'])
  })
  test('a different binding invalidates a page revision even for identical file contents', async () => {
    await writeFile(join(directory, 'model.yml'), YAML)
    const store = new ModelConfigurationStore(directory, secrets)
    const before = await store.read()
    const other = join(directory, 'other.yml')
    await writeFile(other, YAML)
    const after = await store.bind(other)
    expect(after.revision).not.toBe(before.revision)
    await expect(store.save(before.revision, before.providers)).rejects.toThrow(
      /changed externally/
    )
    expect(await readFile(other, 'utf8')).not.toContain('secret-not-for-output')
  })
  test('binding rejects an invalid file and preserves the previous binding', async () => {
    const store = new ModelConfigurationStore(directory, secrets)
    const before = await store.read()
    const invalid = join(directory, 'invalid.yml')
    await writeFile(invalid, 'version: [')
    await expect(store.bind(invalid)).rejects.toThrow()
    expect((await store.read()).path).toBe(before.path)
  })
})

describe('Provider credential recovery and retirement', () => {
  test.each(['missing', 'unreadable'] as const)(
    'a %s key only excludes that provider and can be repaired after restart',
    async failure => {
      const original = new ModelConfigurationStore(directory, secrets)
      const initial = await original.read()
      const [relay] = parseModelConfiguration(YAML).config.providers
      const saved = await original.save(initial.revision, [
        relay,
        { ...relay, id: 'healthy', models: [{ id: 'healthy-model', model_id: 'healthy' }] },
        {
          ...relay,
          id: 'local',
          api_key: undefined,
          models: [{ id: 'local-model', model_id: 'local' }],
        },
      ])
      const brokenRef = saved.providers[0].api_key_ref!
      const damagedSecrets = {
        ...secrets,
        get: async (key: string) => {
          if (key === brokenRef) {
            if (failure === 'unreadable') throw new Error('sensitive storage details')
            return null
          }
          return secrets.get(key)
        },
      }
      const restarted = new ModelConfigurationStore(directory, damagedSecrets)
      const snapshot = await restarted.read()
      expect(snapshot.error).toBeUndefined()
      expect(snapshot.providers).toHaveLength(3)
      expect(snapshot.providers[0].api_key_configured).toBe(false)
      expect(snapshot.providers[1].api_key_configured).toBe(true)
      expect(JSON.stringify(snapshot)).not.toContain('sensitive storage details')
      expect((await restarted.runtime()).models.map(entry => entry.model.id)).toEqual([
        'healthy-model',
        'local-model',
      ])
      const request = vi.fn().mockResolvedValue(new Response('{"data":[]}'))
      vi.stubGlobal('fetch', request)
      await expect(restarted.discover('relay')).rejects.toThrow(/saved API key/)
      expect(request).not.toHaveBeenCalled()
      await restarted.save(
        snapshot.revision,
        snapshot.providers.map(provider =>
          provider.id === 'relay' ? { ...provider, api_key: 'replacement-key' } : provider
        )
      )
      const runtime = await restarted.runtime()
      expect(runtime.models.map(entry => entry.model.id)).toEqual([
        'first',
        'second',
        'healthy-model',
        'local-model',
      ])
      expect(runtime.models[0].provider.api_key).toBe('replacement-key')
    }
  )

  test('rotation and deletion retire only references no remaining provider uses', async () => {
    const store = new ModelConfigurationStore(directory, secrets)
    const empty = await store.read()
    let saved = await store.save(empty.revision, parseModelConfiguration(YAML).config.providers)
    const oldRef = saved.providers[0].api_key_ref!
    await expect(
      store.save(saved.revision, [
        ...saved.providers,
        { ...saved.providers[0], id: 'shared', models: [] },
      ])
    ).rejects.toThrow(/another provider/)
    expect(await secrets.get(oldRef)).toBe('secret-not-for-output')
    saved = await store.save(saved.revision, [{ ...saved.providers[0], api_key: 'new-key' }])
    const newRef = saved.providers[0].api_key_ref!
    expect(await secrets.get(oldRef)).toBeNull()
    expect(await secrets.get(newRef)).toBe('new-key')
    expect(values.get('wework-models.last-good')).not.toContain(oldRef)
    await store.save(saved.revision, [])
    expect(await secrets.get(newRef)).toBeNull()
    expect((await store.runtime()).models).toEqual([])
  })

  test('a publication conflict retains both snapshots and native file selection recovers without overwriting edits', async () => {
    const store = new ModelConfigurationStore(directory, secrets)
    const empty = await store.read()
    const saved = await store.save(empty.revision, parseModelConfiguration(YAML).config.providers)
    const originalSource = await readFile(saved.path, 'utf8')
    const racingSecrets = {
      ...secrets,
      update: async (change: (values: Record<string, string>) => void) => {
        await writeFile(saved.path, `${originalSource}# external edit\n`)
        await secrets.update(change)
      },
    }
    const racing = new ModelConfigurationStore(directory, racingSecrets)
    const before = await racing.read()
    const previousKeys = [...values.keys()].filter(key => key.startsWith('wework-model-key.'))
    await expect(
      racing.save(before.revision, [{ ...before.providers[0], api_key: 'staged-key' }])
    ).rejects.toThrow(/changed during publication/)
    expect(values.has('wework-models.pending')).toBe(true)
    expect(previousKeys.every(key => values.has(key))).toBe(true)
    expect((await racing.runtime()).models[0].provider.api_key).toBe('secret-not-for-output')
    const externalSource = await readFile(saved.path, 'utf8')
    const selected = join(directory, 'selected.yml')
    await writeFile(selected, YAML.replace('secret-not-for-output', 'selected-key'))
    const recovered = new ModelConfigurationStore(directory, secrets)
    await expect(recovered.read()).rejects.toThrow(/changed during publication/)
    const bound = await recovered.bind(selected)
    expect(bound.path).toBe(await realpath(selected))
    expect(values.has('wework-models.pending')).toBe(false)
    expect((await recovered.runtime()).models[0].provider.api_key).toBe('selected-key')
    expect(await readFile(saved.path, 'utf8')).toBe(externalSource)
    expect((await new ModelConfigurationStore(directory, secrets).read()).path).toBe(bound.path)
  })

  test('a recovery-backup failure never deletes the key referenced by the committed file', async () => {
    const store = new ModelConfigurationStore(directory, secrets)
    const empty = await store.read()
    const saved = await store.save(empty.revision, parseModelConfiguration(YAML).config.providers)
    const faulty = new ModelConfigurationStore(directory, {
      ...secrets,
      update: async (change: (values: Record<string, string>) => void) => {
        const next = Object.fromEntries(values)
        change(next)
        if (!next['wework-models.last-good'].includes(saved.providers[0].api_key_ref!))
          throw new Error('backup write failed')
        await secrets.update(change)
      },
    })
    const before = await faulty.read()
    await expect(
      faulty.save(before.revision, [{ ...before.providers[0], api_key: 'committed-key' }])
    ).rejects.toThrow(/backup write failed/)
    const committed = parseModelConfiguration(await readFile(saved.path, 'utf8')).config
    expect(await secrets.get(committed.providers[0].api_key_ref!)).toBe('secret-not-for-output')
    expect(await secrets.get(saved.providers[0].api_key_ref!)).toBe('secret-not-for-output')
    const restarted = new ModelConfigurationStore(directory, secrets)
    await restarted.read()
    expect((await restarted.runtime()).models[0].provider.api_key).toBe('secret-not-for-output')
  })
})

describe('Provider model discovery', () => {
  const draft = {
    base_url: 'https://draft.example/v1/',
    api_format: 'openai-responses',
    api_key: 'draft-key',
  }
  const response = (data: unknown) =>
    new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json' },
    })

  test('discovers with an unsaved connection without changing files, secrets or runtime', async () => {
    const store = new ModelConfigurationStore(directory, secrets)
    const before = await store.read()
    const secretsBefore = new Map(values)
    const request = vi.fn().mockResolvedValue(
      response({
        data: [{ id: 'z' }, { id: 'a' }, { id: 'z' }, { id: '  a ' }, { id: '' }, null],
      })
    )
    vi.stubGlobal('fetch', request)
    expect(await store.discover('new-provider', { ...draft, models: [{ model_id: '' }] })).toEqual([
      'a',
      'z',
    ])
    expect(request).toHaveBeenCalledWith(
      'https://draft.example/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer draft-key' },
        redirect: 'error',
        signal: expect.any(AbortSignal),
      })
    )
    expect(await readFile(join(directory, 'model.yml'), 'utf8')).toContain('credential_protocol: 3')
    expect((await store.read()).revision).toBe(before.revision)
    expect((await store.runtime()).models).toEqual([])
    expect(values).toEqual(secretsBefore)
  })

  test('uses the stored encrypted key when the current form leaves it blank', async () => {
    const store = new ModelConfigurationStore(directory, secrets)
    const initial = await store.read()
    await store.save(initial.revision, parseModelConfiguration(YAML).config.providers)
    const secretsBefore = new Map(values)
    const request = vi.fn().mockResolvedValue(response({ data: [] }))
    vi.stubGlobal('fetch', request)
    await store.discover('relay', { ...draft, base_url: 'https://relay.example/v1', api_key: '' })
    expect(request).toHaveBeenCalledWith(
      'https://relay.example/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer secret-not-for-output' },
      })
    )
    expect((await store.runtime()).models[0].provider.base_url).toBe('https://relay.example/v1')
    expect(values).toEqual(secretsBefore)
  })

  test('a replacement draft key takes precedence but does not rotate the saved key', async () => {
    await writeFile(join(directory, 'model.yml'), YAML)
    const store = new ModelConfigurationStore(directory, secrets)
    await store.read()
    const request = vi.fn().mockResolvedValue(response({ data: [] }))
    vi.stubGlobal('fetch', request)
    await store.discover('relay', draft)
    expect(request).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { Authorization: 'Bearer draft-key' },
      })
    )
    expect((await store.runtime()).models[0].provider.api_key).toBe('secret-not-for-output')
    expect(await readFile(join(directory, 'model.yml'), 'utf8')).not.toContain(
      'secret-not-for-output'
    )
  })

  test('retains saved-provider discovery for older callers', async () => {
    await writeFile(join(directory, 'model.yml'), YAML)
    const store = new ModelConfigurationStore(directory, secrets)
    await store.read()
    const request = vi.fn().mockResolvedValue(response({ data: [] }))
    vi.stubGlobal('fetch', request)
    await store.discover('relay')
    expect(request).toHaveBeenCalledWith(
      'https://relay.example/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer secret-not-for-output' },
      })
    )
  })

  test('supports a custom model-list path, key header and unauthenticated local connections', async () => {
    const store = new ModelConfigurationStore(directory, secrets)
    const request = vi.fn().mockImplementation(async () => response({ data: [] }))
    vi.stubGlobal('fetch', request)
    await store.discover('new', {
      ...draft,
      models_path: '/catalog',
      models_api_key_header: 'X-Api-Key',
    })
    expect(request).toHaveBeenLastCalledWith(
      'https://draft.example/v1/catalog',
      expect.objectContaining({
        headers: { 'X-Api-Key': 'draft-key' },
      })
    )
    await store.discover('local', {
      ...draft,
      base_url: 'http://127.0.0.1:11434/v1',
      api_key: undefined,
    })
    expect(request).toHaveBeenLastCalledWith(
      'http://127.0.0.1:11434/v1/models',
      expect.objectContaining({ headers: {} })
    )
  })

  test('does not trust a renderer-supplied credential reference', async () => {
    values.set('wework-model-key.other', 'other-provider-secret')
    const store = new ModelConfigurationStore(directory, secrets)
    const request = vi.fn().mockResolvedValue(response({ data: [] }))
    vi.stubGlobal('fetch', request)
    await store.discover('new', {
      ...draft,
      api_key: undefined,
      api_key_ref: 'wework-model-key.other',
    })
    expect(request).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: {} })
    )
  })

  test('invalid draft URLs, keys and paths fail before issuing a request', async () => {
    const store = new ModelConfigurationStore(directory, secrets)
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    for (const input of [
      null,
      [],
      { ...draft, base_url: 'file:///etc/passwd' },
      { ...draft, base_url: 'https://user:secret@relay.example' },
      { ...draft, api_key: 123 },
      { ...draft, models_path: '//other.example/models' },
    ])
      await expect(store.discover('new', input)).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })

  test('missing stored credentials require a replacement key instead of silently using no auth', async () => {
    const store = new ModelConfigurationStore(directory, secrets)
    const initial = await store.read()
    await store.save(initial.revision, parseModelConfiguration(YAML).config.providers)
    values.clear()
    const request = vi.fn().mockResolvedValue(response({ data: [] }))
    vi.stubGlobal('fetch', request)
    await expect(
      store.discover('relay', {
        ...draft,
        base_url: 'https://relay.example/v1',
        api_key: undefined,
      })
    ).rejects.toThrow(/saved API key/)
    expect(request).not.toHaveBeenCalled()
    await expect(store.discover('relay', draft)).resolves.toEqual([])
  })

  test('sanitizes request failures and rejects invalid, null and oversized responses', async () => {
    const store = new ModelConfigurationStore(directory, secrets)
    const request = vi.fn().mockRejectedValue(new Error('network draft-key details'))
    vi.stubGlobal('fetch', request)
    await expect(store.discover('new', draft)).rejects.toThrow(/failed or timed out/)
    request.mockResolvedValue(new Response('secret server body', { status: 401 }))
    await expect(store.discover('new', draft)).rejects.toThrow(/HTTP 401/)
    request.mockResolvedValue(new Response('not-json'))
    await expect(store.discover('new', draft)).rejects.toThrow(/not valid JSON/)
    request.mockResolvedValue(response(null))
    await expect(store.discover('new', draft)).rejects.toThrow(/data array/)
    request.mockResolvedValue(new Response('{}', { headers: { 'content-length': '3000000' } }))
    await expect(store.discover('new', draft)).rejects.toThrow(/too large/)
  })
})
