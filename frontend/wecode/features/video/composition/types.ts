// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Composition types - 剪辑工作台相关类型定义
 */

export interface CompositionClip {
  storyboard_id: number
  clip_id: number
  order: number
  source_duration: number // seconds, source media duration used by timeline and preview
  trim_start: number // seconds, >= 0
  trim_end: number | null // null means use original video end
  volume: number // 0-1, default 1
  enabled: boolean // default true
}

export interface CompositionSubtitle {
  id: string
  storyboard_id?: number
  start: number // global timeline start in seconds
  end: number // global timeline end in seconds
  clip_local_start: number // clip-local start (from 00:00:00), used for SRT output and preview
  clip_local_end: number // clip-local end, used for SRT output and preview
  text: string
  enabled: boolean
  srt_raw?: string // original SRT block text, e.g. "1\n00:00:00,080 --> 00:00:01,725\n霞光散尽"
  regenerating?: boolean // true while subtitle regeneration is in progress
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
  volume: number // 0-1, default 0.15
  task_uuid?: string // set while regenerating
}

export type CompositionMusic =
  | { mode: 'off'; volume: 0 }
  | {
      mode: 'generated'
      prompt: string
      media_id: string
      url: string
      duration: number
      volume: number
      fade_in: number
      fade_out: number
    }
  | { mode: 'none'; volume: 0 }

export interface VideoCompositionDraft {
  id: number
  script_id: number
  task_id: number
  source_revision: string
  status: 'draft' | 'rendering' | 'rendered' | 'failed'
  clips: CompositionClip[]
  subtitles: CompositionSubtitle[]
  music: CompositionMusic
  bgm: CompositionBgm[]
  bgmEnabled: boolean
  localVersionOverride?: Record<number, number>
  preview_url?: string | null
  selected_render_id?: number | null
  create_time: string
  update_time: string
}

export interface VideoCompositionRender {
  id: number
  draft_id: number
  version_no: number
  task_uuid: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  progress: number
  media_id?: string
  video_url?: string
  cover_url?: string
  duration?: number
  error_message?: string
  create_time: string
  update_time: string
}

// API request/response types

export interface GenerateMusicRequest {
  prompt: string
  duration: number
}

export interface GenerateMusicResponse {
  task_uuid: string
  message?: string
  created_at?: string
}

export interface WbData {
  uid?: string
  id?: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  audio_url?: string
  media_id?: string
  error_message?: string | null
  progress?: number
}

export interface MusicTaskStatusResponse {
  task_uuid: string
  status?: 'pending' | 'processing' | 'completed' | 'failed'
  progress?: { stage: string; percentage: number }
  result?: {
    media_id: string
    audio_url: string
    original_audio_url?: string
    music_task_id?: string
    prompt?: string
    duration?: number
  }
  error?: string | null
  created_at?: string
  updated_at?: string
  wb_data: WbData
}

export interface RenderCompositionRequest {
  render_quality: 'preview' | 'final'
}

export interface RenderCompositionResponse {
  task_uuid: string
  render_id: number
  message: string
  created_at: string
}

// --- Save composition types ---

export interface SaveCompositionClip {
  storyboard_id: number
  clip_id: number
  trim_start: number
  trim_end: number | null
  enabled: boolean
  volume: number
  srt_text: string
}

export interface SaveCompositionBgm {
  idx: number
  start_time: number
  end_time: number
  audio_url: string
  media_id: string
  volume: number
  prompt: string
  mood: string
  style: string
}

export interface SaveCompositionRequest {
  script_id: number
  task_id: number
  clips: SaveCompositionClip[]
  bgm: SaveCompositionBgm[]
  subtitles_enabled: boolean
  bgm_enabled: boolean
}

export interface SaveCompositionResponse {
  script_id: number
  updated_clips: number
  message: string
}

// --- Subtitle regeneration types ---

export interface RegenerateSubtitlesRequest {
  clip_id: number
  script_id: number
  trim_start?: number
  trim_end?: number | null
  save_to_db?: boolean
}

export interface RegenerateSubtitlesResponse {
  task_uuid: string
}

export interface SubtitleTaskProgress {
  percentage: number
}

export interface SubtitleTaskResult {
  srt_content: string
  clip_id: number
}

export interface SubtitleTaskStatusResponse {
  task_uuid: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  progress: SubtitleTaskProgress | null
  result: SubtitleTaskResult | null
  error: string | null
}
