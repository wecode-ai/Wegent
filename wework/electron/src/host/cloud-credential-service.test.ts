import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { CloudCredentialError, CloudCredentialService } from './cloud-credential-service.js'

const roots: string[] = []
const vaults = new Map<string, Map<string, string>>()
function createService(root: string, request?: typeof fetch) {
  let values = vaults.get(root)
  if (!values) {
    values = new Map()
    vaults.set(root, values)
  }
  const entries = values
  return new CloudCredentialService(
    root,
    {
      get: async key => entries.get(key) ?? null,
      update: async change => {
        const next = Object.fromEntries(entries)
        change(next)
        entries.clear()
        for (const [key, value] of Object.entries(next)) entries.set(key, value)
      },
    },
    request
  )
}

const electronMocks = vi.hoisted(() => ({ netFetch: vi.fn<typeof fetch>() }))

vi.mock('electron', () => ({ net: { fetch: electronMocks.netFetch } }))

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('CloudCredentialService', () => {
  beforeEach(() => {
    electronMocks.netFetch.mockReset()
  })

  test('eager initialization preserves device identity, removes the weak source, and cannot resurrect logout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-cloud-credentials-'))
    roots.push(root)
    const publicKey = await createService(root).devicePublicKey()
    const stored = JSON.parse(vaults.get(root)!.get('wework-cloud.identity')!)
    stored.apiBaseUrl = 'https://cloud.example/api'
    stored.refreshToken = 'refresh-canary'
    vaults.get(root)!.clear()
    const path = join(root, 'cloud-credentials.json')
    const source = JSON.stringify(stored)
    await writeFile(path, source)
    const request = vi.fn<typeof fetch>()
    const failing = new CloudCredentialService(
      root,
      {
        get: async () => null,
        update: async () => {
          throw new Error('vault locked')
        },
      },
      request
    )
    await expect(failing.initialize()).rejects.toThrow('vault locked')
    expect(await readFile(path, 'utf8')).toBe(source)
    const service = createService(root, request)
    await service.initialize()
    expect(await service.devicePublicKey()).toEqual(publicKey)
    expect(JSON.parse(vaults.get(root)!.get('wework-cloud.identity')!)).toEqual(stored)
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(request).not.toHaveBeenCalled()
    await service.clear()
    await writeFile(path, source)
    await createService(root, request).initialize()
    expect(vaults.get(root)!.has('wework-cloud.identity')).toBe(false)
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('polls the authorization session through the Chromium network stack', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-cloud-credentials-'))
    roots.push(root)
    electronMocks.netFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'pending' }), { status: 200 })
    )

    const claimed = await createService(root).claimAuthorization({
      apiBaseUrl: 'https://cloud.example.com/api/',
      sessionId: 'session-1',
      pollToken: 'poll-1',
    })

    expect(claimed.status).toBe('pending')
    expect(electronMocks.netFetch).toHaveBeenCalledWith(
      'https://cloud.example.com/api/auth/wework/sessions/session-1/poll?poll_token=poll-1',
      { method: 'GET', redirect: 'error', signal: expect.any(AbortSignal) }
    )
  })

  test('bounds every cloud credential request so a hung call cannot block the queue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-cloud-credentials-'))
    roots.push(root)
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'success',
            access_token: 'access-1',
            refresh_token: 'refresh-secret',
            token_type: 'bearer',
            username: 'alice',
          }),
          { status: 200 }
        )
      )
      .mockRejectedValueOnce(new DOMException('The operation was aborted', 'TimeoutError'))
    const service = createService(root, request)

    await service.devicePublicKey()
    await service.claimAuthorization({
      apiBaseUrl: 'https://cloud.example.com/api/',
      sessionId: 'session-1',
      pollToken: 'poll-1',
    })

    await expect(service.refreshAccessToken('https://cloud.example.com/api')).rejects.toMatchObject(
      {
        code: 'request_timeout',
        message: 'Cloud credential request timed out',
      } satisfies Partial<CloudCredentialError>
    )
    expect(request.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
    expect(request.mock.calls[1][1]?.signal).toBeInstanceOf(AbortSignal)
    // The serial queue keeps working after the timed-out request.
    request.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'access-2',
          token_type: 'bearer',
          expires_in: 3600,
        }),
        { status: 200 }
      )
    )
    await expect(
      service.refreshAccessToken('https://cloud.example.com/api')
    ).resolves.toMatchObject({ accessToken: 'access-2' })
  })

  test('stores the complete identity in the protected repository and refreshes with a device proof', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-cloud-credentials-'))
    roots.push(root)
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'success',
            access_token: 'access-1',
            refresh_token: 'refresh-secret',
            token_type: 'bearer',
            username: 'alice',
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-2',
            token_type: 'bearer',
            expires_in: 3600,
          }),
          { status: 200 }
        )
      )
    const service = createService(root, request)

    const publicKey = await service.devicePublicKey()
    const claimed = await service.claimAuthorization({
      apiBaseUrl: 'https://cloud.example.com/api/',
      sessionId: 'session-1',
      pollToken: 'poll-1',
    })
    const refreshed = await service.refreshAccessToken('https://cloud.example.com/api')

    expect(publicKey).toMatchObject({ kty: 'EC', crv: 'P-256' })
    expect(claimed).toEqual({
      status: 'success',
      accessToken: 'access-1',
      tokenType: 'bearer',
      username: 'alice',
      credentialMode: 'desktop_refresh',
    })
    expect(refreshed.accessToken).toBe('access-2')
    const refreshRequest = JSON.parse(String(request.mock.calls[1][1]?.body))
    expect(refreshRequest.refresh_token).toBe('refresh-secret')
    expect(refreshRequest.proof.split('.')).toHaveLength(3)
    const credentialPath = join(root, 'cloud-credentials.json')
    await expect(readFile(credentialPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const stored = JSON.parse(vaults.get(root)!.get('wework-cloud.identity')!)
    expect(stored).toMatchObject({
      version: 2,
      apiBaseUrl: 'https://cloud.example.com/api',
      refreshToken: 'refresh-secret',
    })
    expect(stored.privateKey).toContain('PRIVATE KEY')
  })

  test('rejects the obsolete encrypted credential format', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-cloud-credentials-'))
    roots.push(root)
    await writeFile(
      join(root, 'cloud-credentials.json'),
      JSON.stringify({
        version: 1,
        apiBaseUrl: 'https://cloud.example.com/api',
        publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
        encryptedPrivateKey: 'encrypted-private-key',
        encryptedRefreshToken: 'encrypted-refresh-token',
      }),
      { mode: 0o600 }
    )
    const request = vi.fn<typeof fetch>()
    const service = createService(root, request)

    await expect(service.refreshAccessToken('https://cloud.example.com/api')).rejects.toMatchObject(
      {
        code: 'credentials_unavailable',
      } satisfies Partial<CloudCredentialError>
    )
    expect(request).not.toHaveBeenCalled()
  })

  test('returns a legacy access token without retaining desktop credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-cloud-credentials-'))
    roots.push(root)
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'success',
          access_token: 'legacy-access',
          token_type: 'bearer',
          username: 'alice',
        }),
        { status: 200 }
      )
    )
    const service = createService(root, request)

    await service.devicePublicKey()
    const claimed = await service.claimAuthorization({
      apiBaseUrl: 'https://legacy.example.com/api',
      sessionId: 'session-1',
      pollToken: 'poll-1',
    })

    expect(claimed).toEqual({
      status: 'success',
      accessToken: 'legacy-access',
      tokenType: 'bearer',
      username: 'alice',
      credentialMode: 'legacy_access_token',
    })
    await expect(readFile(join(root, 'cloud-credentials.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  test('serializes concurrent refresh requests through one credential file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-cloud-credentials-'))
    roots.push(root)
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'success',
            access_token: 'access-1',
            refresh_token: 'refresh-secret',
          }),
          { status: 200 }
        )
      )
      .mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: 'access-2',
              token_type: 'bearer',
              expires_in: 3600,
            }),
            { status: 200 }
          )
        )
      )
    const service = createService(root, request)
    await service.devicePublicKey()
    await service.claimAuthorization({
      apiBaseUrl: 'https://cloud.example.com/api',
      sessionId: 'session-1',
      pollToken: 'poll-1',
    })

    await Promise.all([
      service.refreshAccessToken('https://cloud.example.com/api'),
      service.refreshAccessToken('https://cloud.example.com/api'),
    ])

    expect(request).toHaveBeenCalledTimes(3)
  })

  test('reports an expired desktop login on refresh 401', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-cloud-credentials-'))
    roots.push(root)
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'success',
            access_token: 'access-1',
            refresh_token: 'refresh-secret',
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: 'Desktop login has expired' }), { status: 401 })
      )
    const service = createService(root, request)
    await service.devicePublicKey()
    await service.claimAuthorization({
      apiBaseUrl: 'https://cloud.example.com/api',
      sessionId: 'session-1',
      pollToken: 'poll-1',
    })

    await expect(service.refreshAccessToken('https://cloud.example.com/api')).rejects.toMatchObject(
      {
        code: 'cloud_auth_expired',
        status: 401,
      } satisfies Partial<CloudCredentialError>
    )
  })
})

