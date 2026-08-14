import { describe, expect, test } from 'vitest'
import { extractFirstLink, getRecognizedLink } from './link-preview'

describe('link preview helpers', () => {
  test('extracts the first HTTP link from text', () => {
    const preview = extractFirstLink('Check out https://github.com/wecode-ai/Wegent/actions')
    expect(preview).toEqual({
      url: 'https://github.com/wecode-ai/Wegent/actions',
      domain: 'github.com',
      displayUrl: 'github.com/wecode-ai/Wegent/actions',
      iconUrl: '',
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

  test('keeps balanced parentheses in the first link', () => {
    const preview = extractFirstLink('See https://en.wikipedia.org/wiki/Foo_(bar)')
    expect(preview?.url).toBe('https://en.wikipedia.org/wiki/Foo_(bar)')
    expect(preview?.displayUrl).toBe('en.wikipedia.org/wiki/Foo_(bar)')
  })

  test('excludes angle brackets from the matched URL', () => {
    expect(extractFirstLink('<https://example.com/page>')?.url).toBe('https://example.com/page')
    expect(extractFirstLink('https://example.com/page>')?.url).toBe('https://example.com/page')
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
    expect(link?.isAbbreviated).toBe(true)
  })

  test('recognizes GitHub pull requests', () => {
    const link = getRecognizedLink('https://github.com/wecode-ai/Wegent/pull/2350')
    expect(link?.label).toBe('wecode-ai/Wegent#2350')
    expect(link?.provider).toBe('github')
    expect(link?.isAbbreviated).toBe(true)
  })

  test('recognizes GitHub issues', () => {
    const link = getRecognizedLink('https://github.com/wecode-ai/Wegent/issues/42')
    expect(link?.label).toBe('wecode-ai/Wegent#42')
    expect(link?.provider).toBe('github')
    expect(link?.isAbbreviated).toBe(true)
  })

  test('keeps the full URL for unrecognized GitHub repo sub-paths', () => {
    const link = getRecognizedLink(
      'https://github.com/wecode-ai/Wegent/actions/runs/30603861794/job/91072055935?pr=2348'
    )
    expect(link?.label).toBe(
      'https://github.com/wecode-ai/Wegent/actions/runs/30603861794/job/91072055935?pr=2348'
    )
    expect(link?.provider).toBe('github')
    expect(link?.isAbbreviated).toBe(false)
  })

  test('recognizes GitHub repositories with a trailing slash', () => {
    const link = getRecognizedLink('https://github.com/wecode-ai/Wegent/')
    expect(link?.label).toBe('wecode-ai/Wegent')
    expect(link?.provider).toBe('github')
    expect(link?.isAbbreviated).toBe(true)
  })

  test('recognizes Wegent Sites project links', () => {
    const link = getRecognizedLink('wegent-sites-project://prj_01K0')
    expect(link).toMatchObject({
      url: 'wegent-sites-project://prj_01K0',
      label: 'prj_01K0',
      provider: 'wegent-sites-project',
      iconUrl: '/plugin-icons/wework.svg',
      isAbbreviated: true,
    })
  })

  test('recognizes generic web URLs with an abbreviated label', () => {
    const link = getRecognizedLink('https://example.com/docs/page')
    expect(link?.label).toBe('example.com/docs/page')
    expect(link?.provider).toBe('web')
    expect(link?.iconUrl).toBe('')
    expect(link?.isAbbreviated).toBe(true)
    expect(link?.fullUrl).toBe('https://example.com/docs/page')
  })

  test('strips www and the root slash from generic labels', () => {
    expect(getRecognizedLink('http://www.example.com')?.label).toBe('example.com')
    expect(getRecognizedLink('https://example.com/')?.label).toBe('example.com')
  })

  test('includes query and hash in the generic label', () => {
    expect(getRecognizedLink('https://example.com/docs?q=1#section')?.label).toBe(
      'example.com/docs?q=1#section'
    )
  })

  test('keeps balanced parentheses in generic labels', () => {
    const link = getRecognizedLink('https://en.wikipedia.org/wiki/Foo_(bar)')
    expect(link?.label).toBe('en.wikipedia.org/wiki/Foo_(bar)')
    expect(link?.fullUrl).toBe('https://en.wikipedia.org/wiki/Foo_(bar)')
  })

  test('trims prose punctuation and unmatched closing brackets', () => {
    expect(getRecognizedLink('https://example.com/path.')?.label).toBe('example.com/path')
    expect(getRecognizedLink('https://example.com/path).')?.label).toBe('example.com/path')
  })

  test('keeps commas inside URL paths', () => {
    expect(getRecognizedLink('https://example.com/a,1')?.label).toBe('example.com/a,1')
  })

  test('keeps the port in the label', () => {
    const link = getRecognizedLink('http://localhost:3000/docs')
    expect(link?.label).toBe('localhost:3000/docs')
  })

  test('recognizes FQDN github URLs with a trailing-dot hostname', () => {
    const link = getRecognizedLink('https://github.com./wecode-ai/Wegent')
    expect(link?.provider).toBe('github')
    expect(link?.label).toBe('wecode-ai/Wegent')
  })

  test('prefers the GitHub recognizer for github.com URLs', () => {
    expect(getRecognizedLink('https://github.com/wecode-ai/Wegent')?.provider).toBe('github')
  })

  test('returns undefined for non-http and invalid inputs', () => {
    expect(getRecognizedLink('ftp://example.com/file')).toBeUndefined()
    expect(getRecognizedLink('example.com')).toBeUndefined()
    expect(getRecognizedLink('https://')).toBeUndefined()
    expect(getRecognizedLink('not a url')).toBeUndefined()
  })
})
