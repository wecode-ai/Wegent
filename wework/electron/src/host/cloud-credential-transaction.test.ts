import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { CloudCredentialService } from './cloud-credential-service.js'
import { createTestSecretProtection } from '../../test/secret-protection.js'
import { protectedCredentialDirectory } from './credential-storage-paths.js'

const protection = createTestSecretProtection()

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename) }
})

const backend = 'https://cloud.example.com/api'
const roots: string[] = []
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(finish => (resolve = finish))
  return { promise, resolve }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wework-cloud-transaction-'))
  roots.push(root)
  const request = vi.fn<typeof fetch>()
  const service = new CloudCredentialService(root, request, protection)
  const stored = async () => {
    const envelope = JSON.parse(
      await readFile(join(protectedCredentialDirectory(root), 'cloud-credentials.json'), 'utf8')
    )
    return envelope.version === 3
      ? (await protection.decrypt(envelope.ciphertext)).result
      : JSON.stringify(envelope)
  }
  async function stage(apiBaseUrl = backend, refreshToken: string | null = 'candidate-refresh') {
    const prepared = await service.prepareAuthorization(apiBaseUrl)
    request.mockResolvedValueOnce(
      json({ status: 'success', access_token: 'candidate-access', refresh_token: refreshToken })
    )
    const claimed = await service.claimAuthorization({
      authorizationId: prepared.authorizationId,
      sessionId: 'session',
      pollToken: 'poll',
    })
    expect(claimed).not.toHaveProperty('refreshToken')
    return prepared.authorizationId
  }
  await service.commitAuthorization(await stage(backend, 'active-refresh'), 7)
  const expectCleared = async () => {
    expect(
      JSON.parse(
        await readFile(join(protectedCredentialDirectory(root), 'cloud-credentials.json'), 'utf8')
      )
    ).toEqual({
      version: 3,
      ciphertext: null,
    })
    const count = request.mock.calls.length
    await expect(service.refreshAccessToken(backend, 7)).rejects.toMatchObject({
      code: 'credentials_unavailable',
    })
    expect(request).toHaveBeenCalledTimes(count)
  }
  return { root, request, service, stage, stored, expectCleared }
}

