import { describe, expect, test } from 'vitest'
import { extractFirstLink, getRecognizedLink } from './link-preview'

describe('link preview helpers', () => {
  test('extracts the first HTTP link from text', () => {
    const preview = extractFirstLink('Check out https://github.com/wecode-ai/Wegent/actions')
    expect(preview).toEqual({
      url: 'https://github.com/wecode-ai/Wegent/actions',
      domain: 'github.com',
      displayUrl: 'github.com/wecode-ai/Wegent/actions',
      iconUrl: 'https://github.com/favicon.ico',
    })
  })

  test('ignores trailing punctuation', () => {
    const preview = extractFirstLink('See https://example.com/path.')
    expect(preview?.displayUrl).toBe('example.com/path')
  })

  test('strips www prefix from display domain', () => {
    const preview = extractFirstLink('Visit https://www.example.com/page')
    expect(preview?.domain).toBe('example.com')
  })

  test('returns undefined when no URL is present', () => {
    expect(extractFirstLink('Just plain text')).toBeUndefined()
  })
})

describe('recognized links', () => {
  test('recognizes GitHub repositories', () => {
    const link = getRecognizedLink('https://github.com/wecode-ai/Wegent')
    expect(link?.label).toBe('wecode-ai/Wegent')
    expect(link?.provider).toBe('github')
  })

  test('recognizes GitHub pull requests', () => {
    const link = getRecognizedLink('https://github.com/wecode-ai/Wegent/pull/2350')
    expect(link?.label).toBe('wecode-ai/Wegent#2350')
    expect(link?.provider).toBe('github')
  })

  test('recognizes GitHub issues', () => {
    const link = getRecognizedLink('https://github.com/wecode-ai/Wegent/issues/42')
    expect(link?.label).toBe('wecode-ai/Wegent#42')
    expect(link?.provider).toBe('github')
  })

  test('returns undefined for unsupported URLs', () => {
    expect(getRecognizedLink('https://example.com/page')).toBeUndefined()
  })
})
