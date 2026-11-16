import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { CloudCredentialError, CloudCredentialService } from './cloud-credential-service.js'

const roots: string[] = []

const electronMocks = vi.hoisted(() => ({ netFetch: vi.fn<typeof fetch>() }))

vi.mock('electron', () => ({ net: { fetch: electronMocks.netFetch } }))

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('CloudCredentialService', () => {
  beforeEach(() => {
    electronMocks.netFetch.mockReset()
  })

  test('polls the authorization session through the Chromium network stack', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-cloud-credentials-'))
    roots.push(root)
    electronMocks.netFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'pending' }), { status: 200 })
    )

    const service = new CloudCredentialService(root)
    const prepared = await service.prepareAuthorization('https://cloud.example.com/api')
    const claimed = await service.claimAuthorization({
      authorizationId: prepared.authorizationId,
      sessionId: 'session-1',
      pollToken: 'poll-1',
    })

    expect(claimed.status).toBe('pending')
    expect(electronMocks.netFetch).toHaveBeenCalledWith(
      'https://cloud.example.com/api/auth/wework/sessions/session-1/poll?poll_token=poll-1',
      { method: 'GET', signal: expect.any(AbortSignal) }
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
    const service = new CloudCredentialService(root, request)

    const prepared = await service.prepareAuthorization('https://cloud.example.com/api/')
    await service.claimAuthorization({
      authorizationId: prepared.authorizationId,
      sessionId: 'session-1',
      pollToken: 'poll-1',
    })
    await service.commitAuthorization(prepared.authorizationId, 7)

    await expect(
      service.refreshAccessToken('https://cloud.example.com/api', 7)
    ).rejects.toMatchObject({
      code: 'request_timeout',
      message: 'Cloud credential request timed out',
    } satisfies Partial<CloudCredentialError>)
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
      service.refreshAccessToken('https://cloud.example.com/api', 7)
    ).resolves.toMatchObject({ accessToken: 'access-2' })
  })

  test('stores credentials in a private file and refreshes with a device proof', async () => {
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
    const service = new CloudCredentialService(root, request)

    const prepared = await service.prepareAuthorization('https://cloud.example.com/api/')
    const publicKey = prepared.publicKey
    const claimed = await service.claimAuthorization({
      authorizationId: prepared.authorizationId,
      sessionId: 'session-1',
      pollToken: 'poll-1',
    })
    await service.commitAuthorization(prepared.authorizationId, 7)
    const refreshed = await service.refreshAccessToken('https://cloud.example.com/api', 7)

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
    const stored = JSON.parse(await readFile(credentialPath, 'utf8'))
    expect(stored).toMatchObject({
      version: 2,
      apiBaseUrl: 'https://cloud.example.com/api',
      refreshToken: 'refresh-secret',
    })
    expect(stored.privateKey).toContain('PRIVATE KEY')
    if (process.platform !== 'win32') {
      expect((await stat(credentialPath)).mode & 0o777).toBe(0o600)
    }
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
    const service = new CloudCredentialService(root, request)

    await expect(
      service.refreshAccessToken('https://cloud.example.com/api', 7)
    ).rejects.toMatchObject({
      code: 'credentials_unavailable',
    } satisfies Partial<CloudCredentialError>)
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
    const service = new CloudCredentialService(root, request)

    const prepared = await service.prepareAuthorization('https://legacy.example.com/api')
    const claimed = await service.claimAuthorization({
      authorizationId: prepared.authorizationId,
      sessionId: 'session-1',
      pollToken: 'poll-1',
    })
    await service.commitAuthorization(prepared.authorizationId, 7)

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
    const service = new CloudCredentialService(root, request)
    const prepared = await service.prepareAuthorization('https://cloud.example.com/api')
    await service.claimAuthorization({
      authorizationId: prepared.authorizationId,
      sessionId: 'session-1',
      pollToken: 'poll-1',
    })
    await service.commitAuthorization(prepared.authorizationId, 7)

    await Promise.all([
      service.refreshAccessToken('https://cloud.example.com/api', 7),
      service.refreshAccessToken('https://cloud.example.com/api', 7),
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
    const service = new CloudCredentialService(root, request)
    const prepared = await service.prepareAuthorization('https://cloud.example.com/api')
    await service.claimAuthorization({
      authorizationId: prepared.authorizationId,
      sessionId: 'session-1',
      pollToken: 'poll-1',
    })
    await service.commitAuthorization(prepared.authorizationId, 7)

    await expect(
      service.refreshAccessToken('https://cloud.example.com/api', 7)
    ).rejects.toMatchObject({
      code: 'cloud_auth_expired',
      status: 401,
    } satisfies Partial<CloudCredentialError>)
  })
})

describe('Native plugin session proof', () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'wework-native-plugin-'))
    roots.push(root)
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'success',
          access_token: 'access-secret',
          refresh_token: 'refresh-secret',
          username: 'alice',
        }),
        { status: 200 }
      )
    )
    const service = new CloudCredentialService(root, request)
    const prepared = await service.prepareAuthorization('https://cloud.example.com/api')
    await service.claimAuthorization({
      authorizationId: prepared.authorizationId,
      sessionId: 'session',
      pollToken: 'poll',
    })
    await service.commitAuthorization(prepared.authorizationId, 7)
    return { service, request }
  }
  test('proves possession for the exact plugin path after checking the current owner', async () => {
    const { service, request } = await fixture()
    const expiresAt = Math.floor(Date.now() / 1000) + 600
    request.mockResolvedValueOnce(new Response('{"id":7}')).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          account_id: 7,
          native_token: 'private-native-token',
          expires_at: expiresAt,
        })
      )
    )
    const result = await service.pluginNativeSession(
      'https://cloud.example.com/api',
      'access-secret'
    )
    expect(result).toEqual({
      backend_url: 'https://cloud.example.com',
      account_token: 'access-secret',
      native_token: 'private-native-token',
      expires_at: expiresAt,
    })
    const proofRequest = JSON.parse(String(request.mock.calls[2][1]?.body))
    expect(proofRequest.operation).toBe('session')
    expect(proofRequest.data.refresh_token).toBe('refresh-secret')
    const claims = JSON.parse(
      Buffer.from(proofRequest.data.proof.split('.')[1], 'base64url').toString()
    )
    expect(claims).toMatchObject({ htm: 'POST', htu: '/api/plugins/native-auth/exchange' })
  })
  test('keeps an older Backend on Socket when the new endpoint returns 404', async () => {
    const { service, request } = await fixture()
    request
      .mockResolvedValueOnce(new Response('{"id":7}'))
      .mockResolvedValueOnce(new Response('', { status: 404 }))
    await expect(
      service.pluginNativeSession('https://cloud.example.com/api', 'access-secret')
    ).resolves.toBeNull()
  })
  test('rejects a different owner before sending any proof or refresh token', async () => {
    const { service, request } = await fixture()
    request.mockResolvedValueOnce(new Response('{"id":8}'))
    await expect(
      service.pluginNativeSession('https://cloud.example.com/api', 'other-owner')
    ).rejects.toMatchObject({ code: 'cloud_auth_expired' })
    expect(request).toHaveBeenCalledTimes(2)
  })
})
