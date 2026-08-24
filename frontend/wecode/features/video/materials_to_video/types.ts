// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export interface MaterialVideoButton {
  button_id?: string
  button_name: string
  button_type?: string
}

export interface NarrativeFrameworkResponse {
  session_id: string
  task_uuid: string
  content: {
    markdown: string
  }
  buttons?: MaterialVideoButton[]
  confirmed?: boolean
  created_time?: string
  updated_time?: string
}

export interface VideoMaterialItem {
  id?: string | number
  material_id?: string | number
  clip_id?: string | number
  media_id?: string | number
  pic_id?: string | number
  type?: 'image' | 'video' | 'text' | string
  title?: string
  text?: string
  content?: string
  author?: string
  reason?: string
  thumbnail_url?: string
  cover_url?: string
  pic_urls?: string[]
  video_url?: string
  attachment_url?: string
  attachment_image_url?: string
  attachment_video_url?: string
  attachment_source_url?: string
  attachment_source_image_url?: string
  attachment_source_video_url?: string
  attachment_fallback_url?: string
  attachment_media_id?: string | number
  [key: string]: unknown
}

export interface MaterialSearchResponse {
  session_id: string
  task_uuid: string
  title?: string
  selection_status?: 'searching' | 'pending' | 'selected' | 'failed'
  materials: VideoMaterialItem[]
  selected_material_ids?: string[]
  selected_materials?: VideoMaterialItem[]
  selected_count?: number
  error_message?: string | null
  buttons?: MaterialVideoButton[]
}

export type TimelineTrack = Record<string, unknown>

export interface MaterialTimelineRecord {
  id?: number
  session_id: string
  task_id: string
  video_tracks?: TimelineTrack[]
  subtitle_tracks?: TimelineTrack[]
  voiceover_tracks?: TimelineTrack[]
  bgm_tracks?: TimelineTrack[]
  source_audio_tracks?: TimelineTrack[]
  mg_tracks?: TimelineTrack[]
  sticker_tracks?: TimelineTrack[]
  transition_tracks?: TimelineTrack[]
  create_time?: string
  update_time?: string
}

export interface MaterialTimelineResponse {
  session_id: string
  tracks: MaterialTimelineRecord[]
  total: number
}

export interface MaterialTimelineTracks {
  video: TimelineTrack[]
  subtitles: TimelineTrack[]
  voiceover: TimelineTrack[]
  bgm: TimelineTrack[]
  source_audio: TimelineTrack[]
  mg: TimelineTrack[]
  stickers: TimelineTrack[]
  transitions: TimelineTrack[]
}
