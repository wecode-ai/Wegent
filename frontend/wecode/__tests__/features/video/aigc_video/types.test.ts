// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  getAigcVideoImageUrl,
  getAigcVideoPlaybackUrl,
} from '@wecode/features/video/aigc_video/mediaUrls'

describe('getAigcVideoPlaybackUrl', () => {
  it('routes Weibo CDN videos through the signed playback endpoint', () => {
    const source = 'http://f.video.weibocdn.com/o0/example'

    expect(getAigcVideoPlaybackUrl(source)).toBe(
      `/api/aigc-video/media/playback?video_url=${encodeURIComponent(source)}`
    )
  })

  it('keeps non-Weibo video URLs unchanged', () => {
    const source = 'https://media.example.com/video.mp4'

    expect(getAigcVideoPlaybackUrl(source)).toBe(source)
  })

  it('routes Weibo CDN covers through the image proxy', () => {
    const source = 'https://wx1.sinaimg.cn/large/example.jpg'

    expect(getAigcVideoImageUrl(source)).toBe(
      `/api/aigc-video/media/image?image_url=${encodeURIComponent(source)}`
    )
  })
})
