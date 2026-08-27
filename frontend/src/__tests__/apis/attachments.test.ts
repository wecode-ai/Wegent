// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  createAttachmentDownloadUrl,
  downloadAttachment,
  fetchAttachmentFile,
  formatsToAcceptString,
  getAttachmentPlayback,
  getErrorMessageFromCode,
} from '@/apis/attachments'

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

describe('getAttachmentPlayback', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    localStorage.clear()
    jest.restoreAllMocks()
  })

  it('returns direct playback metadata for an authenticated attachment', async () => {
    localStorage.setItem('auth_token', 'test-token')
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        playback_url: 'https://media.example.com/material.mp4',
        cover_url: 'https://media.example.com/material-cover.jpg',
      }),
    }) as typeof fetch

    await expect(getAttachmentPlayback(42)).resolves.toEqual({
      playback_url: 'https://media.example.com/material.mp4',
      cover_url: 'https://media.example.com/material-cover.jpg',
    })
    expect(global.fetch).toHaveBeenCalledWith('/api/attachments/42/playback', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
    })
  })

  it('uses the share token without an authorization header', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        playback_url: '/api/attachments/42/download?share_token=share-token',
      }),
    }) as typeof fetch

    await getAttachmentPlayback(42, 'share-token')

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/attachments/42/playback?share_token=share-token',
      {
        method: 'GET',
        headers: {},
      }
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
