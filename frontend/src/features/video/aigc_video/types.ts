// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export interface AigcVideoButton {
  button_id?: string
  button_name: string
  button_type?: 'chat' | 'link'
  prompt?: string
  link?: string
}

export interface AigcVideoCardData {
  title?: string
  created_time?: string
  link?: string
  preview_type?: 'script' | 'entity' | 'storyboard' | string
  preview_content?: { text?: string }
  progress_text?: string
  buttons?: AigcVideoButton[]
  video_url?: string
  cover_url?: string
  duration?: number
}

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
    if (
      hostname === 'sinaimg.cn' ||
      hostname.endsWith('.sinaimg.cn') ||
      hostname === 'weibocdn.com' ||
      hostname.endsWith('.weibocdn.com')
    ) {
      return `/api/aigc-video/media/image?image_url=${encodeURIComponent(imageUrl)}`
    }
  } catch {
    return imageUrl
  }
  return imageUrl
}

export function parseAigcVideoCardData(value: Record<string, unknown>): AigcVideoCardData {
  return value as AigcVideoCardData
}
