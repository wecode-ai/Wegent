// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export function getAigcVideoPlaybackUrl(videoUrl: string): string {
  try {
    const hostname = new URL(videoUrl).hostname.toLowerCase()
    if (hostname === 'weibocdn.com' || hostname.endsWith('.weibocdn.com')) {
      return `/api/aigc-video/media/playback?video_url=${encodeURIComponent(videoUrl)}`
    }
  } catch {
    return videoUrl
  }
  return videoUrl
}

export function getAigcVideoImageUrl(imageUrl?: string): string | undefined {
  if (!imageUrl) return undefined
  try {
    const hostname = new URL(imageUrl).hostname.toLowerCase()
    if (hostname === 'weibocdn.com' || hostname.endsWith('.weibocdn.com')) {
      return `/api/aigc-video/media/image?image_url=${encodeURIComponent(imageUrl)}`
    }
  } catch {
    return imageUrl
  }
  return imageUrl
}
