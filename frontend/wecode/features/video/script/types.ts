// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export interface ScriptGlobalStyle {
  visual_style?: string
  mood?: string
  video_style?: string
  bgm_enabled?: boolean
  subtitle_enabled?: boolean
}

export interface ScriptBgmItem {
  idx: number
  start_time: number
  end_time: number
  mood: string
  style: string
  prompt: string
  status: 'success' | 'pending' | 'failed' | 'draft'
  audio_url: string
  media_id: string
  volume?: number
}

export interface FinalVideoCover {
  clip_id: number
  cover_time_in_source: number
  cover_url?: string
  generation_status?: 'pending' | 'processing' | 'completed' | 'failed'
  generation_task_uuid?: string
  generation_error?: string
  source?: string
  updated_at?: string
}

export interface ScriptDetail {
  script_id: number
  task_id: number
  title: string
  global_style?: ScriptGlobalStyle
  bgm?: ScriptBgmItem[]
  final_video_cover?: FinalVideoCover | null
}
