import { afterEach, expect, test, vi } from 'vitest'
import { ModelRuntimeCredentials } from './model-runtime-credentials.js'
import type { ResolvedProviderModel } from './model-configuration-contract.js'

const model: ResolvedProviderModel = {
  provider: {
    id: 'relay',
    name: 'Relay',
    api_format: 'openai-responses',
    base_url: 'https://relay.example/v1',
    api_key: 'secret-canary',
    api_key_ref: 'wework-model-key.internal',
  },
  model: { id: 'one', model_id: 'upstream' },
}
afterEach(() => vi.useRealTimers())

test('model aliases share one authorized publication across repeated reads without duplicate references', async () => {
  const replace = vi.fn(async entries => {
    const references = entries.map((entry: { reference: string }) => entry.reference)
    if (new Set(references).size !== references.length) throw new Error('duplicate publication')
  })
  const runtime = new ModelRuntimeCredentials(replace, async () => null)
  const alias = structuredClone(model)
  alias.model.id = 'second-local-alias'
  const first = await runtime.publish([model, alias])
  const second = await runtime.publish([model, alias])
  expect(second.map(entry => entry.provider.api_key)).toEqual(
    first.map(entry => entry.provider.api_key)
  )
  expect(replace.mock.lastCall?.[0]).toHaveLength(1)
  expect(second[0].provider.api_key).toBe(second[1].provider.api_key)
})

test('only the owner publication contains keys; references are bound to full targets and proxy', async () => {
  const replace = vi.fn().mockResolvedValue(undefined)
  const runtime = new ModelRuntimeCredentials(replace, async () => 'http://proxy.example:8080')
  const [safe] = await runtime.publish([model])
  expect(JSON.stringify(safe)).not.toContain('secret-canary')
  expect(safe.provider.api_key_ref).toBeUndefined()
  expect(safe.provider.api_key).toMatch(/^wework-vault\./)
  expect(replace.mock.lastCall?.[0][0]).toMatchObject({
    secret: 'secret-canary',
    targets: [
      {
        url: 'https://relay.example/v1/responses',
        model_id: 'upstream',
        api_format: 'openai-responses',
        proxy_url: 'http://proxy.example:8080',
      },
    ],
    expires_at_ms: null,
  })
  expect((await runtime.publish([model]))[0].provider.api_key).toBe(safe.provider.api_key)
  const changed = structuredClone(model)
  changed.provider.api_key = 'rotated'
  expect((await runtime.publish([changed]))[0].provider.api_key).not.toBe(safe.provider.api_key)
  await runtime.revokeAll()
  expect(replace.mock.lastCall?.[0]).toEqual([])
})

test('drafts expire, publication failure does not acknowledge a reference, probes never accept a URL or header', async () => {
  vi.useFakeTimers()
  const replace = vi.fn().mockResolvedValue(undefined)
  const request = vi.fn().mockImplementation(async () => new Response('{"echo":"secret-canary"}'))
  const runtime = new ModelRuntimeCredentials(replace, async () => null, request)
  const [safe] = await runtime.publish([model], true)
  const params = {
    reference: safe.provider.api_key,
    body: '{"model":"upstream"}',
    url: 'https://attacker.test',
    headers: { Authorization: 'attacker' },
  }
  expect(await runtime.probe(params)).toEqual({ status: 200, body: '{"echo":"[redacted]"}' })
  expect(request).toHaveBeenCalledWith(
    'https://relay.example/v1/responses',
    expect.objectContaining({
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-canary' },
    })
  )
  await expect(runtime.probe({ ...params, body: '{"model":"other"}' })).rejects.toThrow(/mismatch/)
  await expect(runtime.probe({ ...params, preset: true })).rejects.toThrow(/Invalid/)
  await vi.advanceTimersByTimeAsync(60_001)
  await expect(runtime.probe(params)).rejects.toThrow(/expired/)
  replace.mockRejectedValueOnce(new Error('owner closed'))
  await expect(runtime.publish([model])).rejects.toThrow('owner closed')
})

test('unauthenticated connections omit credentials and preset probes cannot be redirected by a profile label', async () => {
  const request = vi.fn().mockImplementation(async () => new Response('{}'))
  const runtime = new ModelRuntimeCredentials(
    async () => {},
    async () => null,
    request
  )
  const local = structuredClone(model)
  delete local.provider.api_key
  local.model.provider_profile_id = 'minimax'
  const [safe] = await runtime.publish([local])
  await runtime.probe({ reference: safe.provider.api_key, body: '{"model":"upstream"}' })
  expect(request.mock.lastCall?.[1].headers).toEqual({ 'Content-Type': 'application/json' })
  await expect(
    runtime.probe({ reference: safe.provider.api_key, preset: true, body: '{"model":"upstream"}' })
  ).rejects.toThrow()
})

test('saved grants survive a draft expiry and draft references never alias saved references', async () => {
  vi.useFakeTimers()
  const request = vi.fn().mockImplementation(async () => new Response('{}'))
  const runtime = new ModelRuntimeCredentials(
    async () => {},
    async () => null,
    request
  )
  const [saved] = await runtime.publish([model])
  const [draft] = await runtime.publish([model], true)
  expect(draft.provider.api_key).not.toBe(saved.provider.api_key)
  await vi.advanceTimersByTimeAsync(60_001)
  await expect(
    runtime.probe({ reference: draft.provider.api_key, body: '{"model":"upstream"}' })
  ).rejects.toThrow(/expired/)
  await expect(
    runtime.probe({ reference: saved.provider.api_key, body: '{"model":"upstream"}' })
  ).resolves.toMatchObject({ status: 200 })
})

test.each(['network', 'empty', 'stream', 'oversized'])(
  'probe %s errors cannot reveal credentials',
  async failure => {
    const request = vi.fn().mockImplementation(async () => {
      if (failure === 'network') throw new Error('secret-canary')
      if (failure === 'empty') return new Response(null)
      return new Response(
        new ReadableStream({
          start(controller) {
            if (failure === 'stream') controller.error(new Error('secret-canary'))
            else {
              controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1))
              controller.close()
            }
          },
        })
      )
    })
    const runtime = new ModelRuntimeCredentials(
      async () => {},
      async () => null,
      request
    )
    const [safe] = await runtime.publish([model])
    await expect(
      runtime.probe({ reference: safe.provider.api_key, body: '{"model":"upstream"}' })
    ).rejects.not.toThrow('secret-canary')
    await runtime.revokeAll()
  }
)

test('revocation aborts a pending native probe before acknowledging completion', async () => {
  const request = vi.fn().mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('canceled')))
      })
  )
  const replace = vi.fn().mockResolvedValue(undefined)
  const runtime = new ModelRuntimeCredentials(replace, async () => null, request)
  const [safe] = await runtime.publish([model])
  const probing = runtime.probe({ reference: safe.provider.api_key, body: '{"model":"upstream"}' })
  const rejected = expect(probing).rejects.toThrow(/failed or timed out/)
  await runtime.revokeAll()
  await rejected
  expect(request.mock.lastCall?.[1].signal.aborted).toBe(true)
  expect(replace.mock.lastCall?.[0]).toEqual([])
})
