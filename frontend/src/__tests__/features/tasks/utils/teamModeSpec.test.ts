// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  getVideoParamVisibility,
  teamHidesVideoParam,
  teamUsesModeSpecCategory,
  usesVideoReferenceStorage,
} from '@/features/tasks/utils/teamModeSpec'
import type { Team } from '@/types/api'

const minuteVideoTeam = {
  id: 1,
  name: 'workflow-video-team',
  mode_spec: {
    allowedModelCategories: ['video'],
    hiddenVideoParams: ['duration', 'generation_mode'],
  },
} as unknown as Team

describe('teamModeSpec', () => {
  it('exposes only the configured video category', () => {
    expect(teamUsesModeSpecCategory(minuteVideoTeam, 'video')).toBe(true)
    expect(teamUsesModeSpecCategory(minuteVideoTeam, 'llm')).toBe(false)
    expect(teamUsesModeSpecCategory(minuteVideoTeam, 'image')).toBe(false)
  })

  it('hides configured workflow-owned video controls', () => {
    expect(teamHidesVideoParam(minuteVideoTeam, 'duration')).toBe(true)
    expect(teamHidesVideoParam(minuteVideoTeam, 'generation_mode')).toBe(true)
    expect(teamHidesVideoParam(minuteVideoTeam, 'ratio')).toBe(false)
    expect(teamHidesVideoParam(minuteVideoTeam, 'resolution')).toBe(false)
  })

  it('resolves workflow-owned video control visibility', () => {
    expect(getVideoParamVisibility(['duration', 'model', 'ratio'])).toEqual({
      showModel: false,
      showRatio: false,
      showDuration: false,
      showResolution: true,
      showSettings: true,
    })
    expect(getVideoParamVisibility(['duration', 'ratio', 'resolution'])).toMatchObject({
      showModel: true,
      showSettings: false,
    })
    expect(getVideoParamVisibility([], false)).toMatchObject({
      showDuration: false,
      showSettings: true,
    })
  })

  it('uses video reference storage for video-capable chat teams', () => {
    expect(usesVideoReferenceStorage('chat', minuteVideoTeam)).toBe(true)
    expect(usesVideoReferenceStorage('chat', null)).toBe(false)
    expect(usesVideoReferenceStorage('video', null)).toBe(true)
  })
})
