// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { TaskType } from '@/types/api'
import {
  getAllowedAgentsForBindMode,
  requiresCodingAgentForBindMode,
} from '@/features/settings/utils/team-bind-mode-rules'

describe('team bind mode rules', () => {
  it('requires a coding agent when code mode is selected', () => {
    expect(requiresCodingAgentForBindMode(['code'] as TaskType[])).toBe(true)
    expect(getAllowedAgentsForBindMode(['code'] as TaskType[])).toEqual(['Codex', 'ClaudeCode'])
  })

  it('requires a coding agent when task (device) mode is selected', () => {
    expect(requiresCodingAgentForBindMode(['task'] as TaskType[])).toBe(true)
    expect(getAllowedAgentsForBindMode(['task'] as TaskType[])).toEqual(['Codex', 'ClaudeCode'])
  })

  it('requires a coding agent when both code and task modes are selected', () => {
    expect(requiresCodingAgentForBindMode(['code', 'task'] as TaskType[])).toBe(true)
    expect(getAllowedAgentsForBindMode(['chat', 'code', 'task'] as TaskType[])).toEqual([
      'Codex',
      'ClaudeCode',
    ])
  })

  it('does not restrict executors for chat/video/image-only teams', () => {
    expect(requiresCodingAgentForBindMode(['chat'] as TaskType[])).toBe(false)
    expect(requiresCodingAgentForBindMode(['video'] as TaskType[])).toBe(false)
    expect(requiresCodingAgentForBindMode(['image'] as TaskType[])).toBe(false)
    expect(getAllowedAgentsForBindMode(['chat'] as TaskType[])).toBeUndefined()
  })

  it('keeps the intersection with stricter collaboration mode restrictions', () => {
    expect(
      getAllowedAgentsForBindMode(['code', 'task'] as TaskType[], ['ClaudeCode', 'Agno'])
    ).toEqual(['ClaudeCode'])
  })
})
