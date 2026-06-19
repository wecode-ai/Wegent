import { ensureBootstrapAdminPasswordInitialized } from '../../../e2e/utils/bootstrap-admin'

function createRequest(responses: Array<{ ok: boolean; status: number; text?: string }>) {
  return {
    get: jest.fn(),
    post: jest.fn(async () => {
      const response = responses.shift()
      if (!response) {
        throw new Error('Unexpected request')
      }
      return {
        ok: () => response.ok,
        status: () => response.status,
        text: async () => response.text ?? '',
      }
    }),
  }
}

describe('E2E bootstrap admin setup helper', () => {
  it('sets the bootstrap admin password through the setup endpoint', async () => {
    const request = createRequest([{ ok: true, status: 200 }])

    await ensureBootstrapAdminPasswordInitialized(
      request,
      'http://localhost:8000',
      'secure-bootstrap-password'
    )

    expect(request.get).not.toHaveBeenCalled()
    expect(request.post).toHaveBeenCalledWith(
      'http://localhost:8000/api/auth/admin-password/setup',
      {
        data: {
          password: 'secure-bootstrap-password',
        },
      }
    )
  })

  it('continues when the bootstrap admin password is already initialized', async () => {
    const request = createRequest([
      { ok: false, status: 409, text: 'Admin password already initialized' },
    ])

    await expect(
      ensureBootstrapAdminPasswordInitialized(
        request,
        'http://localhost:8000',
        'secure-bootstrap-password'
      )
    ).resolves.toBeUndefined()
  })

  it('fails for unexpected setup errors', async () => {
    const request = createRequest([{ ok: false, status: 500, text: 'Internal Server Error' }])

    await expect(
      ensureBootstrapAdminPasswordInitialized(
        request,
        'http://localhost:8000',
        'secure-bootstrap-password'
      )
    ).rejects.toThrow('Failed to set bootstrap admin password: Internal Server Error')
  })
})
