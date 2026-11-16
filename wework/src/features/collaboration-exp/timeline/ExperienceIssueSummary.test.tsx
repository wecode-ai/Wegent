import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { experienceIssueFixture, experienceProjectFixture } from '../model/fixtures'
import { ExperienceIssueSummary } from './ExperienceIssueSummary'
import { issueSummaryContent } from './issueSummaryContent'

afterEach(cleanup)

function setup() {
  const project = experienceProjectFixture({
    name: 'Actual associated project',
    default_issue_security: 'open',
    board_config: {
      group_by: 'status',
      processing_start_status_id: null,
      statuses: [{ id: 'pending', name: 'Awaiting product review', color: 'gray' }],
    },
  })
  const issue = experienceIssueFixture({
    title: 'Actual issue title',
    description:
      'Original scope.\n\n## Acceptance criteria\n\n- Require the real permission check.\n- Keep the existing record.',
  })
  return {
    data: { project, issue, taskBindings: [] },
    onClose: vi.fn(),
    onConfigure: vi.fn(),
    onProject: vi.fn(),
  }
}

it('shows actual task data and description acceptance without starting the native editor', () => {
  const props = setup()
  render(<ExperienceIssueSummary {...props} />)
  const dialog = screen.getByRole('dialog', { name: '任务详情' })
  expect(within(dialog).getByText(props.data.issue.title)).toBeInTheDocument()
  expect(within(dialog).getByText('Original scope.')).toBeInTheDocument()
  expect(screen.getByTestId('collaboration-exp-issue-summary-visibility')).toHaveTextContent(
    '可见范围：项目成员'
  )
  expect(screen.getByTestId('collaboration-exp-issue-summary-status')).toHaveTextContent(
    '状态：Awaiting product review'
  )
  const criteria = screen.getByTestId('collaboration-exp-issue-summary-acceptance')
  expect(within(criteria).getAllByRole('listitem')).toHaveLength(2)
  expect(criteria).toHaveTextContent('Require the real permission check.')
  expect(screen.getAllByText('Original scope.')).toHaveLength(1)
  expect(props.onConfigure).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('collaboration-exp-issue-summary-configure'))
  expect(props.onConfigure).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByTestId('collaboration-exp-issue-summary-project'))
  expect(props.onProject).toHaveBeenCalledWith(
    expect.objectContaining({ id: props.data.project.id, store: 'backend' })
  )
})

it('keeps unconfirmed visibility and missing acceptance truthful', () => {
  const props = setup()
  props.data.project.default_issue_security = undefined
  props.data.issue.description = 'Only the original description is available.'
  render(<ExperienceIssueSummary {...props} />)
  expect(screen.getByTestId('collaboration-exp-issue-summary-visibility')).toHaveTextContent(
    '可见范围：未确认'
  )
  expect(screen.getByText(props.data.issue.description)).toBeInTheDocument()
  expect(screen.queryByTestId('collaboration-exp-issue-summary-acceptance')).not.toBeInTheDocument()
})

it('uses the existing dialog focus trap, ignores IME Escape and returns focus after close', () => {
  const props = setup()
  function Fixture() {
    const [open, setOpen] = useState(false)
    return (
      <main data-testid="collaboration-exp-app">
        <button data-testid="open-summary" onClick={() => setOpen(true)}>
          Open task details
        </button>
        {open ? <ExperienceIssueSummary {...props} onClose={() => setOpen(false)} /> : null}
      </main>
    )
  }
  render(<Fixture />)
  const trigger = screen.getByTestId('open-summary')
  trigger.focus()
  fireEvent.click(trigger)
  const close = screen.getByTestId('collaboration-exp-issue-summary-close')
  const project = screen.getByTestId('collaboration-exp-issue-summary-project')
  expect(close).toHaveFocus()
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
  expect(project).toHaveFocus()
  fireEvent.keyDown(project, { key: 'Tab' })
  expect(close).toHaveFocus()
  fireEvent.keyDown(close, { key: 'Escape', isComposing: true })
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  fireEvent.keyDown(close, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(trigger).toHaveFocus()
  fireEvent.click(trigger)
  fireEvent.click(screen.getByTestId('collaboration-exp-issue-summary-close'))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(trigger).toHaveFocus()
})

it('extracts only an explicit acceptance section and preserves later original sections', () => {
  expect(
    issueSummaryContent(
      'Scope\n\n## **验收依据**\n\n1. Real criterion\n\n### Evidence\nOriginal evidence\n\n## Follow-up\nKeep this.'
    )
  ).toEqual({
    description: 'Scope\n\n## Follow-up\nKeep this.',
    acceptance: '1. Real criterion\n\n### Evidence\nOriginal evidence',
  })
})

it('does not treat quoted, fenced or ordinary text as a separate acceptance contract', () => {
  const description =
    '```md\n## 验收依据\nExample only\n```\n\n> ## Acceptance criteria\n> Quoted only\n\nOriginal requirement.'
  expect(issueSummaryContent(description)).toEqual({ description, acceptance: '' })
})
