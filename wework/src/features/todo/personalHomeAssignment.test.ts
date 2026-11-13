import { expect, it } from 'vitest'
import type { WorkspaceMyWorkItem } from '@wegent/collaboration'
import { personalHomeAssignmentAt, personalHomeAssignmentDuration } from './personalHomeAssignment'

const issue = {
  assignee_user_id: 0,
  created_at: '2020-01-01T00:00:00Z',
  assignment_history: [
    { to_type: 'user', to_id: '0', at: '2026-11-01T00:00:00Z' },
    { to_type: 'user', to_id: '0', at: '2026-11-12T00:00:00Z' },
  ],
} as WorkspaceMyWorkItem

it('measures the current assignment and recognizes local viewer aliases', () => {
  expect(personalHomeAssignmentAt(issue, [7, 0])).toBe('2026-11-12T00:00:00Z')
  expect(personalHomeAssignmentAt(issue, [7])).toBeNull()
  expect(personalHomeAssignmentAt({ ...issue, assignment_history: [] }, [0])).toBeNull()
})

it('uses the canonical current assignment context and parses naive UTC timestamps', () => {
  expect(
    personalHomeAssignmentAt(
      {
        ...issue,
        assignment_context: {
          body: 'Review',
          created_by_user_name: 'Alice',
          created_at: '2026-11-13 00:00:00',
        },
      },
      [0]
    )
  ).toBe('2026-11-13T00:00:00Z')
  expect(
    personalHomeAssignmentAt(
      { ...issue, assignment_history: [{ to_type: 'user', to_id: '9', at: 'invalid' }] },
      [0]
    )
  ).toBeNull()
})

it('shows elapsed minutes, hours and days without counting from Issue creation', () => {
  const at = '2026-11-12T00:00:00Z'
  const start = Date.parse(at)
  expect(personalHomeAssignmentDuration(at, 'en', start + 120_000)).toBe('2 min')
  expect(personalHomeAssignmentDuration(at, 'en', start + 7_200_000)).toBe('2 hr')
  expect(personalHomeAssignmentDuration(at, 'en', start + 172_800_000)).toBe('2 days')
})
