// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export interface CompositionClip {
  storyboard_id: number
  clip_id: number
  order: number
  source_duration: number
  trim_start: number
  trim_end: number | null
  volume: number
  enabled: boolean
  video_url: string
  cover_url: string
  title: string
}

export interface CompositionSubtitle {
  id: string
  storyboard_id: number
  start: number
  end: number
  clip_local_start: number
  clip_local_end: number
  text: string
  enabled: boolean
}

export interface CompositionBgm {
  idx: number
  start_time: number
  end_time: number
  mood: string
  style: string
  prompt: string
  status: 'success' | 'pending' | 'failed' | 'draft'
  audio_url: string
  media_id: string
  volume: number
  task_uuid?: string
}

export interface SaveCompositionRequest {
  script_id: number
  task_id: number
  clips: Array<{
    storyboard_id: number
    clip_id: number
    trim_start: number
    trim_end: number | null
    enabled: boolean
    volume: number
    srt_text: string
  }>
  bgm: Array<{
    idx: number
    start_time: number
    end_time: number
    audio_url: string
    media_id: string
    volume: number
    prompt: string
    mood: string
    style: string
  }>
  subtitles_enabled: boolean
  bgm_enabled: boolean
}

export interface SaveCompositionResponse {
  script_id: number
  updated_clips: number
  message: string
}

export interface MusicTaskStatusResponse {
  task_uuid: string
  status?: 'pending' | 'processing' | 'completed' | 'failed'
  progress?: { stage: string; percentage: number }
  result?: {
    media_id: string
    audio_url: string
    prompt?: string
    duration?: number
  }
  error?: string | null
  wb_data?: {
    status: 'pending' | 'processing' | 'completed' | 'failed'
    audio_url?: string
    media_id?: string
    error_message?: string | null
    progress?: number
  }
}

export interface SubtitleTaskStatusResponse {
  task_uuid: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  progress: { percentage: number } | null
  result: { srt_content: string; clip_id: number } | null
  error: string | null
}
