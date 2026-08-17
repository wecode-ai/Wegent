// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { usesVideoReferenceStorage } from '@/features/video/teamModeSpec'
import type { Team } from '@/types/api'

function teamWithCategories(categories: string[]): Team {
  return {
    id: 57,
    name: 'video-agent',
    mode_spec: { allowedModelCategories: categories },
  } as Team
}

describe('usesVideoReferenceStorage', () => {
  it('uses reference storage for a video-aware chat agent', () => {
    expect(usesVideoReferenceStorage('chat', teamWithCategories(['video']))).toBe(true)
  })

  it('uses default storage for ordinary chat agents', () => {
    expect(usesVideoReferenceStorage('chat', teamWithCategories([]))).toBe(false)
  })

  it('always uses reference storage in video mode', () => {
    expect(usesVideoReferenceStorage('video', null)).toBe(true)
  })
})
