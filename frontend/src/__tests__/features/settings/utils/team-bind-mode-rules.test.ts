// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { TaskType } from '@/types/api'
import {
  getAllowedAgentsForBindMode,
  requiresCodeRuntimeForBindMode,
} from '@/features/settings/utils/team-bind-mode-rules'

describe('team bind mode rules', () => {
  it('requires a code runtime when code mode is selected', () => {
    expect(requiresCodeRuntimeForBindMode(['code'] as TaskType[])).toBe(true)
    expect(getAllowedAgentsForBindMode(['code'] as TaskType[])).toEqual(['ClaudeCode', 'Codex'])
  })

  it('requires a code runtime when task (device) mode is selected', () => {
    expect(requiresCodeRuntimeForBindMode(['task'] as TaskType[])).toBe(true)
    expect(getAllowedAgentsForBindMode(['task'] as TaskType[])).toEqual(['ClaudeCode', 'Codex'])
  })

  it('requires a code runtime when both code and task modes are selected', () => {
    expect(requiresCodeRuntimeForBindMode(['code', 'task'] as TaskType[])).toBe(true)
    expect(getAllowedAgentsForBindMode(['chat', 'code', 'task'] as TaskType[])).toEqual([
      'ClaudeCode',
      'Codex',
    ])
  })

  it('does not restrict executors for chat/video/image-only teams', () => {
    expect(requiresCodeRuntimeForBindMode(['chat'] as TaskType[])).toBe(false)
    expect(requiresCodeRuntimeForBindMode(['video'] as TaskType[])).toBe(false)
    expect(requiresCodeRuntimeForBindMode(['image'] as TaskType[])).toBe(false)
    expect(getAllowedAgentsForBindMode(['chat'] as TaskType[])).toBeUndefined()
  })

  it('keeps the intersection with an existing mode restriction', () => {
    expect(
      getAllowedAgentsForBindMode(['code', 'task'] as TaskType[], ['ClaudeCode', 'Agno'])
    ).toEqual(['ClaudeCode'])
  })
})
