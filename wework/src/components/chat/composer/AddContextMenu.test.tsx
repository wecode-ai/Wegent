import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { CloudProject } from '@/api/deliveries'
import type { ComposerCloudMentionCandidate } from './composerMentionCandidates'
import { AddContextMenu } from './AddContextMenu'

const project: CloudProject = {
  id: 'space-1',
  public_id: 'space-public-1',
  project_key: 'FOLLOWUP',
  name: 'Task Follow-up Board',
  description: 'Track selected local tasks',
  project_store: 'local',
  task_provider: 'local',
  provider_config: {},
  created_by_user_id: 1,
  status: 'active',
  tags: [],
  version: 1,
  created_at: '2026-08-04T00:00:00Z',
  updated_at: '2026-08-04T00:00:00Z',
}

const projectCandidate: ComposerCloudMentionCandidate = {
  kind: 'cloud',
  key: 'cloud-project-space:space-1',
  title: project.name,
  description: project.description,
  metaLabel: '云空间',
  statusLabel: '自动加入',
  testId: 'cloud-project-space-space-1',
  enabled: true,
  reference: '[$项目空间:Task Follow-up Board](cloud://projects/space-1)',
  searchAliases: [project.name],
  project,
}

describe('AddContextMenu', () => {
  test('renders its menu in a body portal so composer containers cannot clip it', () => {
    render(<AddContextMenu disabled={false} onFileSelect={vi.fn()} />)

    fireEvent.click(screen.getByTestId('add-context-button'))

    expect(screen.getByTestId('add-context-menu').parentElement).toBe(document.body)
  })

  test('keeps portal menu actions interactive', () => {
    const onSetGoal = vi.fn()
    render(<AddContextMenu disabled={false} onFileSelect={vi.fn()} onSetGoal={onSetGoal} />)

    fireEvent.click(screen.getByTestId('add-context-button'))
    fireEvent.click(screen.getByTestId('set-goal-button'))

    expect(onSetGoal).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('add-context-menu')).not.toBeInTheDocument()
  })

  test('opens supervisor configuration from the add menu', () => {
    const onConfigureSupervisor = vi.fn()
    render(
      <AddContextMenu
        disabled={false}
        onFileSelect={vi.fn()}
        onConfigureSupervisor={onConfigureSupervisor}
      />
    )

    fireEvent.click(screen.getByTestId('add-context-button'))
    fireEvent.click(screen.getByTestId('task-supervisor-toggle-button'))

    expect(onConfigureSupervisor).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('add-context-menu')).not.toBeInTheDocument()
  })

  test('keeps the supervisor entry after supervision is enabled', () => {
    render(
      <AddContextMenu
        disabled={false}
        onFileSelect={vi.fn()}
        onConfigureSupervisor={vi.fn()}
        supervisorEnabled
      />
    )

    fireEvent.click(screen.getByTestId('add-context-button'))

    expect(screen.getByTestId('task-supervisor-toggle-button')).toHaveTextContent(
      'workbench.supervisor_configure'
    )
  })

  test('explains that pending supervision starts with the task', () => {
    render(
      <AddContextMenu
        disabled={false}
        onFileSelect={vi.fn()}
        onConfigureSupervisor={vi.fn()}
        supervisorEnabled
        supervisorPending
      />
    )

    fireEvent.click(screen.getByTestId('add-context-button'))

    expect(screen.getByTestId('task-supervisor-toggle-button')).toHaveTextContent(
      'workbench.supervisor_pending_menu'
    )
  })

  test('moves focus into the portal and restores it after Escape', async () => {
    render(<AddContextMenu disabled={false} onFileSelect={vi.fn()} />)

    const trigger = screen.getByTestId('add-context-button')
    fireEvent.click(trigger)

    await waitFor(() => expect(screen.getByTestId('attach-files-button')).toHaveFocus())
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(screen.queryByTestId('add-context-menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  test('selects a linked project space from the add-context menu', () => {
    const onSelectCloudProject = vi.fn()
    render(
      <AddContextMenu
        disabled={false}
        onFileSelect={vi.fn()}
        cloudProjectCandidates={[projectCandidate]}
        selectedCloudProjectId={project.id}
        onSelectCloudProject={onSelectCloudProject}
      />
    )

    fireEvent.click(screen.getByTestId('add-context-button'))
    expect(screen.getByTestId('add-project-space-context-button')).toHaveTextContent(project.name)
    fireEvent.click(screen.getByTestId('add-project-space-context-button'))

    const option = screen.getByTestId('add-context-cloud-project-space-space-1')
    expect(option).toHaveAttribute('aria-checked', 'true')
    expect(option).toHaveTextContent('自动加入')
    fireEvent.click(option)

    expect(onSelectCloudProject).toHaveBeenCalledOnce()
    expect(onSelectCloudProject).toHaveBeenCalledWith(project)
    expect(screen.queryByTestId('add-context-menu')).not.toBeInTheDocument()
  })
})
