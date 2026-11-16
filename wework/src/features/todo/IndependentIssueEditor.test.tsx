import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import type { PersonalIssuesApi } from '@/api/personalIssues'
import { IndependentIssueEditor } from './IndependentIssueEditor'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)

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
  await screen.findByRole('option', { name: 'Project one' })
  fireEvent.change(screen.getByTestId('independent-issue-project'), { target: { value: 'p1' } })
  fireEvent.click(screen.getByTestId('issue-participant-add'))
  fireEvent.change(screen.getByTestId('independent-issue-search-people'), {
    target: { value: 'Alice' },
  })
  fireEvent.click(await screen.findByTestId('independent-issue-invite-8'))
  fireEvent.click(screen.getByTestId('issue-participant-tab-agent'))
  fireEvent.click(await screen.findByTestId('issue-participant-invite-agent:12'))
  fireEvent.click(screen.getByTestId('issue-participant-tab-group'))
  fireEvent.click(await screen.findByTestId('issue-participant-invite-group:15'))
  fireEvent.change(screen.getByTestId('independent-issue-assignee'), {
    target: { value: 'agent:12' },
  })
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
  await screen.findByText('Project catalog unavailable')
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
