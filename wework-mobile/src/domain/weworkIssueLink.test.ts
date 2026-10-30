import { describe, expect, it } from 'vitest'

import {
  parseWeworkIssueLink,
  parseWeworkIssueWebUrl,
  weworkAppLinkOrigins,
  weworkIssueBootstrapUrl,
  weworkIssueWebUrl,
} from './weworkIssueLink'

describe('parseWeworkIssueLink', () => {
  it('parses the cloud board Issue scheme', () => {
    expect(parseWeworkIssueLink('wework://boards/4712514671486395195/issues/PRJBA8FC1-72')).toEqual(
      {
        projectId: '4712514671486395195',
        itemId: 'PRJBA8FC1-72',
      }
    )
  })

  it('accepts the compatible wegent scheme and encoded item ids', () => {
    expect(parseWeworkIssueLink('wegent://boards/12/issues/gitlab%3A12%2Fissue%233')).toEqual({
      projectId: '12',
      itemId: 'gitlab:12/issue#3',
    })
  })

  it('preserves the comment destination from the PC Issue scheme', () => {
    expect(parseWeworkIssueLink('wework://boards/12/issues/ISSUE-1/comments/comment-1')).toEqual({
      projectId: '12',
      itemId: 'ISSUE-1',
      commentId: 'comment-1',
    })
  })

  it('parses the HTTPS App Link handoff URL only for a trusted origin', () => {
    const input = 'https://wegent.example/open-wework?projectId=12&itemId=gitlab%3A12%2Fissue%233'

    expect(parseWeworkIssueLink(input, ['https://wegent.example'])).toEqual({
      projectId: '12',
      itemId: 'gitlab:12/issue#3',
    })
    expect(parseWeworkIssueLink(input, ['https://other.example'])).toBeNull()
  })

  it('accepts a comment query on HTTPS App Links', () => {
    expect(
      parseWeworkIssueLink(
        'https://wegent.example/open-wework?projectId=12&itemId=ISSUE-1&commentId=comment-1',
        ['https://wegent.example']
      )
    ).toEqual({ projectId: '12', itemId: 'ISSUE-1', commentId: 'comment-1' })
  })

  it('collects trusted App Link origins from the Web URL and build configuration', () => {
    const previousHost = process.env.EXPO_PUBLIC_WEWORK_APP_LINK_HOST
    process.env.EXPO_PUBLIC_WEWORK_APP_LINK_HOST = 'links.example'

    expect(weworkAppLinkOrigins('https://wegent.example/path')).toEqual([
      'https://wegent.example',
      'https://links.example',
    ])

    if (previousHost === undefined) delete process.env.EXPO_PUBLIC_WEWORK_APP_LINK_HOST
    else process.env.EXPO_PUBLIC_WEWORK_APP_LINK_HOST = previousHost
  })

  it.each([
    'wework://tasks/device/task',
    'wework://boards/12',
    'wework://boards/12/issues/',
    'wework://boards/12/issues/ISSUE-1/comments/',
    'wework://boards/12/issues/ISSUE-1/comments/%ZZ',
    'wework://boards/12/issues/ISSUE-1?redirect=https://evil.test',
    'wework://user@boards/12/issues/ISSUE-1',
    'wework://boards/12/issues/%ZZ',
    'https://wegent.example/open-wework?projectId=12',
    'https://wegent.example/open-wework?projectId=12&itemId=ISSUE-1&redirect=https://evil.test',
    'https://wegent.example/open-wework?projectId=12&itemId=ISSUE-1&itemId=ISSUE-2',
    'https://wegent.example/open-wework?projectId=12&itemId=ISSUE-1&commentId=..',
    'https://wegent.example/open-wework?projectId=0&itemId=ISSUE-1',
    'https://wegent.example/other?projectId=12&itemId=ISSUE-1',
  ])('rejects unsupported destinations: %s', input => {
    expect(parseWeworkIssueLink(input, ['https://wegent.example'])).toBeNull()
  })
})

describe('weworkIssueWebUrl', () => {
  it('builds the mobile collaboration Issue route', () => {
    expect(
      weworkIssueWebUrl('https://wegent.example/', {
        projectId: '12',
        itemId: 'gitlab:12/issue#3',
      })
    ).toBe('https://wegent.example/collaboration/12/issues/gitlab%3A12%2Fissue%233')
  })

  it('returns the web destination only for a supported Issue link', () => {
    expect(
      parseWeworkIssueWebUrl('wework://boards/12/issues/ISSUE-1', 'https://wegent.example/')
    ).toBe('https://wegent.example/collaboration/12/issues/ISSUE-1')
    expect(
      parseWeworkIssueWebUrl('wework://tasks/device/task', 'https://wegent.example')
    ).toBeNull()
  })

  it('preserves an encoded comment and repeat focus request through the WebView route', () => {
    const input = 'wework://boards/12/issues/ISSUE-1/comments/comment%2F%231'
    const issue = parseWeworkIssueLink(input)
    expect(issue).toEqual({ projectId: '12', itemId: 'ISSUE-1', commentId: 'comment/#1' })
    const url = new URL(
      weworkIssueWebUrl('https://wegent.example', { ...issue!, focusRequest: 'mobile-2' })
    )
    expect(url.pathname).toBe('/collaboration/12/issues/ISSUE-1')
    expect(url.searchParams.get('commentId')).toBe('comment/#1')
    expect(url.searchParams.get('focusRequest')).toBe('mobile-2')
  })

  it('builds a public bootstrap URL without credentials and preserves comment focus', () => {
    const url = weworkIssueBootstrapUrl('https://wegent.example/', {
      projectId: '12',
      itemId: 'gitlab:12/issue#3',
      commentId: 'comment-1',
      focusRequest: 'mobile-1',
    })
    const parsed = new URL(url)

    expect(parsed.origin).toBe('https://wegent.example')
    expect(parsed.pathname).toBe('/mobile-web-session')
    expect(parsed.hash).toBe('')
    expect([...parsed.searchParams.keys()]).toEqual(['redirect'])
    expect(parsed.searchParams.get('redirect')).toBe(
      '/collaboration/12/issues/gitlab%3A12%2Fissue%233?commentId=comment-1&focusRequest=mobile-1'
    )
  })
})
