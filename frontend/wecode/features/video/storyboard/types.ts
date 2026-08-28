// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Storyboard types - 分镜相关类型定义
 */

export interface VideoClip {
  id: number
  generation_status: 0 | 1 | 2 | 3 | 9 | 10
  progress: number
  model_video_url: string
  video_cover_url: string
  media_id: string
  duration: number
  error_message: string | null
  task_uuid?: string | null // 进行中的视频生成任务UUID，用于恢复轮询
  subtitle_srt?: string // SRT format subtitles for this video clip
  volume?: number // Clip volume in composition, 0-1, default 1
}

export interface StoryboardVideoVersion extends VideoClip {
  version_no: number
  shots_prompt?: string
  visual?: string
  ff_desc?: string
  lf_desc?: string
  source?: string
  create_time: string
  created_at?: string
  createTime?: string
  is_selected: boolean
  enabled?: boolean // Whether this version is active in composition preview
  trim_start?: number | null // Trim start in seconds from backend
  trim_end?: number | null // Trim end in seconds from backend
}

export interface Storyboard {
  id: number
  shot_id: string
  sequence_number: number
  duration_seconds: number
  visual: string
  ff_desc?: string
  shots_prompt?: string
  location_id: string
  character_ids: string[]
  prop_ids: string[]
  mood: string
  camera_notes: string
  voiceover?: {
    character_id: string
    text: string
    duration_seconds: number
  }
  dialogue?: string
  audio_sfx?: string
  generation_status: 0 | 1 | 2 | 3
  risk_check_status: 0 | 1 | 2
  image_pids: string[]
  image_urls: string[]
  video_clip: VideoClip | null
  selected_video_clip_id?: number | null
  video_versions?: StoryboardVideoVersion[]
  has_pending_video_generation?: boolean
  pending_video_clip_id?: number | null
  estimated_video_credit_cost?: number | null
  task_uuid?: string | null // 进行中的任务UUID，用于恢复轮询
  create_time: string
  update_time: string
}

export interface StoryboardListResponse {
  script_id: number
  title?: string
  total: number
  storyboards: Storyboard[]
  ratio?: string
}

export interface StoryboardUpdateData {
  visual?: string
  ff_desc?: string
  shots_prompt?: string
  location_id?: string
  character_ids?: string[]
  prop_ids?: string[]
  mood?: string
  camera_notes?: string
  duration_seconds?: number
  voiceover?: {
    character_id: string
    text: string
    duration_seconds: number
  }
  dialogue?: string
  audio_sfx?: string
}

export interface TaskStatusResponse {
  task_uuid: string
  status: 'pending' | 'processing' | 'partial_ready' | 'completed' | 'failed'
  task_type?: 'single' | 'batch'
  shot_statuses?: Record<
    string,
    {
      status: 'pending' | 'processing' | 'completed' | 'failed'
      storyboard_id?: number
      clip_id?: number
      progress?: number
      error_message?: string
    }
  >
  progress?: {
    total: number
    completed: number
    failed: number
    percentage?: number
    stage?: string
  }
  result?: Record<string, unknown>
  error?: string
}

// 单分镜视频生成响应类型
export type SingleVideoGenerateResponse =
  | {
      action: 'free_generate' | 'charged_generate'
      task_uuid: string
      message: string
      created_at?: string
    }
  | {
      action: 'confirm_charge'
      message: string
      billing_token: string
      credit_cost?: number
    }
  | {
      action: 'insufficient_credits' | 'billing_error'
      message: string
      credit_cost?: number
      balance?: Record<string, unknown>
    }

// 单分镜视频生成请求参数
export interface GenerateSingleVideoParams {
  storyboard_id: number
  task_id: number
  script_id: number
  shots_prompt?: string
  model_type?: string
  confirm_charge?: boolean
  billing_token?: string
  support_charge_confirmation?: boolean
}

export interface GenerateAllVideosParams {
  task_id: number
  script_id: number
  model_type?: string
  confirm_charge?: boolean
  billing_token?: string
  support_charge_confirmation?: boolean
}
