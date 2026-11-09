import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { CloudCredentialError, CloudCredentialService } from './cloud-credential-service.js'
import { createTestSecretProtection } from '../../test/secret-protection.js'

const protection = createTestSecretProtection()

const roots: string[] = []

const electronMocks = vi.hoisted(() => ({ netFetch: vi.fn<typeof fetch>() }))

vi.mock('electron', () => ({ net: { fetch: electronMocks.netFetch } }))

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('CloudCredentialService', () => {
  test('clears credentials without OS access while retaining v3 for compatible rollback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-cloud-credentials-'))
    roots.push(root)
    const path = join(root, 'cloud-credentials.json')
    await writeFile(
      path,
      JSON.stringify({ version: 3, ciphertext: await protection.encrypt('null') })
    )
    const unavailable = {
      encrypt: vi.fn().mockRejectedValue(new Error('OS storage unavailable')),
      decrypt: vi.fn().mockRejectedValue(new Error('OS storage unavailable')),
    }
    const service = new CloudCredentialService(root, vi.fn(), unavailable)
    await service.clear()
    const envelope = JSON.parse(await readFile(path, 'utf8'))
    expect(envelope.version).toBe(3)
    expect(envelope.ciphertext).toBeNull()
    await expect(
      service.prepareAuthorization('https://cloud.example.com/api')
    ).resolves.toMatchObject({
      publicKey: { kty: 'EC', crv: 'P-256' },
    })
    expect(unavailable.encrypt).not.toHaveBeenCalled()
    expect(unavailable.decrypt).not.toHaveBeenCalled()
  })

  beforeEach(() => {
    electronMocks.netFetch.mockReset()
  })

  test('protects a legacy plaintext credential before completing a read-only authorization preparation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-cloud-credentials-'))
    roots.push(root)
    const source = JSON.stringify({
      version: 2,
      apiBaseUrl: 'https://cloud.example.com/api',
      publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      privateKey: 'legacy-private-key',
      refreshToken: 'legacy-refresh-token',
      ownerUserId: 7,
    })
    const path = join(root, 'cloud-credentials.json')
    await writeFile(path, source)
    const request = vi.fn<typeof fetch>()
    const unavailable = new CloudCredentialService(root, request, {
      ...protection,
      encrypt: async () => {
        throw new Error('OS storage unavailable')
      },
    })
    await expect(unavailable.prepareAuthorization('https://cloud.example.com/api')).rejects.toThrow(
      'OS storage unavailable'
    )
    expect(await readFile(path, 'utf8')).toBe(source)
    await new CloudCredentialService(root, request, protection).prepareAuthorization(
      'https://cloud.example.com/api'
    )
    const raw = await readFile(path, 'utf8')
    expect(raw).not.toContain('legacy-private-key')
    expect(raw).not.toContain('legacy-refresh-token')
    const envelope = JSON.parse(raw)
    expect(envelope.version).toBe(3)
    expect(await protection.decrypt(envelope.ciphertext)).toBe(source)
    expect(request).not.toHaveBeenCalled()
  })

  test('polls the authorization session through the Chromium network stack', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-cloud-credentials-'))
    roots.push(root)
    electronMocks.netFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'pending' }), { status: 200 })
    )

    const service = new CloudCredentialService(root, undefined, protection)
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
    const service = new CloudCredentialService(root, request, protection)

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
    const service = new CloudCredentialService(root, request, protection)

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
    const raw = await readFile(credentialPath, 'utf8')
    expect(raw).not.toContain('refresh-secret')
    expect(raw).not.toContain('PRIVATE KEY')
    const envelope = JSON.parse(raw)
    expect(envelope.version).toBe(3)
    const stored = JSON.parse(await protection.decrypt(envelope.ciphertext))
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
    const service = new CloudCredentialService(root, request, protection)

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
    const service = new CloudCredentialService(root, request, protection)

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
    const service = new CloudCredentialService(root, request, protection)
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
    const service = new CloudCredentialService(root, request, protection)
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
