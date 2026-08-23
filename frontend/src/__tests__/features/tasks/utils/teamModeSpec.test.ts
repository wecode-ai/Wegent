// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  resolveBotRuntimeModel,
  teamUsesModeSpecCategory,
  teamUsesWorkflowManagedVideo,
} from '@/features/tasks/utils/teamModeSpec'
import type { Team } from '@/types/api'

const minuteVideoTeam = {
  id: 1,
  name: 'workflow-video-team',
  mode_spec: {
    allowedModelCategories: ['video'],
    workflowManagedVideo: true,
  },
} as Team

describe('teamModeSpec', () => {
  it('exposes only the configured video category', () => {
    expect(teamUsesModeSpecCategory(minuteVideoTeam, 'video')).toBe(true)
    expect(teamUsesModeSpecCategory(minuteVideoTeam, 'llm')).toBe(false)
  })

  it('keeps the Bot runtime model under backend control', () => {
    expect(teamUsesWorkflowManagedVideo(minuteVideoTeam)).toBe(true)
    expect(resolveBotRuntimeModel(minuteVideoTeam, { name: 'frontend-llm' })).toBeNull()
  })
})
