// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { isTaskInProject } from '@/features/projects/utils/projectClassification'
import type { Project } from '@/types/api'

const projects: Project[] = [
  {
    id: 1,
    user_id: 7,
    name: 'API',
    description: '',
    color: null,
    config: null,
    sort_order: 1,
    is_expanded: false,
    task_count: 100,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
]

test('filters grouped tasks even when their page has not been loaded', () => {
  expect(isTaskInProject({ id: 101, project_id: 1 }, projects, new Set(), true)).toBe(true)
  expect(isTaskInProject({ id: 102, project_id: 0 }, projects, new Set(), true)).toBe(false)
})

test('keeps tasks visible when their project is unavailable', () => {
  expect(isTaskInProject({ id: 101, project_id: 99 }, projects, new Set(), true)).toBe(false)
})

test('retains confirmed loaded membership before task lists refresh', () => {
  expect(isTaskInProject({ id: 101, project_id: 0 }, projects, new Set([101]), true)).toBe(true)
})

test('preserves workspace visibility rules', () => {
  const workspace = { ...projects[0], config: { mode: 'workspace' as const } }
  expect(isTaskInProject({ id: 101, project_id: 1 }, [workspace], new Set(), false)).toBe(false)
  expect(isTaskInProject({ id: 101, project_id: 1 }, [workspace], new Set(), true)).toBe(true)
})
