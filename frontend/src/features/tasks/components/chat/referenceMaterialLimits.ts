// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { VideoCapabilities, VideoGenerationMode } from '@/apis/models'

export type ReferenceMaterialCounts = {
  image: number
  video: number
  audio: number
}

export type ReferenceMaterialLimits = Partial<ReferenceMaterialCounts> & {
  total?: number
}

export function normalizeReferenceMaterialLimit(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value))
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.floor(parsed))
    }
  }
  return undefined
}

export function resolveReferenceMaterialLimits(options: {
  capabilities?: VideoCapabilities
  mode?: VideoGenerationMode
  legacyImageLimit?: number
  hasReferenceVideo: boolean
}): ReferenceMaterialLimits {
  const { capabilities, mode, legacyImageLimit, hasReferenceVideo } = options
  const isKeyframeMode = mode?.id === 'first_last_frame' || mode?.id === 'keyframe'
  const globalImageLimit =
    hasReferenceVideo && capabilities?.max_reference_images_with_video != null
      ? capabilities.max_reference_images_with_video
      : capabilities?.max_reference_images

  return {
    image: normalizeReferenceMaterialLimit(
      mode?.max_images ??
        (isKeyframeMode ? mode?.max_images_first_last : undefined) ??
        globalImageLimit ??
        legacyImageLimit
    ),
    video: normalizeReferenceMaterialLimit(mode?.max_videos ?? capabilities?.max_reference_videos),
    audio: normalizeReferenceMaterialLimit(mode?.max_audios ?? capabilities?.max_reference_audios),
    total: normalizeReferenceMaterialLimit(
      mode?.max_total ?? capabilities?.max_reference_materials
    ),
  }
}

export function exceedsReferenceMaterialLimits(
  counts: ReferenceMaterialCounts,
  limits: ReferenceMaterialLimits
): boolean {
  return (
    (limits.image != null && counts.image > limits.image) ||
    (limits.video != null && counts.video > limits.video) ||
    (limits.audio != null && counts.audio > limits.audio) ||
    (limits.total != null && counts.image + counts.video + counts.audio > limits.total)
  )
}
