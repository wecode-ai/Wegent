// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { createSchemeAwareUrlTransform } from '@/lib/scheme/utils/url-transform'

const transform = createSchemeAwareUrlTransform(['wegent:', 'attachment:', 'dingtalk:'])

describe('createSchemeAwareUrlTransform', () => {
  it('keeps DingTalk deep links so anchors do not fall back to the current page', () => {
    const deepLink =
      'dingtalk://dingtalkclient/action/openapp?corpid=dingd0e3&redirect_url=https%3A%2F%2Fexample.test'

    expect(transform(deepLink)).toBe(deepLink)
  })

  it('keeps in-app and web schemes', () => {
    expect(transform('wegent://modal/connector-oauth?slug=dingding_log')).toBe(
      'wegent://modal/connector-oauth?slug=dingding_log'
    )
    expect(transform('https://example.test/report?id=1')).toBe('https://example.test/report?id=1')
  })

  it('strips schemes outside the allowlist', () => {
    expect(transform('javascript:alert(1)')).toBe('')
  })
})
