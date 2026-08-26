// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  hasGeneratingStoryboardClip,
  hasPendingStoryboardGeneration,
  hasReadyStoryboardVideos,
  hasSuccessfulSelectedStoryboardVersion,
} from '@wecode/features/video/storyboard/generationAvailability'
import type { Storyboard, StoryboardVideoVersion } from '@wecode/features/video/storyboard/types'

function version(
  id: number,
  generationStatus: StoryboardVideoVersion['generation_status'],
  selected: boolean,
  videoUrl = ''
): StoryboardVideoVersion {
  return {
    id,
    version_no: id,
    generation_status: generationStatus,
    progress: 0,
    model_video_url: videoUrl,
    video_cover_url: '',
    media_id: '',
    duration: 5,
    error_message: null,
    create_time: '2026-07-14T00:00:00Z',
    is_selected: selected,
  }
}

function storyboard(id: number, versions: StoryboardVideoVersion[]): Storyboard {
  return {
    id,
    shot_id: `shot-${id}`,
    sequence_number: id - 1,
    duration_seconds: 5,
    visual: '',
    location_id: '',
    character_ids: [],
    prop_ids: [],
    mood: '',
    camera_notes: '',
    generation_status: 2,
    risk_check_status: 0,
    image_pids: [],
    image_urls: [],
    video_clip: null,
    video_versions: versions,
    create_time: '2026-07-14T00:00:00Z',
    update_time: '2026-07-14T00:00:00Z',
  }
}

describe('storyboard generation availability', () => {
  it('allows composition when at least one selected version succeeded', () => {
    const storyboards = [
      storyboard(1, [version(11, 3, true, 'https://example.com/1.mp4')]),
      storyboard(2, [version(21, 2, true)]),
    ]

    expect(hasSuccessfulSelectedStoryboardVersion(storyboards, { 1: 11, 2: 21 })).toBe(true)
  })

  it('does not allow composition when no selected version succeeded', () => {
    const storyboards = [storyboard(1, [version(11, 9, true)]), storyboard(2, [])]

    expect(hasSuccessfulSelectedStoryboardVersion(storyboards, { 1: 11 })).toBe(false)
  })

  it('allows composition when at least one storyboard has a ready selected video', () => {
    const ready = storyboard(1, [version(11, 3, true, 'https://example.com/1.mp4')])
    const pending = storyboard(2, [version(21, 2, true)])

    expect(hasReadyStoryboardVideos([ready])).toBe(true)
    expect(hasReadyStoryboardVideos([ready, pending])).toBe(true)
    expect(hasReadyStoryboardVideos([pending])).toBe(false)
    expect(hasReadyStoryboardVideos([])).toBe(false)
  })

  it('does not compose a disabled selected storyboard video', () => {
    const disabled = storyboard(1, [version(11, 3, true, 'https://example.com/1.mp4')])
    disabled.video_versions![0].enabled = false

    expect(hasReadyStoryboardVideos([disabled])).toBe(false)
  })

  it('allows generate-all when any storyboard is pending', () => {
    const pendingStoryboard = storyboard(2, [version(21, 2, true)])
    pendingStoryboard.has_pending_video_generation = true

    expect(
      hasPendingStoryboardGeneration([storyboard(1, [version(11, 2, true)]), pendingStoryboard])
    ).toBe(true)
  })

  it('detects a generating clip even when it is not the selected version', () => {
    const item = storyboard(1, [
      version(11, 3, true, 'https://example.com/1.mp4'),
      version(12, 2, false),
    ])

    expect(hasGeneratingStoryboardClip(item)).toBe(true)
  })
})
