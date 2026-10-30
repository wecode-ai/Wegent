// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  isDingTalkUserAgent,
  isMobileUserAgent,
  parseWeworkHandoff,
  weworkLaunchUrls,
} from '@/app/open-wework/handoff'

describe('parseWeworkHandoff', () => {
  it('constructs fixed Wework and web routes for an issue comment', () => {
    const params = new URLSearchParams({
      projectId: '12',
      itemId: 'gitlab:12/issue#3',
      commentId: '3f/9',
    })

    expect(parseWeworkHandoff(params)).toEqual({
      weworkUrl: 'wework://boards/12/issues/gitlab%3A12%2Fissue%233/comments/3f%2F9',
      webPath: '/collaboration/12/issues/gitlab%3A12%2Fissue%233?commentId=3f%2F9',
    })
  })

  it('supports a board destination without an issue', () => {
    expect(parseWeworkHandoff(new URLSearchParams('projectId=12'))).toEqual({
      weworkUrl: 'wework://boards/12',
      webPath: '/collaboration/12',
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

  it('uses the mobile Wework scheme with a desktop fallback on phones', () => {
    const weworkUrl = 'wework://boards/12/issues/ISSUE-1'

    expect(
      weworkLaunchUrls(
        weworkUrl,
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15'
      )
    ).toEqual({
      primary: weworkUrl,
      fallback: 'wegent://boards/12/issues/ISSUE-1',
    })
    expect(
      weworkLaunchUrls(weworkUrl, 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36')
    ).toEqual({
      primary: 'wegent://boards/12/issues/ISSUE-1',
      fallback: weworkUrl,
    })
    expect(weworkLaunchUrls(weworkUrl, 'Mozilla/5.0 (Macintosh)')).toEqual({
      primary: weworkUrl,
    })
  })

  it('detects phone and tablet user agents only', () => {
    expect(isMobileUserAgent('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)')).toBe(true)
    expect(isMobileUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false)
  })

  it('detects DingTalk mobile in-app browsers', () => {
    expect(
      isDingTalkUserAgent(
        'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 AliApp(DingTalk/7.6.0)'
      )
    ).toBe(true)
    expect(isDingTalkUserAgent('Mozilla/5.0 (Linux; Android 15) Chrome/140.0.0.0')).toBe(false)
  })
})
