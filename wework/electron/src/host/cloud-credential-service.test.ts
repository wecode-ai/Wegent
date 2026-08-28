import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { CloudCredentialError, CloudCredentialService } from './cloud-credential-service.js'

const roots: string[] = []

const encryption = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
  decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ''),
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('CloudCredentialService', () => {
  test('stores only encrypted secrets and refreshes with a device proof', async () => {
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
    const service = new CloudCredentialService(root, encryption, request)

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
    const stored = await readFile(join(root, 'cloud-credentials.json'), 'utf8')
    expect(stored).not.toContain('refresh-secret')
    expect(stored).not.toContain('PRIVATE KEY')
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
    const service = new CloudCredentialService(root, encryption, request)

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
    const service = new CloudCredentialService(root, encryption, request)
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
    const service = new CloudCredentialService(root, encryption, request)
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
