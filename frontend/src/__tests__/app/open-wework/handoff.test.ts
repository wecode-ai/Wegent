// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { parseWeworkHandoff } from '@/app/open-wework/handoff'

describe('parseWeworkHandoff', () => {
  it('constructs fixed Wework and web routes for an issue comment', () => {
    const params = new URLSearchParams({
      projectId: '12',
      itemId: 'gitlab:12/issue#3',
      commentId: '3f/9',
    })

    expect(parseWeworkHandoff(params)).toEqual({
      weworkUrl: 'wework://boards/12/issues/gitlab%3A12%2Fissue%233/comments/3f%2F9',
      webPath: '/collaboration/12/issues/gitlab%3A12%2Fissue%233',
    })
  })

  it('supports a board destination without an issue', () => {
    expect(parseWeworkHandoff(new URLSearchParams('projectId=12'))).toEqual({
      weworkUrl: 'wework://boards/12',
      webPath: '/collaboration/12',
    })
  })

  it('accepts a validated encoded Smart app route for the client handoff', () => {
    expect(parseWeworkHandoff(new URLSearchParams({ url: 'wework://smart-apps/42' }))).toEqual({
      weworkUrl: 'wework://smart-apps/42',
    })
  })

  it('accepts a registered DSH app route without inventing a web fallback', () => {
    expect(parseWeworkHandoff(new URLSearchParams({ url: 'wework://apps/wegent' }))).toEqual({
      weworkUrl: 'wework://apps/wegent',
    })
  })

  it('accepts interaction keys up to the protocol request-key limit', () => {
    const requestKey = 'r'.repeat(129)
    expect(
      parseWeworkHandoff(
        new URLSearchParams({
          url: `wework://interactions/device/task/${encodeURIComponent(requestKey)}`,
        })
      )
    ).toEqual({
      weworkUrl: `wework://interactions/device/task/${encodeURIComponent(requestKey)}`,
    })
  })

  it.each([
    '',
    'projectId=0',
    'projectId=01',
    'projectId=12&itemId=',
    'projectId=12&itemId=..',
    'projectId=12&itemId=%00',
    'projectId=12&commentId=c-1',
    'projectId=12&itemId=x&commentId=.',
    'projectId=12&itemId=x&redirect=https%3A%2F%2Fevil.test',
    'projectId=12&projectId=13',
    'url=javascript%3Aalert%281%29',
    'url=https%3A%2F%2Fevil.test',
    'url=WEWORK%3A%2F%2Fapps%2Fwegent',
    'url=wework%3A%2F%2Fsmart-apps%2F0',
    'url=wework%3A%2F%2Fapps%2Fa%2Fb',
    'url=wework%3A%2F%2Fboards%2F12%2F%252E%252E%2F13',
    'url=wework%3A%2F%2Fapps%2Fwegent&projectId=12',
  ])('rejects invalid or ambiguous destination: %s', query => {
    expect(parseWeworkHandoff(new URLSearchParams(query))).toBeNull()
  })

  it('keeps scheme-looking identifiers inside a path segment', () => {
    expect(
      parseWeworkHandoff(
        new URLSearchParams({ projectId: '12', itemId: 'wework://tasks/device/task' })
      )
    ).toEqual({
      weworkUrl: 'wework://boards/12/issues/wework%3A%2F%2Ftasks%2Fdevice%2Ftask',
      webPath: '/collaboration/12/issues/wework%3A%2F%2Ftasks%2Fdevice%2Ftask',
    })
  })
})
