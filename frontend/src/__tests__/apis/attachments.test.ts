// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  createAttachmentDownloadUrl,
  downloadAttachment,
  fetchAttachmentFile,
  formatsToAcceptString,
  getErrorMessageFromCode,
  getWeiboChunkUploadError,
  isVideoFileName,
  uploadFile,
  uploadVideoToWeibo,
} from '@/apis/attachments'

class MockXMLHttpRequest {
  static instances: MockXMLHttpRequest[] = []
  static activeCount = 0
  static maxActiveCount = 0

  upload = {
    addEventListener: (type: string, listener: (event: ProgressEvent) => void) => {
      this.uploadListeners[type] = listener
    },
  }

  status = 200
  responseText = '{}'
  aborted = false
  sent = false
  requestUrl = ''
  private listeners: Record<string, () => void> = {}
  private uploadListeners: Record<string, (event: ProgressEvent) => void> = {}

  constructor() {
    MockXMLHttpRequest.instances.push(this)
  }

  open(_method: string, url: string) {
    this.requestUrl = url
  }

  setRequestHeader() {}

  send() {
    this.sent = true
    MockXMLHttpRequest.activeCount++
    MockXMLHttpRequest.maxActiveCount = Math.max(
      MockXMLHttpRequest.maxActiveCount,
      MockXMLHttpRequest.activeCount
    )
  }

  addEventListener(type: string, listener: () => void) {
    this.listeners[type] = listener
  }

  abort() {
    if (!this.aborted) {
      this.aborted = true
      if (this.sent) {
        MockXMLHttpRequest.activeCount = Math.max(0, MockXMLHttpRequest.activeCount - 1)
      }
      this.listeners.abort?.()
    }
  }

  complete(response: Record<string, unknown>, status = 200) {
    this.status = status
    this.responseText = JSON.stringify(response)
    MockXMLHttpRequest.activeCount = Math.max(0, MockXMLHttpRequest.activeCount - 1)
    this.uploadListeners.progress?.({
      lengthComputable: true,
      loaded: 1,
      total: 1,
    } as ProgressEvent)
    this.listeners.load?.()
  }

  fail(status = 500) {
    this.complete({ request_id: `failed-${this.chunkIndex}` }, status)
  }

  get chunkIndex() {
    return Number(new URL(this.requestUrl).searchParams.get('chunkindex'))
  }
}

const waitForCondition = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (condition()) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('Condition was not met')
}

describe('formatsToAcceptString', () => {
  it('uses MIME types so the system file picker filters by model formats', () => {
    expect(formatsToAcceptString(['jpeg', 'jpg', 'png'], 'image/*')).toBe('image/jpeg,image/png')
  })
})

describe('fetchAttachmentFile', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    localStorage.setItem('auth_token', 'test-token')
  })

  afterEach(() => {
    global.fetch = originalFetch
    localStorage.clear()
    jest.clearAllMocks()
  })

  it('fetches a protected attachment as a named File', async () => {
    const signal = new AbortController().signal
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        'Content-Type': 'application/pdf',
        'Content-Disposition': "attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf",
      }),
      blob: async () => new Blob(['pdf-data'], { type: 'application/pdf' }),
    })
    global.fetch = fetchMock as typeof fetch

    const file = await fetchAttachmentFile(42, { signal })

    expect(fetchMock).toHaveBeenCalledWith('/api/attachments/42/download', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
      signal,
    })
    expect(file).toBeInstanceOf(File)
    expect(file.name).toBe('报告.pdf')
    expect(file.type).toBe('application/pdf')
  })

  it('uses the caller-provided filename and omits JWT for share access', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/octet-stream' }),
      blob: async () => new Blob(['office-data']),
    })
    global.fetch = fetchMock as typeof fetch

    const file = await fetchAttachmentFile(9, {
      filename: 'source.docx',
      shareToken: 'share-token',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/attachments/9/download?share_token=share-token',
      expect.objectContaining({ headers: {} })
    )
    expect(file.name).toBe('source.docx')
  })

  it('rejects failed attachment responses', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers(),
    }) as typeof fetch

    await expect(fetchAttachmentFile(404)).rejects.toThrow('Failed to fetch attachment (404)')
  })
})

describe('downloadAttachment', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    localStorage.clear()
    jest.restoreAllMocks()
  })

  it('uses a short-lived token for browser-native streaming downloads', async () => {
    localStorage.setItem('auth_token', 'test-token')
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation()
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ download_token: 'short-lived-token' }),
    }) as typeof fetch

    await downloadAttachment(42, 'report.pdf')

    expect(global.fetch).toHaveBeenCalledWith('/api/attachments/42/download-token', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    })
    expect(click).toHaveBeenCalledTimes(1)
    expect(click.mock.instances[0]).toMatchObject({
      href: expect.stringContaining(
        '/api/attachments/42/download?download_token=short-lived-token'
      ),
      download: 'report.pdf',
    })
  })
})

