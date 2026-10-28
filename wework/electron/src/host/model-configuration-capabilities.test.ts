import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { HostCapabilityRouter, type HostCapability } from './capability-router.js'
import { DesktopHostEventBroker } from './desktop-host-events.js'
import { registerModelConfigurationCapabilities } from './model-configuration-capabilities.js'
import { ModelConfigurationStore } from './model-configuration-store.js'
import type { SecureValueStore } from './secure-value-store.js'
import type { ModelConfigurationSnapshot } from './model-configuration-contract.js'
import { resolveSystemProxy } from './system-proxy.js'

const electron = vi.hoisted(() => ({ root: '', dialog: vi.fn(), fetch: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => electron.root },
  dialog: { showOpenDialog: electron.dialog },
  shell: { openPath: vi.fn() },
  net: { fetch: electron.fetch },
  session: { defaultSession: {} },
}))
vi.mock('./system-proxy.js', () => ({ resolveSystemProxy: vi.fn(async () => null) }))
let router: HostCapabilityRouter
let values: Record<string, string>
let unavailable: boolean
let events: DesktopHostEventBroker
let publish: ReturnType<typeof vi.fn>
const principal = '@wegent/dsh-app-wework'
const capabilities = [
  'read',
  'runtime',
  'save',
  'choose',
  'discover',
  'probe',
  'open',
  'recovery',
  'restoreRecovery',
].map(name => `modelConfiguration.${name}`) as HostCapability[]
const provider = {
  id: 'a',
  name: 'A',
  base_url: 'https://approved.example/v1',
  api_format: 'openai-responses',
  api_key: 'secret-canary',
  models: [{ id: 'one', model_id: 'upstream' }],
}
const invoke = <T>(name: string, params = {}) =>
  router.invoke(principal, `modelConfiguration.${name}`, params) as Promise<T>

beforeEach(async () => {
  electron.root = await mkdtemp(join(tmpdir(), 'wework-model-capabilities-'))
  electron.dialog.mockReset().mockResolvedValue({ canceled: true, filePaths: [] })
  vi.mocked(resolveSystemProxy).mockReset().mockResolvedValue(null)
  values = {}
  unavailable = false
  publish = vi.fn().mockResolvedValue(undefined)
  events = new DesktopHostEventBroker()
  router = new HostCapabilityRouter()
  const secrets = {
    get: async (key: string) => {
      if (unavailable) throw new Error('vault unavailable')
      return values[key] ?? null
    },
    set: async (key: string, value: string) => {
      values[key] = value
    },
    delete: async (key: string) => {
      delete values[key]
    },
    update: async (change: (next: Record<string, string>) => void) => {
      const next = { ...values }
      change(next)
      values = next
    },
  } as SecureValueStore
  const configuration = new ModelConfigurationStore(
    join(electron.root, 'model-connections'),
    secrets
  )
  await configuration.read()
  registerModelConfigurationCapabilities(router, () => null, configuration, events, publish)
  router.grant(principal, capabilities)
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(electron.root, { recursive: true, force: true })
})

test('credential rotation cannot acknowledge while a discovery still uses the old saved key', async () => {
  const initial = await invoke<ModelConfigurationSnapshot>('read')
  const saved = await invoke<ModelConfigurationSnapshot>('save', {
    revision: initial.revision,
    providers: [provider],
  })
  let finish!: (response: Response) => void
  const fetching = vi.fn(
    () =>
      new Promise<Response>(resolve => {
        finish = resolve
      })
  )
  vi.stubGlobal('fetch', fetching)
  const discovery = invoke('discover', { providerId: 'a' })
  await vi.waitFor(() => expect(fetching).toHaveBeenCalledOnce())
  const before = publish.mock.calls.length
  const rotation = invoke('save', {
    revision: saved.revision,
    providers: [{ ...saved.providers[0], api_key: 'rotated-canary' }],
  })
  await Promise.resolve()
  expect(publish).toHaveBeenCalledTimes(before)
  finish(Response.json({ data: [{ id: 'upstream' }] }))
  await expect(discovery).resolves.toEqual(['upstream'])
  await rotation
  expect(publish.mock.lastCall?.[0].map((entry: { secret: string }) => entry.secret)).toEqual([
    'rotated-canary',
  ])
})

