// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type {
  MaterialTimelineRecord,
  MaterialTimelineTracks,
  TimelineTrack,
  VideoMaterialItem,
} from './types'

export function materialId(material: VideoMaterialItem, index = 0): string {
  const candidates = [
    material.id,
    material.material_id,
    material.clip_id,
    material.attachment_media_id,
    material.media_id,
    material.pic_id,
  ]
  const id = candidates
    .map(candidate => String(candidate ?? '').trim())
    .find(candidate => candidate.length > 0)
  return id || `material-${index}`
}

export function materialImageUrl(material: VideoMaterialItem): string | undefined {
  return [
    material.thumbnail_url,
    material.cover_url,
    material.attachment_image_url,
    material.attachment_source_image_url,
    material.pic_urls?.[0],
  ].find(value => typeof value === 'string' && value.length > 0)
}

export function materialVideoUrl(material: VideoMaterialItem): string | undefined {
  return [
    material.video_url,
    material.attachment_video_url,
    material.attachment_source_video_url,
    material.attachment_url,
    material.attachment_source_url,
    material.attachment_fallback_url,
  ].find(value => typeof value === 'string' && value.length > 0)
}

function trackList(value: unknown): TimelineTrack[] {
  return Array.isArray(value)
    ? value.filter((item): item is TimelineTrack => Boolean(item) && typeof item === 'object')
    : []
}

export function timelineTracks(record: MaterialTimelineRecord): MaterialTimelineTracks {
  return {
    video: trackList(record.video_tracks),
    subtitles: trackList(record.subtitle_tracks),
    voiceover: trackList(record.voiceover_tracks),
    bgm: trackList(record.bgm_tracks),
    source_audio: trackList(record.source_audio_tracks),
    mg: trackList(record.mg_tracks),
    stickers: trackList(record.sticker_tracks),
    transitions: trackList(record.transition_tracks),
  }
}

export function updateTrack<T extends TimelineTrack>(track: T, key: string, value: unknown): T {
  return { ...track, [key]: value }
}

export function milliseconds(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
}
