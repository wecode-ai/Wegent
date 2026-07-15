// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { fetchAttachmentFile, getErrorMessageFromCode } from '@/apis/attachments'

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
