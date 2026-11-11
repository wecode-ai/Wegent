import { describe, expect, test, vi } from 'vitest'
import type { ModelConfigurationStore } from './model-configuration-store.js'
import type { ResolvedProviderModel } from './model-configuration-contract.js'
import { WorkbenchModelCatalog } from './workbench-model-catalog.js'
import { WorkbenchRoutes } from './workbench-routes.js'

const profile = () => ({
  apiBaseUrl: 'https://a.example/api',
  backendUrl: 'https://a.example',
  socketBaseUrl: 'https://a.example',
  socketPath: '/socket.io',
  credentialMode: 'legacy_access_token',
  token: 'access-a',
  connectedAt: '2026-11-01T00:00:00Z',
  user: { id: 7, user_name: 'a', email: 'a@example.com' },
})
type Profile = Omit<ReturnType<typeof profile>, 'token'> & { token?: string }

const local: ResolvedProviderModel = {
  provider: {
    id: 'local',
    name: 'Company',
    base_url: 'https://models.example',
    api_format: 'openai-chat-completions',
    api_key: 'local-secret',
  },
  model: {
    id: 'assistant',
    model_id: 'upstream',
    display_name: 'Local assistant',
    max_output_tokens: 2048,
  },
}
const runtimeKey = 'wework:runtime:::local-model%3Aassistant'
const cloudKey = 'wework:public:default:0:shared'
const cloud = { name: 'shared', type: 'public', namespace: 'default', resource_user_id: 0 }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(finish => {
    resolve = finish
  })
  return { promise, resolve }
}
const json = (body: unknown) => new Response(JSON.stringify(body))

function fixture(models: ResolvedProviderModel[] = [local]) {
  let current: Profile | null = profile()
  const connection = vi.fn(async () => current)
  const accessToken = vi.fn(async () => 'desktop-access')
  const request = vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>(
    async () => ({})
  )
  const fetch = vi.fn<typeof globalThis.fetch>(async input =>
    String(input).includes('/models/unified')
      ? json({ data: [cloud] })
      : json({ auth_token: 'runtime-a' })
  )
  const proxy = vi.fn(async () => 'http://proxy.example')
  const runtime = vi.fn(async () => ({ revision: 'current', models }))
  const catalog = new WorkbenchModelCatalog({
    configuration: { runtime } as unknown as ModelConfigurationStore,
    connection,
    accessToken,
    fetch,
    proxy,
    request: async <T>(method: string, params: Record<string, unknown>) =>
      (await request(method, params)) as T,
  })
  return {
    catalog,
    connection,
    accessToken,
    request,
    fetch,
    proxy,
    runtime,
    current: () => current,
    setConnection: (value: Profile | null) => {
      current = value
    },
  }
}

