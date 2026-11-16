import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import '@/i18n'
import { ProjectCoordinationPanel } from './ProjectCoordinationPanel'

function fixture(binding: unknown = null) {
  const projectCoordination = vi
    .fn()
    .mockResolvedValue({ binding, canEnable: true, canStop: binding !== null })
  const projectProcessing = vi
    .fn()
    .mockResolvedValue({ running: false, questions: {}, error: null })
  const onOpenIssue = vi.fn()
  const props = {
    api: { projectCoordination, projectProcessing },
    userId: 7,
    deviceId: 'mac',
    projectId: 'project',
    projectStore: 'cloud',
    groupId: 'group',
    onOpenIssue,
  } as unknown as ComponentProps<typeof ProjectCoordinationPanel>
  return { props, projectCoordination, projectProcessing, onOpenIssue }
}

it('does not enable automatically and uses the displayed generation on explicit enable', async () => {
  const f = fixture()
  render(<ProjectCoordinationPanel {...f.props} />)
  const button = await screen.findByTestId('project-coordination-enable')
  expect(f.projectCoordination).toHaveBeenCalledOnce()
  expect(f.projectProcessing).not.toHaveBeenCalled()
  await userEvent.setup().click(button)
  expect(f.projectCoordination).toHaveBeenCalledWith(
    7,
    'mac',
    { projectId: 'project', projectStore: 'cloud', groupId: 'group' },
    { enabled: true, expectedGeneration: null }
  )
})

it('requires explicit takeover confirmation and never overwrites another binding on selection', async () => {
  const f = fixture({ enabled: true, userId: 8, deviceId: 'other', generation: 'current' })
  render(<ProjectCoordinationPanel {...f.props} />)
  const user = userEvent.setup()
  await user.click(await screen.findByTestId('project-coordination-enable'))
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  expect(f.projectCoordination).toHaveBeenCalledOnce()
  await user.click(screen.getByTestId('project-coordination-takeover-confirm'))
  expect(f.projectCoordination).toHaveBeenCalledWith(
    7,
    'mac',
    { projectId: 'project', projectStore: 'cloud', groupId: 'group' },
    { enabled: true, expectedGeneration: 'current', takeover: true }
  )
})

it('returns a private request for information to its original shared Issue', async () => {
  const f = fixture({ enabled: true, userId: 7, deviceId: 'mac', generation: 'mine' })
  f.projectProcessing.mockResolvedValue({
    running: false,
    questions: { issue: { issueId: 'ISSUE-1', question: '请补充验收标准', batchId: 'one' } },
    error: null,
  })
  render(<ProjectCoordinationPanel {...f.props} />)
  await userEvent.setup().click(await screen.findByTestId('project-coordination-question-ISSUE-1'))
  expect(f.onOpenIssue).toHaveBeenCalledExactlyOnceWith('ISSUE-1')
  expect(f.projectCoordination).toHaveBeenCalledOnce()
})

it('never starts processing or shows enable controls when execution permission is absent', async () => {
  const f = fixture()
  f.projectCoordination.mockResolvedValue({ binding: null, canEnable: false, canStop: false })
  render(<ProjectCoordinationPanel {...f.props} />)
  await waitFor(() => expect(screen.getByText('尚未启用')).toBeInTheDocument())
  expect(screen.queryByTestId('project-coordination-enable')).not.toBeInTheDocument()
  expect(f.projectProcessing).not.toHaveBeenCalled()
})