describe('createAttachmentDownloadUrl', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    localStorage.clear()
    jest.restoreAllMocks()
  })

  it('returns a browser-native URL with a short-lived token', async () => {
    localStorage.setItem('auth_token', 'test-token')
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ download_token: 'playback-token' }),
    }) as typeof fetch

    await expect(createAttachmentDownloadUrl(42)).resolves.toBe(
      '/api/attachments/42/download?download_token=playback-token'
    )
  })
})

describe('getErrorMessageFromCode', () => {
  // Mock translation function
  const mockT = jest.fn((key: string, params?: Record<string, unknown>) => {
    const translations: Record<string, string> = {
      'attachment.errors.unsupported_type': 'Unsupported file format',
      'attachment.errors.unsupported_type_hint': `Please upload files in these formats: ${params?.types || ''}`,
      'attachment.errors.file_too_large': 'File is too large',
      'attachment.errors.file_too_large_hint': `File size cannot exceed ${params?.size || ''} MB`,
      'attachment.errors.parse_failed': 'Failed to parse file',
      'attachment.errors.parse_failed_hint': 'The file may be corrupted',
      'attachment.errors.encrypted_pdf': 'Cannot parse encrypted file',
      'attachment.errors.encrypted_pdf_hint': 'Please remove PDF password protection',
      'attachment.errors.legacy_doc': 'Outdated file format',
      'attachment.errors.legacy_doc_hint': 'Please save as .docx format',
      'attachment.errors.legacy_ppt': 'Outdated file format',
      'attachment.errors.legacy_ppt_hint': 'Please save as .pptx format',
      'attachment.errors.legacy_xls': 'Outdated file format',
      'attachment.errors.legacy_xls_hint': 'Please save as .xlsx format',
      'attachment.supported_types': 'PDF, Word, Excel',
    }
    return translations[key] || key
  })

  it('should return undefined for null error code', () => {
    const result = getErrorMessageFromCode(null, mockT)
    expect(result).toBeUndefined()
  })

  it('should return undefined for undefined error code', () => {
    const result = getErrorMessageFromCode(undefined, mockT)
    expect(result).toBeUndefined()
  })

  it('should return undefined for unknown error code', () => {
    const result = getErrorMessageFromCode('unknown_error', mockT)
    expect(result).toBeUndefined()
  })

  it('should return localized message for unsupported_type error', () => {
    const result = getErrorMessageFromCode('unsupported_type', mockT)
    expect(result).toBeDefined()
    expect(result).toContain('Unsupported file format')
  })

  it('should return localized message for encrypted_pdf error', () => {
    const result = getErrorMessageFromCode('encrypted_pdf', mockT)
    expect(result).toBeDefined()
    expect(result).toContain('Cannot parse encrypted file')
    expect(result).toContain('password protection')
  })

  it('should return localized message for legacy_doc error', () => {
    const result = getErrorMessageFromCode('legacy_doc', mockT)
    expect(result).toBeDefined()
    expect(result).toContain('Outdated file format')
    expect(result).toContain('.docx')
  })

  it('should return localized message for legacy_ppt error', () => {
    const result = getErrorMessageFromCode('legacy_ppt', mockT)
    expect(result).toBeDefined()
    expect(result).toContain('Outdated file format')
    expect(result).toContain('.pptx')
  })

  it('should return localized message for legacy_xls error', () => {
    const result = getErrorMessageFromCode('legacy_xls', mockT)
    expect(result).toBeDefined()
    expect(result).toContain('Outdated file format')
    expect(result).toContain('.xlsx')
  })

  it('should return localized message for parse_failed error', () => {
    const result = getErrorMessageFromCode('parse_failed', mockT)
    expect(result).toBeDefined()
    expect(result).toContain('Failed to parse file')
  })

  it('should return localized message for file_too_large error', () => {
    const result = getErrorMessageFromCode('file_too_large', mockT)
    expect(result).toBeDefined()
    expect(result).toContain('File is too large')
    expect(result).toContain('100')
  })
})