describe('Host-owned workbench model catalog', () => {
  test('a cloud switch while issuing a runtime token never configures the old backend', async () => {
    const f = fixture()
    const entered = deferred<void>()
    const token = deferred<Response>()
    f.fetch.mockImplementationOnce(() => {
      entered.resolve()
      return token.promise
    })
    const preparing = f.catalog.prepareCloud()
    await entered.promise
    f.setConnection({ ...profile(), backendUrl: 'https://b.example' })
    token.resolve(json({ auth_token: 'late-runtime-a' }))
    await expect(preparing).rejects.toThrow('Cloud connection changed')
    expect(f.request).not.toHaveBeenCalled()
  })

  test('projects local runner models without reading or configuring any cloud connection', async () => {
    const disabled = { ...local, model: { ...local.model, id: 'disabled', enabled: false } }
    const f = fixture([local, disabled])
    f.setConnection(null)
    const models = await f.catalog.models(runtimeKey)
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      key: runtimeKey,
      displayName: 'Local assistant',
      upstream: {
        request_url: 'https://models.example/chat/completions',
        api_format: 'openai-chat-completions',
        api_key: 'local-secret',
        model_id: 'upstream',
        proxy_url: 'http://proxy.example',
        max_output_tokens: 2048,
      },
    })
    expect(f.connection).not.toHaveBeenCalled()
    expect(f.fetch).not.toHaveBeenCalled()
    expect(f.request).not.toHaveBeenCalled()
  })

  test('uses the current account credentials and exact resource identity for cloud models', async () => {
    const f = fixture()
    const models = await f.catalog.models(cloudKey)
    expect(models.map(model => model.key)).toEqual([runtimeKey, cloudKey])
    expect(models[1].cloudModel).toEqual(cloud)
    expect(f.request).toHaveBeenCalledExactlyOnceWith('executor.backend.configure', {
      backend_url: 'https://a.example',
      socket_url: 'https://a.example',
      auth_token: 'access-a',
      runtime_auth_token: 'runtime-a',
      device_type: 'app',
    })
    expect(f.accessToken).not.toHaveBeenCalled()
    const [input, init] = f.fetch.mock.calls[1]
    const url = new URL(String(input))
    expect(url.pathname).toBe('/api/models/unified')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      include_config: 'false',
      scope: 'all',
      model_category_type: 'llm',
      client_origin: 'wework',
    })
    expect(init).toEqual({ headers: { authorization: 'Bearer access-a' }, redirect: 'error' })
  })

  test('refreshes desktop credentials with the configured destination and account owner', async () => {
    const f = fixture()
    const desktop: Profile = { ...profile(), credentialMode: 'desktop_refresh' }
    delete desktop.token
    f.setConnection(desktop)
    await f.catalog.prepareCloud()
    expect(f.accessToken).toHaveBeenCalledExactlyOnceWith('https://a.example/api', 7)
    expect(f.request).toHaveBeenCalledWith(
      'executor.backend.configure',
      expect.objectContaining({
        auth_token: 'desktop-access',
        runtime_auth_token: 'runtime-a',
      })
    )
  })

  test.each([
    ['logout', () => null],
    ['token', () => ({ ...profile(), token: 'new-token' })],
    ['account', () => ({ ...profile(), user: { ...profile().user, id: 8 } })],
    ['API', () => ({ ...profile(), apiBaseUrl: 'https://b.example/api' })],
    ['socket', () => ({ ...profile(), socketBaseUrl: 'https://b.example' })],
    ['credential mode', () => ({ ...profile(), credentialMode: 'desktop_refresh' })],
    ['socket path', () => ({ ...profile(), socketPath: '/new-socket' })],
    ['connection session', () => ({ ...profile(), connectedAt: '2026-11-02T00:00:00Z' })],
  ] as const)(
    'rejects a changed %s after runtime-token fetch without configuring or clearing the Executor',
    async (_name, next) => {
      const f = fixture()
      const entered = deferred<void>()
      const token = deferred<Response>()
      f.fetch.mockImplementationOnce(() => {
        entered.resolve()
        return token.promise
      })
      const preparing = f.catalog.prepareCloud()
      await entered.promise
      f.setConnection(next())
      token.resolve(json({ auth_token: 'late-runtime-a' }))
      await expect(preparing).rejects.toThrow('Cloud connection changed')
      expect(f.request).not.toHaveBeenCalled()
    }
  )

  test('captures an immutable connection snapshot even when the profile object is mutated in place', async () => {
    const f = fixture()
    const entered = deferred<void>()
    const token = deferred<Response>()
    f.fetch.mockImplementationOnce(() => {
      entered.resolve()
      return token.promise
    })
    const preparing = f.catalog.prepareCloud()
    await entered.promise
    f.current()!.token = 'replaced-in-place'
    token.resolve(json({ auth_token: 'late-runtime-a' }))
    await expect(preparing).rejects.toThrow('Cloud connection changed')
    expect(f.request).not.toHaveBeenCalled()
  })

  test('a profile change while refreshing desktop credentials cannot issue a runtime token', async () => {
    const f = fixture()
    f.setConnection({ ...profile(), credentialMode: 'desktop_refresh' })
    const entered = deferred<void>()
    const access = deferred<string>()
    f.accessToken.mockImplementationOnce(() => {
      entered.resolve()
      return access.promise
    })
    const preparing = f.catalog.prepareCloud()
    await entered.promise
    f.setConnection(null)
    access.resolve('late-access-a')
    await expect(preparing).rejects.toThrow('Cloud connection changed')
    expect(f.fetch).not.toHaveBeenCalled()
    expect(f.request).not.toHaveBeenCalled()
  })

  test('a late A preparation never clears or overwrites an already configured B connection', async () => {
    const f = fixture()
    const entered = deferred<void>()
    const token = deferred<Response>()
    f.fetch.mockImplementationOnce(() => {
      entered.resolve()
      return token.promise
    })
    const a = f.catalog.prepareCloud()
    await entered.promise
    f.setConnection({
      ...profile(),
      backendUrl: 'https://b.example',
      token: 'access-b',
      user: { ...profile().user, id: 8 },
    })
    await f.catalog.prepareCloud()
    token.resolve(json({ auth_token: 'late-runtime-a' }))
    await expect(a).rejects.toThrow('Cloud connection changed')
    expect(f.request).toHaveBeenCalledExactlyOnceWith(
      'executor.backend.configure',
      expect.objectContaining({
        backend_url: 'https://b.example',
        auth_token: 'access-b',
      })
    )
  })

  test('filters incomplete, disabled and invalid cloud identities while retaining equal names in distinct scopes', async () => {
    const f = fixture()
    f.fetch.mockImplementation(async input =>
      String(input).includes('/models/unified')
        ? json({
            data: [
              cloud,
              { name: 'shared', type: 'group', namespace: 'team', resourceUserId: 7 },
              { ...cloud, namespace: 'another', resource_user_id: 8 },
              { name: 'missing-namespace', type: 'public', resource_user_id: 0 },
              { name: 'missing-owner', type: 'public', namespace: 'default' },
              { ...cloud, resource_user_id: -1 },
              { ...cloud, resource_user_id: 1.5 },
              { ...cloud, resource_user_id: Number.MAX_SAFE_INTEGER + 1 },
              { ...cloud, resource_user_id: '0' },
              { ...cloud, type: 'runtime' },
              { ...cloud, name: ' ' },
              { ...cloud, namespace: ' ' },
              { ...cloud, isActive: false },
              { ...cloud, is_active: false },
              { ...cloud, compatibilityDisabled: true },
            ],
          })
        : json({ auth_token: 'runtime-a' })
    )
    const models = await f.catalog.models(cloudKey)
    expect(models.map(model => model.key)).toEqual([
      runtimeKey,
      cloudKey,
      'wework:group:team:7:shared',
      'wework:public:another:8:shared',
    ])
    expect(models[2].cloudModel).toEqual({
      name: 'shared',
      type: 'group',
      namespace: 'team',
      resource_user_id: 7,
    })
  })

  test.each(['wework:runtime:::missing', 'wework:public:default:0:missing'])(
    'an unavailable selected identity %s fails instead of registering a different model',
    async modelKey => {
      const f = fixture()
      const routes = new WorkbenchRoutes({
        models: key => f.catalog.models(key),
        user: () => f.catalog.user(),
        request: async <T>(method: string, params: Record<string, unknown>) =>
          (await f.request(method, params)) as T,
      })
      await expect(
        routes.acquire({ id: 'todo', modelKey, grantedCapabilities: {} } as never)
      ).rejects.toThrow('configured workbench model is unavailable')
      expect(f.request.mock.calls.some(([method]) => method.startsWith('runtime.'))).toBe(false)
    }
  )
})
