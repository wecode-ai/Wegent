// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { getErrorMessageFromCode } from '@/apis/attachments'

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
