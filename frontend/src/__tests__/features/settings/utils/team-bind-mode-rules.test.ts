// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { TaskType } from '@/types/api'
import {
  getAllowedAgentsForBindMode,
  requiresClaudeCodeForBindMode,
} from '@/features/settings/utils/team-bind-mode-rules'

describe('team bind mode rules', () => {
  it('requires ClaudeCode when code mode is selected', () => {
    expect(requiresClaudeCodeForBindMode(['code'] as TaskType[])).toBe(true)
    expect(getAllowedAgentsForBindMode(['code'] as TaskType[])).toEqual(['ClaudeCode'])
  })

  it('requires ClaudeCode when task (device) mode is selected', () => {
    expect(requiresClaudeCodeForBindMode(['task'] as TaskType[])).toBe(true)
    expect(getAllowedAgentsForBindMode(['task'] as TaskType[])).toEqual(['ClaudeCode'])
  })

  it('requires ClaudeCode when both code and task modes are selected', () => {
    expect(requiresClaudeCodeForBindMode(['code', 'task'] as TaskType[])).toBe(true)
    expect(getAllowedAgentsForBindMode(['chat', 'code', 'task'] as TaskType[])).toEqual([
      'ClaudeCode',
    ])
  })

  it('does not restrict executors for chat/video/image-only teams', () => {
    expect(requiresClaudeCodeForBindMode(['chat'] as TaskType[])).toBe(false)
    expect(requiresClaudeCodeForBindMode(['video'] as TaskType[])).toBe(false)
    expect(requiresClaudeCodeForBindMode(['image'] as TaskType[])).toBe(false)
    expect(getAllowedAgentsForBindMode(['chat'] as TaskType[])).toBeUndefined()
  })

  it('keeps a stricter mode restriction when ClaudeCode is already allowed', () => {
    expect(
      getAllowedAgentsForBindMode(['code', 'task'] as TaskType[], ['ClaudeCode', 'Agno'])
    ).toEqual(['ClaudeCode'])
  })
})
