import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { ProjectWorkflowAutomationsSection } from './ProjectWorkflowAutomationsSection'

describe('ProjectWorkflowAutomationsSection', () => {
  it('creates an automation and runs the same workflow from the project view', async () => {
    const user = userEvent.setup()
    const created = {
      id: 'automation-1',
      projectId: '12',
      name: 'Nightly delivery',
      description: '',
      triggerType: 'manual',
      triggerConfig: {},
      workflowId: 'workflow-1',
      repositoryBindingId: null,
      executionTarget: { type: 'managed_container' },
      workspaceMode: 'git_worktree',
      taskTemplate: { title: 'Automated development task' },
      payloadMapping: {},
      webhookConfigured: true,
      enabled: true,
      nextRunAt: null,
      lastRunAt: null,
      createdByUserId: 1,
      version: 1,
      createdAt: '2026-08-12T00:00:00Z',
      updatedAt: '2026-08-12T00:00:00Z',
    }
    let serverAutomations: (typeof created)[] = []
    const api = {
      listAutomations: vi.fn(async () => serverAutomations),
      listWorkflows: vi.fn(async () => [
        {
          id: 'workflow-1',
          name: 'Delivery workflow',
          status: 'active',
        },
      ]),
      listRepositories: vi.fn(async () => []),
      createAutomation: vi.fn(async () => {
        serverAutomations = [created]
        return created
      }),
      updateAutomation: vi.fn(),
      runAutomation: vi.fn(async () => ({
        id: 'run-1',
        automationId: 'automation-1',
        triggerType: 'manual',
        status: 'succeeded',
        loopItemId: 'TASK-1',
        workflowRunId: 'workflow-run-1',
        scheduledFor: '2026-08-12T00:00:00Z',
        startedAt: '2026-08-12T00:00:00Z',
        completedAt: '2026-08-12T00:00:01Z',
        errorMessage: null,
        createdAt: '2026-08-12T00:00:00Z',
        updatedAt: '2026-08-12T00:00:01Z',
      })),
      listAutomationRuns: vi.fn(async () => []),
      rotateAutomationWebhook: vi.fn(),
    }

    render(<ProjectWorkflowAutomationsSection projectId="12" api={api as never} canManage />)

    await user.click(await screen.findByTestId('project-workflow-automation-add'))
    await user.type(screen.getByTestId('workflow-automation-name'), 'Nightly delivery')
    await user.click(screen.getByTestId('workflow-automation-save'))

    expect(await screen.findByText('Nightly delivery')).toBeInTheDocument()
    expect(api.createAutomation).toHaveBeenCalledWith(
      '12',
      expect.objectContaining({
        name: 'Nightly delivery',
        workflowId: 'workflow-1',
        executionTarget: { type: 'managed_container' },
        workspaceMode: 'git_worktree',
      })
    )

    await user.click(screen.getByTestId('workflow-automation-run-automation-1'))
    expect(api.runAutomation).toHaveBeenCalledWith(
      '12',
      'automation-1',
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^ui:/) })
    )
    expect(await screen.findByText('task: TASK-1')).toBeInTheDocument()
  })
})
