// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export function getAigcVideoPlaybackUrl(videoUrl: string, shareToken?: string): string {
  try {
    const hostname = new URL(videoUrl).hostname.toLowerCase()
    if (hostname === 'weibocdn.com' || hostname.endsWith('.weibocdn.com')) {
      const query = new URLSearchParams({ video_url: videoUrl })
      if (shareToken) query.set('share_token', shareToken)
      return `/api/aigc-video/media/playback?${query}`
    }
  } catch {
    return videoUrl
  }
  return videoUrl
}

export function getAigcVideoImageUrl(imageUrl?: string, shareToken?: string): string | undefined {
  if (!imageUrl) return undefined
  try {
    const hostname = new URL(imageUrl).hostname.toLowerCase()
    if (
      hostname === 'sinaimg.cn' ||
      hostname.endsWith('.sinaimg.cn') ||
      hostname === 'weibocdn.com' ||
      hostname.endsWith('.weibocdn.com')
    ) {
      const query = new URLSearchParams({ image_url: imageUrl })
      if (shareToken) query.set('share_token', shareToken)
      return `/api/aigc-video/media/image?${query}`
    }
  } catch {
    return imageUrl
  }
  return imageUrl
}
