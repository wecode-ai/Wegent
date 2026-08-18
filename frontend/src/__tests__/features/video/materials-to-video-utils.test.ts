// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  materialId,
  materialImageUrl,
  materialVideoUrl,
  timelineTracks,
  updateTrack,
} from '@/features/video/materials_to_video/utils'

describe('material-to-video utilities', () => {
  test('uses stable material identifiers and preferred previews', () => {
    const material = {
      attachment_media_id: 'media-7',
      cover_url: 'https://example.com/cover.jpg',
      attachment_video_url: 'https://example.com/video.mp4',
    }

    expect(materialId(material)).toBe('media-7')
    expect(materialImageUrl(material)).toBe('https://example.com/cover.jpg')
    expect(materialVideoUrl(material)).toBe('https://example.com/video.mp4')
  })

  test('maps persisted timeline fields without dropping auxiliary tracks', () => {
    const record = {
      session_id: '25',
      task_id: 'plan-1',
      video_tracks: [{ clip_id: 'clip-1' }],
      subtitle_tracks: [{ text: 'hello' }],
      voiceover_tracks: [{ path: 'voice.wav' }],
      bgm_tracks: [{ path: 'music.wav' }],
      source_audio_tracks: [{ path: 'source.wav' }],
      mg_tracks: [{ path: 'motion.mp4' }],
      sticker_tracks: [{ path: 'sticker.png' }],
      transition_tracks: [{ name: 'fade' }],
    }

    expect(timelineTracks(record)).toEqual({
      video: [{ clip_id: 'clip-1' }],
      subtitles: [{ text: 'hello' }],
      voiceover: [{ path: 'voice.wav' }],
      bgm: [{ path: 'music.wav' }],
      source_audio: [{ path: 'source.wav' }],
      mg: [{ path: 'motion.mp4' }],
      stickers: [{ path: 'sticker.png' }],
      transitions: [{ name: 'fade' }],
    })
  })

  test('updates a timeline field immutably', () => {
    const track = { clip_id: 'clip-1', keep_audio: false }
    const updated = updateTrack(track, 'keep_audio', true)

    expect(updated).toEqual({ clip_id: 'clip-1', keep_audio: true })
    expect(track.keep_audio).toBe(false)
  })
})
