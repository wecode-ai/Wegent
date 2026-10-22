import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SharedIssueAssignmentHistoryEntry } from '@wegent/collaboration'
import type { CloudProjectMember } from '@/api/deliveries'
import i18n from '@/i18n'
import { IssueAssignmentEvent } from './IssueAssignmentEvent'

const projectMembers = [
  { user_id: 1, user_name: 'Alice' },
  { user_id: 2, user_name: 'Bob' },
] as CloudProjectMember[]

function renderEntry(overrides: Partial<SharedIssueAssignmentHistoryEntry>) {
  return render(
    <IssueAssignmentEvent
      entry={{
        by_user_id: 1,
        to_type: 'user',
        to_id: '2',
        action: 'assign',
        at: '2026-10-20T02:00:00.000Z',
        ...overrides,
      }}
      index={3}
      projectMembers={projectMembers}
    />
  )
}

describe('IssueAssignmentEvent', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN')
  })
  afterEach(cleanup)

  it.each([
    ['user', null, 'Bob'],
    ['agent', 'Codex engineer', 'Codex engineer'],
    ['team', 'Wegent reviewer', 'Wegent reviewer'],
    ['group', 'Release group', 'Release group'],
  ] as const)('shows the actor and %s assignee', (to_type, to_name, expected) => {
    renderEntry({ to_type, to_name, action: 'reassign' })
    const event = screen.getByTestId('cloud-task-assignment-event-3')
    expect(event).toHaveClass('task-detail-timeline-system-event')
    expect(event).toHaveTextContent('Alice')
    expect(event).toHaveTextContent(expected)
    expect(event).toHaveTextContent('转派')
    expect(event.querySelector('svg.lucide-arrow-right')).toBeInTheDocument()
  })

  it.each([
    ['agent', '机器人'],
    ['team', 'Wegent 智能体'],
    ['group', '协作小组'],
  ] as const)('uses the localized %s name when history has no saved name', (to_type, name) => {
    renderEntry({ to_type })
    expect(screen.getByTestId('cloud-task-assignment-event-3')).toHaveTextContent(name)
  })

  it('shows unassignment without an arrow pointing to the former assignee', () => {
    renderEntry({ action: 'unassign', to_name: 'Former assignee' })
    const event = screen.getByTestId('cloud-task-assignment-event-3')
    expect(event).toHaveTextContent('Alice')
    expect(event).toHaveTextContent('取消指派')
    expect(event).toHaveTextContent('未指派')
    expect(event).not.toHaveTextContent('Former assignee')
    expect(event.querySelector('svg.lucide-arrow-right')).not.toBeInTheDocument()
  })
})
