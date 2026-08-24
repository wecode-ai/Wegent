import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { CloudProject, ProjectWorkflowDefinition } from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { ProjectAutomationView } from './ProjectAutomationView'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string): string => fallback ?? _key,
  }),
}))

vi.mock('./ProjectAutomationRulesSection', () => ({
  ProjectAutomationRulesSection: () => <div data-testid="mock-automation-rules" />,
}))

vi.mock('./ProjectChatAgentsSection', () => ({
  ProjectChatAgentsSection: () => <div data-testid="mock-project-agents" />,
}))

vi.mock('./ProjectQueueView', () => ({
  ProjectQueueView: () => <div data-testid="mock-project-queue" />,
}))

vi.mock('./ProjectWorkflowEditor', () => ({
  ProjectWorkflowEditor: ({
    value,
    onChange,
    onSave,
  }: {
    value: ProjectWorkflowDefinition
    onChange: (value: ProjectWorkflowDefinition) => void
    onSave: (value: ProjectWorkflowDefinition) => void
  }) => (
    <div>
      <span data-testid="workflow-node-count">{value.nodes.length}</span>
      <button
        type="button"
        data-testid="mock-add-stage"
        onClick={() =>
          onChange({
            ...value,
            stage_mode: 'dag',
            nodes: [
              ...value.nodes,
              {
                id: `stage-${value.nodes.length + 1}`,
                name: `设计 ${value.nodes.length + 1}`,
                prompt: '',
                depends_on: [],
                dependency_context: {},
                required: true,
                workspace_policy: 'composer',
                automation_rule_id: null,
              },
            ],
          })
        }
      >
        Add stage
      </button>
      <button type="button" data-testid="mock-save-workflow" onClick={() => onSave(value)}>
        Save
      </button>
    </div>
  ),
}))

const initialProject: CloudProject = {
  id: 11,
  public_id: 'project-11',
  project_key: 'SAVE',
  name: 'Workflow persistence',
  description: '',
  project_store: 'backend',
  task_provider: 'local',
  provider_config: {},
  workflow_definition: {
    version: 1,
    stage_mode: 'none',
    advancement_policy: 'manual',
    nodes: [],
  },
  created_by_user_id: 1,
  current_user_id: 1,
  current_user_name: 'Owner',
  access_role: 'Owner',
  visibility: 'private',
  status: 'active',
  tags: [],
  version: 1,
  created_at: '2026-08-18T00:00:00Z',
  updated_at: '2026-08-18T00:00:00Z',
}

describe('ProjectAutomationView', () => {
  test('adopts the saved project definition so re-entering restores the workflow', async () => {
    let persistedProject = initialProject
    const updateCloudProject = vi.fn(async (_projectId, values) => {
      persistedProject = {
        ...persistedProject,
        workflow_definition: values.workflow_definition,
        version: persistedProject.version + 1,
      }
      return persistedProject
    })
    const api = {
      updateCloudProject,
    } as unknown as NonNullable<WorkbenchServices['deliveryApi']>

    const firstView = render(
      <ProjectAutomationView
        api={api}
        project={initialProject}
        localProjects={[]}
        canManageAgents
        onProjectUpdated={project => {
          persistedProject = project
        }}
      />
    )

    fireEvent.click(screen.getByTestId('mock-add-stage'))
    fireEvent.click(screen.getByTestId('mock-save-workflow'))

    await waitFor(() =>
      expect(updateCloudProject).toHaveBeenCalledWith(11, {
        workflow_definition: expect.objectContaining({
          version: 2,
          stage_mode: 'dag',
          nodes: [expect.objectContaining({ id: 'stage-1' })],
        }),
        version: 1,
      })
    )
    await waitFor(() => expect(persistedProject.workflow_definition?.nodes).toHaveLength(1))

    firstView.unmount()
    render(
      <ProjectAutomationView
        api={api}
        project={persistedProject}
        localProjects={[]}
        canManageAgents
      />
    )

    expect(screen.getByTestId('workflow-node-count')).toHaveTextContent('1')
  })

  test('adopts a project update while the view is mounted', async () => {
    const updatedProject: CloudProject = {
      ...initialProject,
      version: 2,
      workflow_definition: {
        version: 2,
        stage_mode: 'dag',
        advancement_policy: 'manual',
        nodes: [
          {
            id: 'stage-1',
            name: '设计',
            prompt: '',
            depends_on: [],
            dependency_context: {},
            required: true,
            workspace_policy: 'composer',
            automation_rule_id: null,
          },
        ],
      },
    }
    const { rerender } = render(
      <ProjectAutomationView
        api={
          {
            updateCloudProject: vi.fn(),
          } as unknown as NonNullable<WorkbenchServices['deliveryApi']>
        }
        project={initialProject}
        localProjects={[]}
        canManageAgents
      />
    )

    expect(screen.getByTestId('workflow-node-count')).toHaveTextContent('0')
    rerender(
      <ProjectAutomationView
        api={
          {
            updateCloudProject: vi.fn(),
          } as unknown as NonNullable<WorkbenchServices['deliveryApi']>
        }
        project={updatedProject}
        localProjects={[]}
        canManageAgents
      />
    )

    expect(screen.getByTestId('workflow-node-count')).toHaveTextContent('1')
  })

  test('keeps edits made while a workflow save is in flight', async () => {
    let resolveUpdate: ((project: CloudProject) => void) | undefined
    const updateCloudProject = vi.fn(
      () =>
        new Promise<CloudProject>(resolve => {
          resolveUpdate = resolve
        })
    )
    render(
      <ProjectAutomationView
        api={
          {
            updateCloudProject,
          } as unknown as NonNullable<WorkbenchServices['deliveryApi']>
        }
        project={initialProject}
        localProjects={[]}
        canManageAgents
      />
    )

    fireEvent.click(screen.getByTestId('mock-add-stage'))
    fireEvent.click(screen.getByTestId('mock-save-workflow'))
    await waitFor(() => expect(updateCloudProject).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByTestId('mock-add-stage'))
    expect(screen.getByTestId('workflow-node-count')).toHaveTextContent('2')

    resolveUpdate?.({
      ...initialProject,
      version: 2,
      workflow_definition: {
        version: 2,
        stage_mode: 'dag',
        advancement_policy: 'manual',
        nodes: [
          {
            id: 'stage-1',
            name: '设计 1',
            prompt: '',
            depends_on: [],
            dependency_context: {},
            required: true,
            workspace_policy: 'composer',
            automation_rule_id: null,
          },
        ],
      },
    })

    await waitFor(() => expect(screen.getByTestId('workflow-node-count')).toHaveTextContent('2'))
  })
})