beforeEach(() => vi.clearAllMocks())
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('native cloud authorization transaction', () => {
  test.each([backend, 'https://other.example.com/api'])(
    'retains active credentials while a candidate for %s is staged and discarded',
    async candidateBackend => {
      const { service, stage, stored, request } = await fixture()
      const before = await stored()
      const candidate = await stage(candidateBackend)
      expect(await stored()).toBe(before)
      request.mockResolvedValueOnce(json({ access_token: 'active-access', expires_in: 3600 }))
      expect(await service.refreshAccessToken(backend, 7)).toMatchObject({
        accessToken: 'active-access',
      })
      expect(JSON.parse(String(request.mock.calls.at(-1)?.[1]?.body)).refresh_token).toBe(
        'active-refresh'
      )
      await service.discardAuthorization(candidate)
      await expect(service.commitAuthorization(candidate, 8)).rejects.toMatchObject({
        code: 'authorization_cancelled',
      })
      expect(await stored()).toBe(before)
    }
  )

  test('commits a same-backend candidate with its verified owner and rejects old-owner reads', async () => {
    const { service, stage, stored, request } = await fixture()
    await service.commitAuthorization(await stage(), 8)
    expect(JSON.parse(await stored())).toMatchObject({
      ownerUserId: 8,
      refreshToken: 'candidate-refresh',
    })
    const count = request.mock.calls.length
    await expect(service.refreshAccessToken(backend, 7)).rejects.toMatchObject({
      code: 'cloud_auth_expired',
    })
    expect(request).toHaveBeenCalledTimes(count)
  })

  test('a legacy candidate clears active refresh credentials only after commit', async () => {
    const { service, stage, stored, expectCleared } = await fixture()
    const before = await stored()
    const discarded = await stage(backend, null)
    expect(await stored()).toBe(before)
    await service.discardAuthorization(discarded)
    expect(await stored()).toBe(before)
    await service.commitAuthorization(await stage(backend, null), 8)
    await expectCleared()
  })

  test('invalidates an in-flight claim immediately when the next candidate starts', async () => {
    const { service, request, stored } = await fixture()
    const before = await stored()
    const prepared = await service.prepareAuthorization(backend)
    let finish!: (value: Response) => void
    request.mockImplementationOnce(() => new Promise(resolve => (finish = resolve)))
    const claim = service.claimAuthorization({
      authorizationId: prepared.authorizationId,
      sessionId: 'session',
      pollToken: 'poll',
    })
    const rejected = expect(claim).rejects.toMatchObject({ code: 'authorization_cancelled' })
    await vi.waitFor(() => expect(finish).toBeDefined())
    const next = service.prepareAuthorization(backend)
    finish(json({ status: 'success', access_token: 'late', refresh_token: 'late-refresh' }))
    await rejected
    await next
    expect(await stored()).toBe(before)
  })

  test.each(['prepare', 'clear'] as const)(
    'cancels a commit superseded by %s before rename',
    async action => {
      const { service, stage, stored, expectCleared } = await fixture()
      const before = await stored()
      const candidate = await stage()
      const entered = deferred()
      const release = deferred()
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
        await actual.writeFile(...args)
        entered.resolve()
        await release.promise
      })
      const commit = service.commitAuthorization(candidate, 8)
      const rejected = expect(commit).rejects.toMatchObject({ code: 'authorization_cancelled' })
      await entered.promise
      const next = action === 'prepare' ? service.prepareAuthorization(backend) : service.clear()
      release.resolve()
      await rejected
      await next
      if (action === 'clear') await expectCleared()
      else expect(await stored()).toBe(before)
    }
  )

  test('keeps a committed owner when the next candidate starts after rename was issued', async () => {
    const { service, stage, stored } = await fixture()
    const candidate = await stage()
    const entered = deferred()
    const release = deferred()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(rename).mockImplementationOnce(async (...args) => {
      await actual.rename(...args)
      entered.resolve()
      await release.promise
    })
    const commit = service.commitAuthorization(candidate, 8)
    await entered.promise
    const next = service.prepareAuthorization(backend)
    release.resolve()
    await commit
    await service.discardAuthorization((await next).authorizationId)
    expect(JSON.parse(await stored()).ownerUserId).toBe(8)
  })

  test('rejects a refresh queued before a credential commit instead of using the new owner token', async () => {
    const { service, stage, request } = await fixture()
    const candidate = await stage()
    const commit = service.commitAuthorization(candidate, 8)
    const refresh = service.refreshAccessToken(backend, 7)
    const rejected = expect(refresh).rejects.toMatchObject({ code: 'authorization_cancelled' })
    const count = request.mock.calls.length
    await commit
    await rejected
    expect(request).toHaveBeenCalledTimes(count)
  })

  test.each([7, 8])(
    'validates the real user before binding an unowned v2 credential (actual user %s)',
    async actualOwner => {
      const { root, service, stored, request } = await fixture()
      const credential = JSON.parse(await stored())
      delete credential.ownerUserId
      await writeFile(
        join(protectedCredentialDirectory(root), 'cloud-credentials.json'),
        JSON.stringify({
          version: 3,
          ciphertext: await protection.encrypt(JSON.stringify(credential)),
        })
      )
      request.mockResolvedValueOnce(json({ access_token: 'verified-access', expires_in: 3600 }))
      request.mockResolvedValueOnce(json({ id: actualOwner }))
      const refresh = service.refreshAccessToken(backend, 7)
      if (actualOwner === 7) {
        expect(await refresh).toMatchObject({ accessToken: 'verified-access' })
        expect(JSON.parse(await stored()).ownerUserId).toBe(7)
        request.mockResolvedValueOnce(json({ access_token: 'next-access', expires_in: 3600 }))
        expect(await service.refreshAccessToken(backend, 7)).toMatchObject({
          accessToken: 'next-access',
        })
        expect(
          request.mock.calls.filter(([url]) => String(url).endsWith('/users/me'))
        ).toHaveLength(1)
      } else {
        await expect(refresh).rejects.toMatchObject({ code: 'cloud_auth_expired' })
        expect(JSON.parse(await stored())).not.toHaveProperty('ownerUserId')
      }
      expect(request).toHaveBeenCalledWith(
        `${backend}/users/me`,
        expect.objectContaining({ headers: { Authorization: 'Bearer verified-access' } })
      )
    }
  )

  test('does not return a migrated token when disconnect interrupts its owner-binding rename', async () => {
    const { root, service, stored, request, expectCleared } = await fixture()
    const credential = JSON.parse(await stored())
    delete credential.ownerUserId
    await writeFile(
      join(protectedCredentialDirectory(root), 'cloud-credentials.json'),
      JSON.stringify({
        version: 3,
        ciphertext: await protection.encrypt(JSON.stringify(credential)),
      })
    )
    request.mockResolvedValueOnce(json({ access_token: 'verified-access', expires_in: 3600 }))
    request.mockResolvedValueOnce(json({ id: 7 }))
    const entered = deferred()
    const release = deferred()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(rename).mockImplementationOnce(async (...args) => {
      await actual.rename(...args)
      entered.resolve()
      await release.promise
    })
    const refresh = service.refreshAccessToken(backend, 7)
    const rejected = expect(refresh).rejects.toMatchObject({ code: 'authorization_cancelled' })
    await entered.promise
    const clear = service.clear()
    release.resolve()
    await rejected
    await clear
    await expectCleared()
  })
})