describe('uploadFile', () => {
  const originalBlobArrayBuffer = Blob.prototype.arrayBuffer

  beforeAll(() => {
    Blob.prototype.arrayBuffer = function arrayBuffer() {
      return Promise.resolve(new ArrayBuffer(this.size))
    }
  })

  afterAll(() => {
    Blob.prototype.arrayBuffer = originalBlobArrayBuffer
  })

  beforeEach(() => {
    MockXMLHttpRequest.instances = []
    MockXMLHttpRequest.activeCount = 0
    MockXMLHttpRequest.maxActiveCount = 0
    global.XMLHttpRequest = MockXMLHttpRequest as unknown as typeof XMLHttpRequest
  })

  afterEach(() => {
    localStorage.clear()
    jest.restoreAllMocks()
  })

  it('uploads ordinary Chat video through Weibo and saves its fid', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          file_token: 'file-token',
          chunk_size: 10,
          auth: 'auth-token',
          request_id: 'init-request',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 42,
          filename: 'clip.mp4',
          file_size: 5,
          mime_type: 'video/mp4',
          status: 'ready',
          type_data: { storage_backend: 'weibo', fid: 12345 },
        }),
      })
    global.fetch = fetchMock as typeof fetch

    const file = new File(['video'], 'clip.mp4', { type: 'video/mp4' })
    const resultPromise = uploadFile(file)

    await waitForCondition(() => MockXMLHttpRequest.instances.some(xhr => xhr.sent))
    const request = MockXMLHttpRequest.instances[0]
    expect(request.requestUrl).toContain('fileplatform.api.weibo.com')

    request.complete({
      fid: '12345',
      request_id: 'upload-request',
    })

    await expect(resultPromise).resolves.toMatchObject({
      id: 42,
      filename: 'clip.mp4',
      type_data: { storage_backend: 'weibo', fid: 12345 },
    })
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/attachments/weibo-init',
      expect.objectContaining({ method: 'POST' })
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/attachments/upload-video-metadata',
      expect.objectContaining({
        body: expect.stringContaining('"fid":12345'),
        method: 'POST',
      })
    )
  })

  it('marks video model materials for reference storage', async () => {
    const file = new File(['video'], 'reference.mp4', { type: 'video/mp4' })
    const resultPromise = uploadFile(file, undefined, undefined, 'video_reference')

    const request = MockXMLHttpRequest.instances[0]
    expect(request.requestUrl).toBe('/api/attachments/upload?storage_purpose=video_reference')

    request.complete({
      id: 43,
      filename: 'reference.mp4',
      file_size: file.size,
      mime_type: 'video/mp4',
      status: 'ready',
    })

    await expect(resultPromise).resolves.toMatchObject({ id: 43 })
  })
})

describe('video helpers', () => {
  it('detects supported video filenames case-insensitively', () => {
    expect(isVideoFileName('demo.MP4')).toBe(true)
    expect(isVideoFileName('demo.txt')).toBe(false)
  })
})

describe('getWeiboChunkUploadError', () => {
  it('returns null for successful or unspecified business status', () => {
    expect(getWeiboChunkUploadError({ succ: true, request_id: 'req-1' })).toBeNull()
    expect(getWeiboChunkUploadError({ request_id: 'req-1' })).toBeNull()
  })

  it('returns business error details when Weibo returns succ false', () => {
    expect(
      getWeiboChunkUploadError({
        succ: false,
        request_id: 'req-1',
        errmsg: 'section check mismatch',
      })
    ).toBe('section check mismatch')
  })
})

