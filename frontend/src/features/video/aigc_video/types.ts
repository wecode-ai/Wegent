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

export function parseAigcVideoCardData(value: Record<string, unknown>): AigcVideoCardData {
  return value as AigcVideoCardData
}
