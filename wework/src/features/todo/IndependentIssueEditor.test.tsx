import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import type { PersonalIssuesApi } from '@/api/personalIssues'
import { IndependentIssueEditor } from './IndependentIssueEditor'
import userEvent from '@testing-library/user-event'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)

it('announces project loading without blocking the Issue fields', async () => {
  const personal = api()
  let resolve!: (page: { items: never[] }) => void
  vi.mocked(personal.projects).mockReturnValue(
    new Promise(done => {
      resolve = done
    })
  )
  render(
    <IndependentIssueEditor
      api={personal}
      userId={7}
      issue={null}
      busy={false}
      onSave={vi.fn()}
      onCancel={vi.fn()}
    />
  )
  expect(screen.getByTestId('issue-project-loading')).toHaveAttribute('role', 'status')
  expect(screen.getByTestId('issue-project-loading')).toHaveTextContent(
    'issue_creation.projects_loading'
  )
  expect(screen.getByTestId('independent-issue-project')).toBeDisabled()
  fireEvent.change(screen.getByTestId('independent-issue-title'), {
    target: { value: 'Write while loading' },
  })
  expect(screen.getByTestId('independent-issue-title')).toHaveValue('Write while loading')
  expect(screen.getByTestId('independent-issue-save')).toBeEnabled()
  resolve({ items: [] })
  await waitFor(() => expect(screen.queryByTestId('issue-project-loading')).not.toBeInTheDocument())
  expect(screen.getByTestId('independent-issue-project')).toBeEnabled()
})

it('retains the chosen identity of same-name Agents in chips and assignment without changing invitation payloads', async () => {
  const collaborationApi = {
    resources: {
      list: vi.fn().mockResolvedValue({
        agents: [12, 13].map(id => ({
          id: String(id),
          name: 'Review',
          owner_type: 'user',
          owner_id: '7',
          location: 'cloud',
        })),
      }),
    },
  } as unknown as SharedWorkspaceApi
  const save = vi.fn()
  render(
    <IndependentIssueEditor
      api={api()}
      collaborationApi={collaborationApi}
      userId={7}
      issue={null}
      busy={false}
      onSave={save}
      onCancel={vi.fn()}
    />
  )
  fireEvent.change(screen.getByTestId('independent-issue-title'), {
    target: { value: 'Choose the right Agent' },
  })
  fireEvent.click(screen.getByTestId('issue-participant-add'))
  fireEvent.click(screen.getByTestId('issue-participant-tab-agent'))
  expect(await screen.findByTestId('issue-participant-invite-agent:12')).toHaveTextContent(
    'Review · #12'
  )
  const target = screen.getByTestId('issue-participant-invite-agent:13')
  expect(target).toHaveTextContent('Review · #13')
  expect(target).toHaveAccessibleName('Review · #13 · issue_creation.participant_agent')
  fireEvent.click(target)
  fireEvent.click(screen.getByTestId('issue-participant-done'))
  expect(screen.getByTestId('issue-participants')).toHaveTextContent('Review · #13')
  fireEvent.click(screen.getByTestId('independent-issue-assignee'))
  const assignment = screen.getByTestId('independent-issue-assignee-option-agent:13')
  expect(assignment).toHaveTextContent('Review')
  expect(assignment).toHaveTextContent('#13')
  fireEvent.click(assignment)
  fireEvent.click(screen.getByTestId('independent-issue-save'))
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      resource_participants: [{ kind: 'agent', id: 13 }],
      assignee_resource: { kind: 'agent', id: 13 },
    })
  )
})

it('searches and distinguishes same-name projects while keeping keyboard navigation inside the draft', async () => {
  const personal = api()
  vi.mocked(personal.projects).mockResolvedValue({
    items: [
      {
        id: 'one',
        name: 'Release',
        project_key: 'WEB',
        workspace_context: { name: 'Web team' },
        task_provider: 'local',
        access_role: 'Developer',
      },
      {
        id: 'two',
        name: 'Release',
        project_key: 'APP',
        workspace_context: { name: 'App team' },
        task_provider: 'local',
        access_role: 'Developer',
      },
    ],
  } as never)
  const save = vi.fn()
  const user = userEvent.setup()
  render(
    <IndependentIssueEditor
      api={personal}
      userId={7}
      issue={null}
      busy={false}
      onSave={save}
      onCancel={vi.fn()}
    />
  )
  await user.type(screen.getByTestId('independent-issue-title'), 'Keep this draft')
  const trigger = screen.getByTestId('independent-issue-project')
  await waitFor(() => expect(trigger).toBeEnabled())
  await user.click(trigger)
  const search = screen.getByTestId('independent-issue-project-search')
  await waitFor(() => expect(search).toHaveFocus())
  await user.type(search, '  app team  ')
  expect(screen.queryByTestId('independent-issue-project-option-one')).not.toBeInTheDocument()
  expect(screen.getByTestId('independent-issue-project-option-two')).toHaveTextContent(
    /Release.*APP/
  )
  await user.keyboard('{Enter}')
  expect(save).not.toHaveBeenCalled()
  await user.keyboard('{ArrowDown}')
  expect(screen.getByTestId('independent-issue-project-option-two')).toHaveFocus()
  await user.keyboard('{Enter}')
  await waitFor(() => expect(trigger).toHaveFocus())
  expect(trigger).toHaveTextContent('App team / Release · APP')
  expect(trigger).toHaveAccessibleDescription('App team · Release · APP')
  await user.click(trigger)
  await user.keyboard('{Escape}')
  await waitFor(() => expect(trigger).toHaveFocus())
  expect(screen.getByTestId('independent-issue-title')).toHaveValue('Keep this draft')
  await user.click(screen.getByTestId('independent-issue-save'))
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'two' }))
})

