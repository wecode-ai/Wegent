import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { deleteAttachment, uploadAttachment } from './attachments'

const httpMocks = vi.hoisted(() => ({
  createHttpClient: vi.fn(),
  shouldUseTauriFetch: vi.fn(),
}))

vi.mock('@/config/runtime', () => ({
  getRuntimeConfig: () => ({
    appBasePath: '',
    apiBaseUrl: '/api',
    socketBaseUrl: '',
    socketPath: '/socket.io',
    loginMode: 'all',
    oidcLoginText: '',
    cloudDeviceScalingWikiUrl: '',
  }),
}))

vi.mock('./http', () => ({
  createHttpClient: httpMocks.createHttpClient,
  shouldUseTauriFetch: httpMocks.shouldUseTauriFetch,
}))

function mockClient(overrides = {}) {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  }
}

describe('attachment API', () => {
  beforeEach(() => {
    httpMocks.createHttpClient.mockReset()
    httpMocks.shouldUseTauriFetch.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('uploads through the platform HTTP client in Tauri to avoid WebView CORS', async () => {
    const post = vi.fn().mockResolvedValue({
      id: 7,
      filename: 'image.png',
      file_size: 5,
      mime_type: 'image/png',
      status: 'ready',
      text_length: null,
      error_message: null,
      error_code: null,
    })
    httpMocks.shouldUseTauriFetch.mockReturnValue(true)
    httpMocks.createHttpClient.mockReturnValue(mockClient({ post }))
    const progress = vi.fn()
    const file = new File(['image'], 'image.png', { type: 'image/png' })

    const attachment = await uploadAttachment(file, progress)

    expect(httpMocks.createHttpClient).toHaveBeenCalledWith({ baseUrl: '/api' })
    expect(post).toHaveBeenCalledWith('/attachments/upload', expect.any(FormData))
    expect((post.mock.calls[0][1] as FormData).get('file')).toBe(file)
    expect(progress).toHaveBeenNthCalledWith(1, 0)
    expect(progress).toHaveBeenNthCalledWith(2, 100)
    expect(attachment).toMatchObject({
      id: 7,
      filename: 'image.png',
      file_extension: '.png',
      subtask_id: null,
    })
  })

  test('deletes through the shared HTTP client', async () => {
    const deleteRequest = vi.fn().mockResolvedValue(undefined)
    httpMocks.createHttpClient.mockReturnValue(mockClient({ delete: deleteRequest }))

    await deleteAttachment(12)

    expect(httpMocks.createHttpClient).toHaveBeenCalledWith({ baseUrl: '/api' })
    expect(deleteRequest).toHaveBeenCalledWith('/attachments/12')
  })
})