test.each(['syntax', 'key-pair'])(
  'an invalid protected cloud identity preserves the legacy recovery source: %s',
  async damage => {
    const root = await mkdtemp(join(tmpdir(), 'wework-cloud-recovery-'))
    roots.push(root)
    const service = createService(root)
    await service.devicePublicKey()
    const stored = vaults.get(root)!
    const original = stored.get('wework-cloud.identity')!
    const path = join(root, 'cloud-credentials.json')
    await writeFile(path, original)
    stored.set(
      'wework-cloud.identity',
      damage === 'syntax'
        ? '{"privateKey":"private-damaged-canary"'
        : JSON.stringify({ ...JSON.parse(original), privateKey: 'private-damaged-canary' })
    )
    await expect(service.initialize()).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(original)
  }
)

test('malformed legacy cloud credentials remain intact and parser excerpts never escape', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-cloud-recovery-'))
  roots.push(root)
  const source = 'private-legacy-canary'
  const path = join(root, 'cloud-credentials.json')
  await writeFile(path, source)
  await expect(createService(root).initialize()).rejects.toMatchObject({
    code: 'credentials_unavailable',
  })
  expect(await readFile(path, 'utf8')).toBe(source)
  try {
    await createService(root).initialize()
  } catch (error) {
    expect(String(error)).not.toContain(source)
  }
})
