// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { TaskType } from '@/types/api'
import {
  getAllowedAgentsForBindMode,
  requiresClaudeCodeForBindMode,
} from '@/features/settings/utils/team-bind-mode-rules'

describe('team bind mode rules', () => {
  it('requires ClaudeCode when code and task modes are both selected', () => {
    expect(requiresClaudeCodeForBindMode(['code', 'task'] as TaskType[])).toBe(true)
    expect(getAllowedAgentsForBindMode(['chat', 'code', 'task'] as TaskType[])).toEqual([
      'ClaudeCode',
    ])
  })

  it('does not restrict executors for code-only or task-only teams', () => {
    expect(requiresClaudeCodeForBindMode(['code'] as TaskType[])).toBe(false)
    expect(requiresClaudeCodeForBindMode(['task'] as TaskType[])).toBe(false)
    expect(getAllowedAgentsForBindMode(['code'] as TaskType[])).toBeUndefined()
  })

  it('keeps a stricter mode restriction when ClaudeCode is already allowed', () => {
    expect(
      getAllowedAgentsForBindMode(['code', 'task'] as TaskType[], ['ClaudeCode', 'Agno'])
    ).toEqual(['ClaudeCode'])
  })
})
