import {
  buildBootstrapAdminUser,
  buildE2EAdminUser,
  buildStorageState,
  getJwtExpiryMs,
} from '../../../e2e/utils/auth-state'

function createJwt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url')
  return `${header}.${payload}.signature`
}

describe('E2E auth state helpers', () => {
  it('builds an isolated admin user from the shard index', () => {
    const user = buildE2EAdminUser({
      E2E_SHARD_INDEX: '4',
      E2E_ADMIN_PASSWORD: 'secure-shard-admin',
    })

    expect(user).toEqual({
      username: 'e2e-admin-shard-4',
      password: 'secure-shard-admin',
      role: 'admin',
      description: 'Isolated admin user for E2E shard 4',
    })
  })

  it('falls back to the bootstrap admin when isolated users are disabled', () => {
    const user = buildE2EAdminUser({
      E2E_USE_ISOLATED_USERS: 'false',
      E2E_SHARD_INDEX: '2',
      E2E_BOOTSTRAP_ADMIN_PASSWORD: 'secure-bootstrap-admin',
    })

    expect(user.username).toBe('admin')
    expect(user.password).toBe('secure-bootstrap-admin')
    expect(user.role).toBe('admin')
  })

  it('requires explicit bootstrap admin password env', () => {
    expect(() => buildBootstrapAdminUser({})).toThrow(
      'Missing required environment variable: E2E_BOOTSTRAP_ADMIN_PASSWORD'
    )
  })

  it('requires explicit isolated admin password env', () => {
    expect(() => buildE2EAdminUser({ E2E_SHARD_INDEX: '1' })).toThrow(
      'Missing required environment variable: E2E_ADMIN_PASSWORD'
    )
  })

  it('writes auth token, expiry, and cookie into Playwright storage state', () => {
    const token = createJwt(1_700_000_000)
    const expiryMs = getJwtExpiryMs(token)
    const storageState = buildStorageState('http://localhost:3000', token, expiryMs)

    expect(storageState.origins).toEqual([
      {
        origin: 'http://localhost:3000',
        localStorage: [
          { name: 'auth_token', value: token },
          { name: 'auth_token_expire', value: '1700000000000' },
        ],
      },
    ])
    expect(storageState.cookies).toEqual([
      expect.objectContaining({
        name: 'auth_token',
        value: token,
        domain: 'localhost',
        path: '/',
        sameSite: 'Lax',
      }),
    ])
  })
})
