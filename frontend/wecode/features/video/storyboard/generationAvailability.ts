// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Storyboard, StoryboardVideoVersion } from './types'

function getSelectedVersion(
  storyboard: Storyboard,
  selectedClipId?: number
): StoryboardVideoVersion | null {
  const versions = storyboard.video_versions ?? []
  const targetId = selectedClipId ?? storyboard.selected_video_clip_id

  if (targetId != null) {
    const selected = versions.find(item => item.id === targetId)
    if (selected) return selected
  }

  return versions.find(item => item.is_selected) ?? versions[0] ?? null
}

export function hasSuccessfulSelectedStoryboardVersion(
  storyboards: Storyboard[],
  selectedVersionMap: Record<number, number>
): boolean {
  return storyboards.some(storyboard => {
    const version = getSelectedVersion(storyboard, selectedVersionMap[storyboard.id])
    return version?.generation_status === 3 && Boolean(version.model_video_url)
  })
}

export function hasReadyStoryboardVideos(storyboards: Storyboard[]): boolean {
  return storyboards.some(storyboard => {
    const version = getSelectedVersion(storyboard)
    return (
      version?.generation_status === 3 &&
      Boolean(version.model_video_url) &&
      version.enabled !== false
    )
  })
}

export function hasPendingStoryboardGeneration(storyboards: Storyboard[]): boolean {
  return storyboards.some(storyboard => Boolean(storyboard.has_pending_video_generation))
}

export function hasGeneratingStoryboardClip(storyboard: Storyboard | null): boolean {
  if (!storyboard) return false

  const versions = storyboard.video_versions ?? []
  if (
    versions.some(version => version.generation_status === 1 || version.generation_status === 2)
  ) {
    return true
  }

  return (
    storyboard.video_clip?.generation_status === 1 || storyboard.video_clip?.generation_status === 2
  )
}
