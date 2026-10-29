import { describe, expect, it } from 'vitest'

import { parseWeworkIssueLink, parseWeworkIssueWebUrl, weworkIssueWebUrl } from './weworkIssueLink'

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

  it.each([
    'wework://tasks/device/task',
    'wework://boards/12',
    'wework://boards/12/issues/',
    'wework://boards/12/issues/ISSUE-1/comments/c-1',
    'wework://boards/12/issues/ISSUE-1?redirect=https://evil.test',
    'wework://user@boards/12/issues/ISSUE-1',
    'wework://boards/12/issues/%ZZ',
  ])('rejects unsupported destinations: %s', input => {
    expect(parseWeworkIssueLink(input)).toBeNull()
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
})