const api = () =>
  ({
    projects: vi.fn().mockResolvedValue({
      items: [
        {
          id: 'p1',
          name: 'Project one',
          task_provider: 'backend',
          access_role: 'Developer',
          board_config: { statuses: [{ id: 'todo', name: 'To do' }] },
        },
      ],
    }),
    searchUsers: vi.fn().mockResolvedValue({ users: [{ id: 8, user_name: 'Alice' }] }),
  }) as unknown as PersonalIssuesApi

it('creates one draft with an optional project, invited people, Agents and teams without starting execution', async () => {
  const save = vi.fn().mockResolvedValue(undefined)
  const collaborationApi = {
    resources: {
      list: vi.fn().mockResolvedValue({
        agents: [
          {
            id: '12',
            name: 'Coding Agent',
            owner_type: 'user',
            owner_id: '7',
            location: 'cloud',
          },
        ],
      }),
    },
    workspaces: {
      list: vi.fn().mockResolvedValue([{ id: 'w', location: 'cloud' }]),
      listCollaborationGroups: vi.fn().mockResolvedValue([{ id: '15', name: 'Engineering team' }]),
    },
  } as unknown as SharedWorkspaceApi
  render(
    <IndependentIssueEditor
      api={api()}
      collaborationApi={collaborationApi}
      userId={7}
      issue={null}
      busy={false}
      onSave={save}
      onCancel={vi.fn()}
    />
  )
  expect(screen.queryByText(/创建之后/)).not.toBeInTheDocument()
  fireEvent.change(screen.getByTestId('independent-issue-title'), {
    target: { value: 'Ship the new flow' },
  })
  await waitFor(() => expect(screen.getByTestId('independent-issue-project')).toBeEnabled())
  fireEvent.click(screen.getByTestId('independent-issue-project'))
  fireEvent.click(await screen.findByTestId('independent-issue-project-option-p1'))
  fireEvent.click(screen.getByTestId('issue-participant-add'))
  fireEvent.change(screen.getByTestId('independent-issue-search-people'), {
    target: { value: 'Alice' },
  })
  fireEvent.click(await screen.findByTestId('independent-issue-invite-8'))
  fireEvent.click(screen.getByTestId('issue-participant-tab-agent'))
  fireEvent.click(await screen.findByTestId('issue-participant-invite-agent:12'))
  fireEvent.click(screen.getByTestId('issue-participant-tab-group'))
  fireEvent.click(await screen.findByTestId('issue-participant-invite-group:15'))
  fireEvent.click(screen.getByTestId('issue-participant-done'))
  fireEvent.click(screen.getByTestId('independent-issue-assignee'))
  fireEvent.click(await screen.findByTestId('independent-issue-assignee-option-agent:12'))
  fireEvent.click(screen.getByTestId('independent-issue-save'))
  await waitFor(() => expect(save).toHaveBeenCalledOnce())
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      title: 'Ship the new flow',
      project_id: 'p1',
      project_status: 'todo',
      participants: [8],
      resource_participants: [
        { kind: 'agent', id: 12 },
        { kind: 'group', id: 15 },
      ],
      assignee_id: null,
      assignee_resource: { kind: 'agent', id: 12 },
    })
  )
})

it('allows independent creation when the optional project catalog fails and clears a removed Agent assignment', async () => {
  const save = vi.fn().mockResolvedValue(undefined)
  const personal = api()
  vi.mocked(personal.projects).mockRejectedValue(new Error('Project catalog unavailable'))
  const issue = {
    id: 'i',
    title: 'Standalone',
    description: '',
    status: 'pending',
    priority: 'medium',
    creator_id: 7,
    assignee_id: null,
    people: {},
    metadata: {
      standalone: true,
      participants: [],
      resource_participants: [{ kind: 'agent', id: 12, name: 'Agent' }],
      assignee_resource: { kind: 'agent', id: 12 },
      archived: false,
      due_at: null,
    },
    version: 1,
  } as never
  const { unmount } = render(
    <IndependentIssueEditor
      api={personal}
      userId={7}
      issue={null}
      busy={false}
      onSave={save}
      onCancel={vi.fn()}
    />
  )
  await screen.findByText('issue_creation.projects_load_failed')
  expect(screen.queryByText('Project catalog unavailable')).not.toBeInTheDocument()
  fireEvent.change(screen.getByTestId('independent-issue-title'), {
    target: { value: 'Independent' },
  })
  fireEvent.click(screen.getByTestId('independent-issue-save'))
  expect(save).toHaveBeenCalledWith(expect.not.objectContaining({ project_id: expect.anything() }))
  unmount()
  render(
    <IndependentIssueEditor
      api={personal}
      userId={7}
      issue={issue}
      busy={false}
      onSave={save}
      onCancel={vi.fn()}
    />
  )
  fireEvent.click(screen.getByTestId('issue-participant-remove-agent:12'))
  fireEvent.click(screen.getByTestId('independent-issue-save'))
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({ resource_participants: [], assignee_resource: null })
  )
})
