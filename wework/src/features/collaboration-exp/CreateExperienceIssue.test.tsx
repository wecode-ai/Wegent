import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import { CreateExperienceIssue, type CreateExperienceIssueProps } from './CreateExperienceIssue'
import type { ExperienceSource } from './data/useExperienceSources'
import { experienceIssueFixture, experienceProjectFixture } from './model/fixtures'

const mocks = vi.hoisted(() => ({
  workbench: {} as Record<string, unknown>,
  t: (key: string) => key,
}))
vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: () => mocks.workbench }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: mocks.t }) }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function setup(store: ExperienceSource['store'] = 'local') {
  const project = experienceProjectFixture({
    id: store === 'local' ? 'default-work-items' : 'first-shared-project',
    project_key: store === 'local' ? 'WORK' : 'EXP',
    project_store: store,
    current_user_id: 7,
    metadata: store === 'local' ? { system_kind: 'default_work_items' } : {},
  })
  const members = [
    { id: 7, user_id: 7, user_name: 'Owner', email: null, role: 'Owner' },
    {
      id: 8,
      user_id: 8,
      user_name: 'Colleague',
      email: null,
      role: 'Developer',
      can_be_assignee: true,
    },
  ]
  const get = vi.fn(async (id: string) => ({ ...project, id }))
  const listMembers = vi.fn().mockResolvedValue(members)
  const issue = experienceIssueFixture({ id: 'created-issue', cloud_project_id: project.id })
  const create = vi.fn().mockResolvedValue(issue)
  const source: ExperienceSource = {
    store,
    participationViewer: store === 'local' ? [0, 7] : 7,
    api: {
      projects: { get },
      members: { list: listMembers },
      issues: { create },
    } as unknown as SharedWorkspaceApi,
  }
  const onCreated = vi.fn()
  const onClose = vi.fn()
  const props: CreateExperienceIssueProps = {
    active: true,
    sources: [source],
    projects: [
      {
        project: experienceProjectFixture({ id: 'first-shared-project', project_store: store }),
        issues: [],
      },
    ],
    onCreated,
    onClose,
  }
  return { source, props, get, create, listMembers, issue, project, onCreated, onClose }
}

async function enterGoal(title = 'Deliver the integration') {
  fireEvent.change(screen.getByTestId('collaboration-exp-create-goal'), {
    target: { value: title },
  })
  await waitFor(() => expect(screen.getByTestId('collaboration-exp-create-submit')).toBeEnabled())
}

function choose(testId: string, label: string) {
  fireEvent.click(screen.getByTestId(`collaboration-exp-create-${testId}`))
  fireEvent.click(screen.getByRole('option', { name: label }))
}

function chooseProject(fixture: ReturnType<typeof setup>) {
  const project = fixture.props.projects[0].project
  choose('project', `${project.name} · create.${project.project_store}`)
}

