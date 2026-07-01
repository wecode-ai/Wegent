import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, createHttpClient } from '@/api/http'
import { ADMIN_PASSWORD_SETUP_REQUIRED_ERROR_CODE } from '@/features/auth/adminPasswordSetup'
import { CloudConnectionProvider } from './CloudConnectionProvider'
import { useCloudConnection } from './useCloudConnection'

const httpMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}))

vi.mock('@/api/http', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/http')>()
  return {
    ...actual,
    createHttpClient: vi.fn(() => ({
      get: httpMocks.get,
      post: httpMocks.post,
      put: vi.fn(),
      delete: vi.fn(),
    })),
  }
})

function CloudConnectProbe({ onError }: { onError: (error: unknown) => void }) {
  const cloud = useCloudConnection()
  return (
    <button
      type="button"
      data-testid="connect-cloud-button"
      onClick={async () => {
        try {
          await cloud.connectWithPassword('https://cloud.example.com', {
            user_name: 'admin',
            password: 'password',
          })
        } catch (error) {
          onError(error)
        }
      }}
    >
      connect
    </button>
  )
}

describe('CloudConnectionProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reports the failing cloud connection stage when health cannot reach backend', async () => {
    const onError = vi.fn()
    httpMocks.get.mockRejectedValueOnce(new Error('url not allowed on the configured scope'))

    render(
      <CloudConnectionProvider>
        <CloudConnectProbe onError={onError} />
      </CloudConnectionProvider>
    )

    await userEvent.click(screen.getByTestId('connect-cloud-button'))

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    const error = onError.mock.calls[0][0]
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('健康检查失败')
    expect((error as Error).message).toContain('HTTP 权限拦截')
    expect(httpMocks.post).not.toHaveBeenCalled()
  })

  it('preserves the admin setup ApiError so the dialog can switch forms', async () => {
    const onError = vi.fn()
    const setupRequiredError = new ApiError(
      'Admin password setup required',
      400,
      ADMIN_PASSWORD_SETUP_REQUIRED_ERROR_CODE,
      { admin_username: 'root' }
    )
    httpMocks.get.mockResolvedValueOnce({ status: 'healthy' })
    httpMocks.post.mockRejectedValueOnce(setupRequiredError)

    render(
      <CloudConnectionProvider>
        <CloudConnectProbe onError={onError} />
      </CloudConnectionProvider>
    )

    await userEvent.click(screen.getByTestId('connect-cloud-button'))

    await waitFor(() => expect(onError).toHaveBeenCalledWith(setupRequiredError))
    expect(createHttpClient).toHaveBeenCalled()
  })
})