test('native metadata and runtime return no plaintext; storage failure revokes cached executor credentials', async () => {
  const initial = await invoke<ModelConfigurationSnapshot>('read')
  const saved = await invoke<ModelConfigurationSnapshot>('save', {
    revision: initial.revision,
    providers: [provider],
  })
  const runtime = await invoke<{ models: Array<{ provider: { api_key: string } }> }>('runtime')
  expect(JSON.stringify([saved, runtime])).not.toContain('secret-canary')
  expect(runtime.models[0].provider.api_key).toMatch(/^wework-vault\./)
  expect(publish.mock.lastCall?.[0][0].secret).toBe('secret-canary')
  const before = publish.mock.calls.length
  expect(await invoke('choose')).toBeNull()
  expect(publish).toHaveBeenCalledTimes(before)
  unavailable = true
  await expect(invoke('read')).rejects.toThrow('vault unavailable')
  expect(publish.mock.lastCall?.[0]).toEqual([])
})

test('a blocked draft publication cannot pass a concurrent rotation and reintroduce the old key', async () => {
  const initial = await invoke<ModelConfigurationSnapshot>('read')
  const saved = await invoke<ModelConfigurationSnapshot>('save', {
    revision: initial.revision,
    providers: [provider],
  })
  let release!: () => void
  vi.mocked(resolveSystemProxy).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        release = () => resolve(null)
      })
  )
  const { api_key_configured, ...savedProvider } = saved.providers[0]
  expect(api_key_configured).toBe(true)
  const draft = invoke('runtime', { provider: savedProvider })
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  const rotating = invoke('save', {
    revision: saved.revision,
    providers: [{ ...saved.providers[0], api_key: 'rotated-canary' }],
  })
  const before = publish.mock.calls.length
  await Promise.resolve()
  expect(publish).toHaveBeenCalledTimes(before)
  release()
  await Promise.all([draft, rotating])
  const last = publish.mock.lastCall?.[0]
  expect(last.map((entry: { secret: string }) => entry.secret)).toEqual(['rotated-canary'])
  expect(
    events.read(0).events.filter(event => event.type === 'model-configuration.changed')
  ).toHaveLength(2)
})

test('recovery is permission guarded, revokes before publication and never exposes a saved key', async () => {
  const initial = await invoke<ModelConfigurationSnapshot>('read')
  await invoke('save', { revision: initial.revision, providers: [provider] })
  for (const name of ['recovery', 'restoreRecovery']) {
    await expect(
      router.invoke('untrusted', `modelConfiguration.${name}`, {})
    ).rejects.toMatchObject({ code: 'capability_denied' })
  }
  const recovery =
    await invoke<import('./model-configuration-contract.js').ModelRecoverySnapshot>('recovery')
  expect(JSON.stringify(recovery)).not.toContain('secret-canary')
  const before = publish.mock.calls.length
  const anchor = values['wework-models.last-good']
  publish.mockImplementationOnce(async entries => {
    expect(entries).toEqual([])
    expect(values['wework-models.last-good']).toBe(anchor)
  })
  const restored = await invoke<ModelConfigurationSnapshot>('restoreRecovery', {
    id: recovery.candidates[0].id,
    revision: recovery.revision,
    configurationRevision: '',
  })
  expect(publish.mock.calls[before][0]).toEqual([])
  expect(publish.mock.lastCall?.[0][0].secret).toBe('secret-canary')
  expect(JSON.stringify(restored)).not.toContain('secret-canary')
  expect(
    events.read(0).events.filter(event => event.type === 'model-configuration.changed')
  ).toHaveLength(2)
  const calls = publish.mock.calls.length
  await expect(invoke('restoreRecovery', { id: 'forged' })).rejects.toThrow(/revisions/)
  expect(publish).toHaveBeenCalledTimes(calls)
})
