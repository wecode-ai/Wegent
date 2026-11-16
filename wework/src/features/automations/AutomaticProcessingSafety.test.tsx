import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { ProjectAutomaticProcessing } from '@wegent/collaboration/project-manage'
import { createCollaborationTranslator } from '@wegent/collaboration'
import type {
  SharedWorkspaceApi,
  CollaborationProject,
  WorkspaceAutomationRule,
} from '@wegent/collaboration'

const rule: WorkspaceAutomationRule = {
  id: 'rule',
  projectId: 'project',
  name: 'Daily report',
  prompt: 'Report',
  triggerType: 'schedule',
  eventType: null,
  eventConfig: {},
  cronExpression: '0 9 * * *',
  workdayOnly: false,
  timezone: 'Asia/Shanghai',
  executionDeviceId: null,
  targetKind: 'agent',
  targetId: 'agent',
  targetName: 'Agent',
  enabled: false,
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: null,
  version: 1,
  createdAt: '',
  updatedAt: '',
}
function setup(accessRole = 'Owner') {
  let rules = [rule]
  const remove = vi
    .fn()
    .mockRejectedValueOnce(new Error('Delete failed'))
    .mockImplementation(async () => {
      rules = []
    })
  const update = vi.fn()
  const api = {
    automations: { list: vi.fn(async () => rules), remove, update },
    projects: { listCollaborationGroups: vi.fn(async () => []) },
    agents: { list: vi.fn(async () => [{ id: 'agent', name: 'Agent' }]) },
    members: { list: vi.fn(async () => []) },
  } as unknown as SharedWorkspaceApi
  render(
    <ProjectAutomaticProcessing
      api={api}
      project={
        {
          id: 'project',
          name: 'Project',
          access_role: accessRole,
          version: 1,
        } as CollaborationProject
      }
      agents={[]}
      members={[]}
      locale="en"
      translate={createCollaborationTranslator('en')}
    />
  )
  return { remove, update }
}

it('requires deletion confirmation, preserves the rule on failure and allows a deliberate retry', async () => {
  const user = userEvent.setup()
  const { remove } = setup()
  await user.click(await screen.findByTestId('automatic-processing-delete-rule'))
  expect(remove).not.toHaveBeenCalled()
  expect(screen.getByTestId('automatic-processing-delete-dialog')).toHaveTextContent('Daily report')
  await user.click(screen.getByTestId('automatic-processing-delete-cancel'))
  expect(remove).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('automatic-processing-delete-rule'))
  await user.click(screen.getByTestId('automatic-processing-delete-confirm'))
  expect(await screen.findByRole('alert')).toHaveTextContent('Delete failed')
  expect(screen.getByTestId('automatic-processing-rule-rule')).toBeVisible()
  await user.click(screen.getByTestId('automatic-processing-delete-confirm'))
  await waitFor(() =>
    expect(screen.queryByTestId('automatic-processing-rule-rule')).not.toBeInTheDocument()
  )
  expect(remove).toHaveBeenCalledTimes(2)
})

it('lets viewers inspect a rule without exposing editing or deletion', async () => {
  const user = userEvent.setup()
  const { remove, update } = setup('Viewer')
  await user.click(await screen.findByRole('button', { name: /Daily report/ }))
  expect(screen.getByRole('dialog', { name: 'View automatic rule' })).toBeVisible()
  expect(screen.getByTestId('automatic-processing-prompt')).toBeDisabled()
  expect(screen.queryByTestId('automatic-processing-save')).not.toBeInTheDocument()
  expect(screen.queryByTestId('automatic-processing-delete-rule')).not.toBeInTheDocument()
  expect(remove).not.toHaveBeenCalled()
  expect(update).not.toHaveBeenCalled()
})
