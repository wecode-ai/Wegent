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

  it('adds the task share token to proxied video and image URLs', () => {
    const video = 'https://f.video.weibocdn.com/o0/shared-video'
    const image = 'https://wx1.sinaimg.cn/large/shared-image.jpg'
    const videoQuery = new URLSearchParams({ video_url: video, share_token: 'shared-token' })
    const imageQuery = new URLSearchParams({ image_url: image, share_token: 'shared-token' })

    expect(getAigcVideoPlaybackUrl(video, 'shared-token')).toBe(
      `/api/aigc-video/media/playback?${videoQuery}`
    )
    expect(getAigcVideoImageUrl(image, 'shared-token')).toBe(
      `/api/aigc-video/media/image?${imageQuery}`
    )
  })

  it('routes Sina image CDN URLs through the image proxy', () => {
    const source = 'https://wx1.sinaimg.cn/large/example.jpg'

    expect(getAigcVideoImageUrl(source)).toBe(
      `/api/aigc-video/media/image?image_url=${encodeURIComponent(source)}`
    )
  })

  it('routes Weibo video CDN covers through the image proxy', () => {
    const source = 'https://f.video.weibocdn.com/cover.jpg'

    expect(getAigcVideoImageUrl(source)).toBe(
      `/api/aigc-video/media/image?image_url=${encodeURIComponent(source)}`
    )
  })
})
