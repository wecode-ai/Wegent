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

  it('accepts a comment suffix and keeps the issue destination', () => {
    expect(parseWeworkIssueLink('wework://boards/12/issues/ISSUE-1/comments/comment-1')).toEqual({
      projectId: '12',
      itemId: 'ISSUE-1',
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
    ).toEqual({ projectId: '12', itemId: 'ISSUE-1' })
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

  it('builds a same-origin session bootstrap URL with a fragment token', () => {
    const url = weworkIssueBootstrapUrl(
      'https://wegent.example/',
      { projectId: '12', itemId: 'gitlab:12/issue#3' },
      'token value/+'
    )
    const parsed = new URL(url)

    expect(parsed.origin).toBe('https://wegent.example')
    expect(parsed.pathname).toBe('/mobile-web-session')
    expect(parsed.search).toBe('')
    expect(new URLSearchParams(parsed.hash.slice(1)).get('token')).toBe('token value/+')
    expect(new URLSearchParams(parsed.hash.slice(1)).get('redirect')).toBe(
      '/collaboration/12/issues/gitlab%3A12%2Fissue%233'
    )
  })
})
