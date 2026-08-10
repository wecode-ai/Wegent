// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  exceedsReferenceMaterialLimits,
  normalizeReferenceMaterialLimit,
  resolveReferenceMaterialLimits,
} from '@/features/tasks/components/chat/referenceMaterialLimits'

describe('referenceMaterialLimits', () => {
  it('normalizes numeric and string limits', () => {
    expect(normalizeReferenceMaterialLimit(2.9)).toBe(2)
    expect(normalizeReferenceMaterialLimit('3')).toBe(3)
    expect(normalizeReferenceMaterialLimit('invalid')).toBeUndefined()
  })

  it('uses the reduced image limit when a reference video exists', () => {
    const withoutVideo = resolveReferenceMaterialLimits({
      capabilities: {
        max_reference_images: 4,
        max_reference_images_with_video: 1,
      },
      hasReferenceVideo: false,
    })
    const withVideo = resolveReferenceMaterialLimits({
      capabilities: {
        max_reference_images: 4,
        max_reference_images_with_video: 1,
      },
      hasReferenceVideo: true,
    })

    expect(withoutVideo.image).toBe(4)
    expect(withVideo.image).toBe(1)
  })

  it('uses keyframe limits only for keyframe modes', () => {
    expect(
      resolveReferenceMaterialLimits({
        mode: { id: 'first_last_frame', label: '首尾帧', max_images_first_last: 2 },
        hasReferenceVideo: false,
      }).image
    ).toBe(2)
    expect(
      resolveReferenceMaterialLimits({
        mode: { id: 'reference', label: '参考素材', max_images_first_last: 2 },
        capabilities: { max_reference_images: 5 },
        hasReferenceVideo: false,
      }).image
    ).toBe(5)
  })

  it('checks per-type and total limits', () => {
    const limits = { image: 2, video: 1, audio: 1, total: 3 }

    expect(exceedsReferenceMaterialLimits({ image: 1, video: 1, audio: 1 }, limits)).toBe(false)
    expect(exceedsReferenceMaterialLimits({ image: 2, video: 1, audio: 1 }, limits)).toBe(true)
  })
})
