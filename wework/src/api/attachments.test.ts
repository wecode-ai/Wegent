import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createAttachmentApi, deleteAttachment, uploadAttachment } from './attachments'

const originalCreateObjectUrl = URL.createObjectURL

const httpMocks = vi.hoisted(() => ({
  createHttpClient: vi.fn(),
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
}))

function mockClient(overrides = {}) {
  return {
    get: vi.fn(),
    getBlob: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  }
}

describe('attachment API', () => {
  beforeEach(() => {
    httpMocks.createHttpClient.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    URL.createObjectURL = originalCreateObjectUrl
  })

  test('uploads through XMLHttpRequest and preserves progress in Electron', async () => {
    const response = {
      id: 7,
      filename: 'image.png',
      file_size: 5,
      mime_type: 'image/png',
      status: 'ready',
      text_length: null,
      error_message: null,
      error_code: null,
    }
    const open = vi.fn()
    const send = vi.fn(function (this: XMLHttpRequest) {
      this.upload.dispatchEvent(
        new ProgressEvent('progress', { lengthComputable: true, loaded: 5, total: 5 })
      )
      Object.defineProperty(this, 'status', { configurable: true, value: 200 })
      Object.defineProperty(this, 'responseText', {
        configurable: true,
        value: JSON.stringify(response),
      })
      this.dispatchEvent(new Event('load'))
    })
    class XMLHttpRequestMock extends EventTarget {
      upload = new EventTarget()
      status = 0
      responseText = ''
      open = open
      send = send
      setRequestHeader = vi.fn()
    }
    vi.stubGlobal('XMLHttpRequest', XMLHttpRequestMock)
    URL.createObjectURL = vi.fn(() => 'blob:uploaded-image-preview')
    const progress = vi.fn()
    const file = new File(['image'], 'image.png', { type: 'image/png' })

    const attachment = await uploadAttachment(file, progress)

    expect(open).toHaveBeenCalledWith('POST', '/api/attachments/upload')
    expect(send).toHaveBeenCalledWith(expect.any(FormData))
    expect((send.mock.calls[0][0] as FormData).get('file')).toBe(file)
    expect(progress).toHaveBeenCalledOnce()
    expect(progress).toHaveBeenCalledWith(100)
    expect(attachment).toMatchObject({
      id: 7,
      filename: 'image.png',
      file_extension: '.png',
      local_preview_url: 'blob:uploaded-image-preview',
      subtask_id: null,
    })
    expect(URL.createObjectURL).toHaveBeenCalledWith(file)
  })

  test('deletes through the shared HTTP client', async () => {
    const deleteRequest = vi.fn().mockResolvedValue(undefined)
    httpMocks.createHttpClient.mockReturnValue(mockClient({ delete: deleteRequest }))

    await deleteAttachment(12)

    expect(httpMocks.createHttpClient).toHaveBeenCalledWith({
      baseUrl: '/api',
      getToken: expect.any(Function),
    })
    expect(deleteRequest).toHaveBeenCalledWith('/attachments/12')
  })

  test('downloads through the configured backend client', async () => {
    const blob = new Blob(['image'], { type: 'image/png' })
    const getBlob = vi.fn().mockResolvedValue(blob)
    httpMocks.createHttpClient.mockReturnValue(mockClient({ getBlob }))
    const getToken = vi.fn(() => 'cloud-token')

    const result = await createAttachmentApi({
      apiBaseUrl: 'https://cloud.example.com/api',
      getToken,
    }).fetchAttachmentBlob(42)

    expect(httpMocks.createHttpClient).toHaveBeenCalledWith({
      baseUrl: 'https://cloud.example.com/api',
      getToken,
    })
    expect(getBlob).toHaveBeenCalledWith('/attachments/42/download')
    expect(result).toBe(blob)
  })
})
