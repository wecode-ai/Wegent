// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type GenerationStatus = 0 | 1 | 2 | 3 | 9 | 10

export interface VideoClip {
  id: number
  generation_status: GenerationStatus
  progress: number
  model_video_url: string
  video_cover_url: string
  media_id: string
  duration: number
  error_message: string | null
  task_uuid?: string | null
  subtitle_srt?: string
  volume?: number
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
  is_selected: boolean
  enabled?: boolean
  trim_start?: number | null
  trim_end?: number | null
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
  task_uuid?: string | null
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
  error?: string
}

export type VideoGenerateResponse =
  | {
      action: 'free_generate' | 'charged_generate'
      task_uuid: string
      message: string
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
    }

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