describe('CreateExperienceIssue', () => {
  beforeEach(() => {
    mocks.workbench = {
      state: { user: { id: 7, user_name: 'Owner' } },
      services: { localParticipationIdentity: { nativeOwnerUserId: 0 } },
    }
  })
  afterEach(cleanup)

  it('creates standalone local work using the native owner instead of the first shared project', async () => {
    const f = setup()
    render(<CreateExperienceIssue {...f.props} />)
    expect(screen.getByTestId('collaboration-exp-create-project')).toHaveTextContent(
      'create.standalone'
    )
    await enterGoal()
    fireEvent.change(screen.getByTestId('collaboration-exp-create-summary'), {
      target: { value: 'Exact delivery body' },
    })
    fireEvent.change(screen.getByTestId('collaboration-exp-create-dueDate'), {
      target: { value: '2026-11-25' },
    })
    fireEvent.click(screen.getByTestId('collaboration-exp-create-submit'))
    await waitFor(() => expect(f.onCreated).toHaveBeenCalledOnce())
    expect(f.create).toHaveBeenCalledExactlyOnceWith('default-work-items', {
      title: 'Deliver the integration',
      description: 'Exact delivery body',
      dueAt: '2026-11-25',
      assigneeUserId: 0,
      personalTask: true,
    })
    expect(f.get).toHaveBeenCalledWith('default-work-items')
    expect(f.get).not.toHaveBeenCalledWith('first-shared-project')
    expect(f.onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'default-work-items', store: 'local' }),
      f.issue
    )
  })

  it('keeps standalone work local and scopes actual projects with identical IDs to their source', async () => {
    const local = setup()
    const cloud = setup('backend')
    const sameId = 'same-project'
    render(
      <CreateExperienceIssue
        {...local.props}
        sources={[local.source, cloud.source]}
        projects={[
          {
            project: experienceProjectFixture({
              id: sameId,
              name: 'Same name',
              project_store: 'local',
            }),
            issues: [],
          },
          {
            project: experienceProjectFixture({
              id: sameId,
              name: 'Same name',
              project_store: 'backend',
            }),
            issues: [],
          },
        ]}
      />
    )
    await enterGoal()
    expect(screen.queryByTestId('collaboration-exp-create-storage')).not.toBeInTheDocument()
    expect(cloud.get).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('collaboration-exp-create-submit'))
    await waitFor(() => expect(local.create).toHaveBeenCalledOnce())
    expect(local.create).toHaveBeenCalledWith(
      'default-work-items',
      expect.objectContaining({ assigneeUserId: 0, personalTask: true })
    )
    expect(cloud.create).not.toHaveBeenCalled()
    choose('project', 'Same name · create.backend')
    await waitFor(() => expect(cloud.get).toHaveBeenCalledWith(sameId))
    await waitFor(() => expect(screen.getByTestId('collaboration-exp-create-submit')).toBeEnabled())
    fireEvent.click(screen.getByTestId('collaboration-exp-create-submit'))
    await waitFor(() => expect(cloud.create).toHaveBeenCalledOnce())
    expect(cloud.create.mock.calls[0][0]).toBe(sameId)
    expect(cloud.create.mock.calls[0][1]).toMatchObject({ assigneeUserId: 7 })
    expect(cloud.create.mock.calls[0][1]).not.toHaveProperty('personalTask')
    expect(cloud.get).not.toHaveBeenCalledWith('default-work-items')
    expect(local.create).toHaveBeenCalledOnce()
  })

  it('requires a real project when only a cloud source is available', async () => {
    const f = setup('backend')
    render(<CreateExperienceIssue {...f.props} />)
    expect(screen.getByRole('alert')).toHaveTextContent('create.sourceUnavailable')
    expect(f.get).not.toHaveBeenCalled()
    expect(screen.getByTestId('collaboration-exp-create-submit')).toBeDisabled()
    chooseProject(f)
    await enterGoal()
    expect(f.get).toHaveBeenCalledWith('first-shared-project')
    expect(f.get).not.toHaveBeenCalledWith('default-work-items')
  })

  it('uses real assignees and rechecks permission before mutation while preserving the form', async () => {
    const f = setup('backend')
    render(<CreateExperienceIssue {...f.props} />)
    chooseProject(f)
    await enterGoal('Keep this goal')
    choose('assignee', 'Colleague')
    f.get.mockResolvedValue({ ...f.project, access_role: 'Viewer' })
    fireEvent.click(screen.getByTestId('collaboration-exp-create-submit'))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('create.permissionDenied')
    )
    expect(f.create).not.toHaveBeenCalled()
    expect(screen.getByTestId('collaboration-exp-create-goal')).toHaveValue('Keep this goal')
    expect(screen.getByTestId('collaboration-exp-create-assignee')).toHaveTextContent('Colleague')
  })

  it('assigns actual cloud-project work to a real colleague without claiming it as personal work', async () => {
    const f = setup('backend')
    render(<CreateExperienceIssue {...f.props} />)
    chooseProject(f)
    await enterGoal()
    choose('assignee', 'Colleague')
    fireEvent.click(screen.getByTestId('collaboration-exp-create-submit'))
    await waitFor(() => expect(f.onCreated).toHaveBeenCalledOnce())
    expect(f.create).toHaveBeenCalledWith(
      'first-shared-project',
      expect.objectContaining({ assigneeUserId: 8 })
    )
    expect(f.create.mock.calls[0][1]).not.toHaveProperty('personalTask')
  })

  it('rejects a source returning another store instead of routing its object into this store', async () => {
    const f = setup('backend')
    f.get.mockResolvedValue({ ...f.project, project_store: 'local' })
    render(<CreateExperienceIssue {...f.props} />)
    chooseProject(f)
    await screen.findByText('create.sourceUnavailable')
    fireEvent.change(screen.getByTestId('collaboration-exp-create-goal'), {
      target: { value: 'Keep ownership exact' },
    })
    expect(screen.getByTestId('collaboration-exp-create-submit')).toBeDisabled()
    expect(f.create).not.toHaveBeenCalled()
  })

  it('rejects an assignee removed after loading without clearing the title or summary', async () => {
    const f = setup('backend')
    render(<CreateExperienceIssue {...f.props} />)
    chooseProject(f)
    await enterGoal()
    choose('assignee', 'Colleague')
    fireEvent.change(screen.getByTestId('collaboration-exp-create-summary'), {
      target: { value: 'Unsent summary' },
    })
    f.listMembers.mockResolvedValue([])
    fireEvent.click(screen.getByTestId('collaboration-exp-create-submit'))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('create.assigneeUnavailable')
    )
    expect(f.create).not.toHaveBeenCalled()
    expect(screen.getByTestId('collaboration-exp-create-summary')).toHaveValue('Unsent summary')
  })

  it('prevents duplicate creation and retains input after a failed request', async () => {
    const f = setup('backend')
    const request = deferred<typeof f.issue>()
    f.create.mockReturnValue(request.promise)
    render(<CreateExperienceIssue {...f.props} />)
    chooseProject(f)
    await enterGoal()
    fireEvent.click(screen.getByTestId('collaboration-exp-create-submit'))
    fireEvent.click(screen.getByTestId('collaboration-exp-create-submit'))
    await waitFor(() => expect(f.create).toHaveBeenCalledOnce())
    expect(screen.getByTestId('collaboration-exp-create-cancel')).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(f.onClose).not.toHaveBeenCalled()
    await act(async () => {
      request.resolve(f.issue)
    })
    expect(f.onCreated).toHaveBeenCalledOnce()
    f.create.mockRejectedValue(new Error('Connection lost'))
    fireEvent.click(screen.getByTestId('collaboration-exp-create-submit'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Connection lost'))
    expect(screen.getByTestId('collaboration-exp-create-goal')).toHaveValue(
      'Deliver the integration'
    )
  })

  it('does not read business APIs while inactive or invent a missing local owner identity', async () => {
    const f = setup()
    const view = render(<CreateExperienceIssue {...f.props} active={false} />)
    expect(f.get).not.toHaveBeenCalled()
    expect(f.listMembers).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    mocks.workbench = { state: { user: { id: 7, user_name: 'Owner' } }, services: {} }
    view.rerender(<CreateExperienceIssue {...f.props} />)
    await screen.findByText('create.sourceUnavailable')
    fireEvent.change(screen.getByTestId('collaboration-exp-create-goal'), {
      target: { value: 'Keep it local' },
    })
    expect(screen.getByTestId('collaboration-exp-create-submit')).toBeDisabled()
    expect(f.create).not.toHaveBeenCalled()
  })

  it('isolates an account switch from a pending admission and clears the previous form', async () => {
    const f = setup('backend')
    const view = render(<CreateExperienceIssue {...f.props} />)
    chooseProject(f)
    await enterGoal('First account private goal')
    const read = deferred<typeof f.project>()
    f.get.mockReturnValueOnce(read.promise)
    fireEvent.click(screen.getByTestId('collaboration-exp-create-submit'))
    mocks.workbench = { state: { user: { id: 8, user_name: 'Second owner' } }, services: {} }
    view.rerender(<CreateExperienceIssue {...f.props} />)
    await act(async () => {
      read.resolve(f.project)
    })
    expect(screen.getByTestId('collaboration-exp-create-goal')).toHaveValue('')
    expect(f.create).not.toHaveBeenCalled()
    expect(f.onCreated).not.toHaveBeenCalled()
  })
})