describe('uploadVideoToWeibo', () => {
  const originalBlobArrayBuffer = Blob.prototype.arrayBuffer

  beforeAll(() => {
    Blob.prototype.arrayBuffer = function arrayBuffer() {
      return Promise.resolve(new ArrayBuffer(this.size))
    }
  })

  afterAll(() => {
    Blob.prototype.arrayBuffer = originalBlobArrayBuffer
  })

  beforeEach(() => {
    MockXMLHttpRequest.instances = []
    MockXMLHttpRequest.activeCount = 0
    MockXMLHttpRequest.maxActiveCount = 0
    global.XMLHttpRequest = MockXMLHttpRequest as unknown as typeof XMLHttpRequest
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        file_token: 'file-token',
        chunk_size: 2,
        auth: 'auth-token',
        request_id: 'init-request',
      }),
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('uploads video chunks concurrently and uses the response containing fid', async () => {
    const file = new File(['0123456789'], 'demo.mp4', { type: 'video/mp4' })
    const onProgress = jest.fn()

    const resultPromise = uploadVideoToWeibo(file, onProgress)

    await waitForCondition(() => MockXMLHttpRequest.instances.filter(xhr => xhr.sent).length === 3)
    expect(MockXMLHttpRequest.maxActiveCount).toBe(3)

    MockXMLHttpRequest.instances
      .find(xhr => xhr.chunkIndex === 1)
      ?.complete({
        request_id: 'req-1',
      })
    MockXMLHttpRequest.instances
      .find(xhr => xhr.chunkIndex === 2)
      ?.complete({
        request_id: 'req-2',
      })
    MockXMLHttpRequest.instances
      .find(xhr => xhr.chunkIndex === 3)
      ?.complete({
        request_id: 'req-3',
      })

    await waitForCondition(() => MockXMLHttpRequest.instances.filter(xhr => xhr.sent).length === 5)

    MockXMLHttpRequest.instances
      .find(xhr => xhr.chunkIndex === 5)
      ?.complete({
        request_id: 'req-5',
      })
    MockXMLHttpRequest.instances
      .find(xhr => xhr.chunkIndex === 4)
      ?.complete({
        fid: '12345',
        request_id: 'req-final',
        url: 'https://video.example/demo.mp4',
      })

    await expect(resultPromise).resolves.toEqual({
      fid: 12345,
      request_id: 'req-final',
      url: 'https://video.example/demo.mp4',
    })
    expect(MockXMLHttpRequest.maxActiveCount).toBeLessThanOrEqual(3)
    expect(onProgress).toHaveBeenLastCalledWith(100)
  })

  it('fails when all chunks finish without a fid response', async () => {
    const file = new File(['0123'], 'demo.mp4', { type: 'video/mp4' })
    const resultPromise = uploadVideoToWeibo(file)

    await waitForCondition(() => MockXMLHttpRequest.instances.filter(xhr => xhr.sent).length === 2)
    MockXMLHttpRequest.instances.forEach((xhr, index) => {
      xhr.complete({ request_id: `req-${index}` })
    })

    await expect(resultPromise).rejects.toThrow('Upload completed but no fid returned')
  })

  it('retries a failed chunk without failing the whole upload', async () => {
    const setTimeoutSpy = jest
      .spyOn(global, 'setTimeout')
      .mockImplementation((callback: TimerHandler) => {
        if (typeof callback === 'function') {
          callback()
        }
        return 0 as unknown as ReturnType<typeof setTimeout>
      })
    const file = new File(['0123'], 'demo.mp4', { type: 'video/mp4' })

    const resultPromise = uploadVideoToWeibo(file)

    await waitForCondition(() => MockXMLHttpRequest.instances.filter(xhr => xhr.sent).length === 2)
    MockXMLHttpRequest.instances.find(xhr => xhr.chunkIndex === 1)?.fail()

    await waitForCondition(() => MockXMLHttpRequest.instances.length === 3)
    const retriedChunk = MockXMLHttpRequest.instances[2]
    expect(retriedChunk.chunkIndex).toBe(1)

    retriedChunk.complete({ request_id: 'req-1-retry' })
    MockXMLHttpRequest.instances
      .find(xhr => xhr.chunkIndex === 2)
      ?.complete({
        fid: '67890',
        request_id: 'req-final',
      })

    await expect(resultPromise).resolves.toEqual({
      fid: 67890,
      request_id: 'req-final',
      url: '',
    })
    setTimeoutSpy.mockRestore()
  })

  it('cancels in-flight chunk uploads when the caller aborts', async () => {
    const file = new File(['0123456789'], 'demo.mp4', { type: 'video/mp4' })
    const abortController = new AbortController()
    const resultPromise = uploadVideoToWeibo(file, undefined, abortController.signal)

    await waitForCondition(() => MockXMLHttpRequest.instances.filter(xhr => xhr.sent).length === 3)
    abortController.abort()

    await expect(resultPromise).rejects.toThrow('Upload cancelled')
    expect(MockXMLHttpRequest.instances.filter(xhr => xhr.aborted)).toHaveLength(3)
  })

  it('does not send chunk data after aborting before arrayBuffer resolves', async () => {
    const originalArrayBuffer = Blob.prototype.arrayBuffer
    let resolveSendBuffer: ((value: ArrayBuffer) => void) | null = null
    let arrayBufferCallCount = 0
    Blob.prototype.arrayBuffer = jest.fn().mockImplementation(function arrayBuffer(this: Blob) {
      arrayBufferCallCount++
      if (arrayBufferCallCount < 3) {
        return Promise.resolve(new ArrayBuffer(this.size))
      }
      return new Promise<ArrayBuffer>(resolve => {
        resolveSendBuffer = resolve
      })
    })

    const file = new File(['01'], 'demo.mp4', { type: 'video/mp4' })
    const abortController = new AbortController()
    const resultPromise = uploadVideoToWeibo(file, undefined, abortController.signal)

    await waitForCondition(() => MockXMLHttpRequest.instances.length === 1)
    await waitForCondition(() => resolveSendBuffer !== null)
    abortController.abort()
    ;(resolveSendBuffer as unknown as (value: ArrayBuffer) => void)(new ArrayBuffer(2))

    await expect(resultPromise).rejects.toThrow('Upload cancelled')
    expect(MockXMLHttpRequest.instances[0].sent).toBe(false)
    Blob.prototype.arrayBuffer = originalArrayBuffer
  })
})
