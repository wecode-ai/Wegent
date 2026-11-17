import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import type { PersonalIssuesApi } from '@/api/personalIssues'
import { IssueParticipantPicker } from './IssueParticipantPicker'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)

it.each(['agent', 'group'] as const)(
  'filters an already loaded %s directory without reloading it for each keystroke',
  async kind => {
    const listAgents = vi.fn().mockResolvedValue({
      agents: [
        { id: '12', name: 'Alice Agent', location: 'cloud', owner_type: 'user', owner_id: '7' },
      ],
    })
    const listSpaces = vi.fn().mockResolvedValue([{ id: 'w', location: 'cloud' }])
    const listGroups = vi.fn().mockResolvedValue([{ id: '15', name: 'Alice Group' }])
    const collaborationApi = {
      resources: { list: listAgents },
      workspaces: { list: listSpaces, listCollaborationGroups: listGroups },
    } as unknown as SharedWorkspaceApi
    render(
      <IssueParticipantPicker
        api={{} as PersonalIssuesApi}
        collaborationApi={collaborationApi}
        userId={7}
        selected={[]}
        onChange={vi.fn()}
        disabled={false}
      />
    )
    fireEvent.click(screen.getByTestId('issue-participant-add'))
    fireEvent.click(screen.getByTestId(`issue-participant-tab-${kind}`))
    const result = `issue-participant-invite-${kind}:${kind === 'agent' ? 12 : 15}`
    await screen.findByTestId(result)
    const search = screen.getByTestId('independent-issue-search-people')
    await userEvent.type(search, 'Alice')
    await screen.findByTestId(result)
    expect(kind === 'agent' ? listAgents : listSpaces).toHaveBeenCalledOnce()
    if (kind === 'group') expect(listGroups).toHaveBeenCalledOnce()
    await userEvent.clear(search)
    expect(screen.getByTestId(result)).toBeVisible()
    expect(screen.getByTestId('issue-participant-results-status')).not.toHaveTextContent(
      'issue_creation.participants_loading'
    )
  }
)

it('keeps a polite result status mounted across loading, empty results and matches', async () => {
  const searchUsers = vi
    .fn()
    .mockResolvedValueOnce({ users: [] })
    .mockResolvedValueOnce({ users: [{ id: 8, user_name: 'Alice' }] })
  render(
    <IssueParticipantPicker
      api={{ searchUsers } as unknown as PersonalIssuesApi}
      userId={7}
      selected={[]}
      onChange={vi.fn()}
      disabled={false}
    />
  )
  fireEvent.click(screen.getByTestId('issue-participant-add'))
  const status = screen.getByTestId('issue-participant-results-status')
  expect(status).toHaveAttribute('role', 'status')
  expect(status).toHaveAttribute('aria-live', 'polite')
  fireEvent.change(screen.getByTestId('independent-issue-search-people'), {
    target: { value: 'Missing' },
  })
  await waitFor(() => expect(status).toHaveTextContent('issue_creation.no_participants'))
  expect(screen.getByTestId('issue-participant-results-status')).toBe(status)
  fireEvent.change(screen.getByTestId('independent-issue-search-people'), {
    target: { value: 'Alice' },
  })
  await screen.findByTestId('independent-issue-invite-8')
  expect(screen.getByTestId('issue-participant-results-status')).toBe(status)
  expect(status).toHaveTextContent('issue_creation.participant_results')
  expect(screen.getByRole('tabpanel')).toContainElement(status)
})

it('shows a localized participant failure and retries the same search without changing invitations', async () => {
  const searchUsers = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValue({ users: [{ id: 8, user_name: 'Alice' }] })
  const onChange = vi.fn()
  render(
    <IssueParticipantPicker
      api={{ searchUsers } as unknown as PersonalIssuesApi}
      userId={7}
      selected={[]}
      onChange={onChange}
      disabled={false}
    />
  )
  fireEvent.click(screen.getByTestId('issue-participant-add'))
  fireEvent.change(screen.getByTestId('independent-issue-search-people'), {
    target: { value: 'Alice' },
  })
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'issue_creation.participants_load_failed'
  )
  expect(screen.queryByText('Failed to fetch')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('issue-participant-retry'))
  await screen.findByTestId('independent-issue-invite-8')
  expect(searchUsers).toHaveBeenLastCalledWith('Alice')
  expect(onChange).not.toHaveBeenCalled()
})

it('supports keyboard tab navigation and restores the trigger when the popover closes', async () => {
  render(
    <IssueParticipantPicker
      api={{} as PersonalIssuesApi}
      userId={7}
      selected={[]}
      onChange={vi.fn()}
      disabled={false}
    />
  )
  const trigger = screen.getByTestId('issue-participant-add')
  await userEvent.click(trigger)
  await waitFor(() => expect(screen.getByTestId('independent-issue-search-people')).toHaveFocus())
  screen.getByTestId('issue-participant-tab-human').focus()
  await userEvent.keyboard('{ArrowRight}')
  expect(screen.getByTestId('issue-participant-tab-agent')).toHaveFocus()
  expect(screen.getByTestId('issue-participant-tab-agent')).toHaveAttribute('aria-selected', 'true')
  await userEvent.keyboard('{End}')
  expect(screen.getByTestId('issue-participant-tab-group')).toHaveFocus()
  await userEvent.keyboard('{Escape}')
  await waitFor(() =>
    expect(screen.queryByTestId('issue-participant-picker')).not.toBeInTheDocument()
  )
  expect(trigger).toHaveFocus()
})

it.each(['account', 'backend'])(
  'hides previous candidates immediately when the %s changes',
  async scope => {
    let resolve!: (value: unknown) => void
    const pending = new Promise(value => {
      resolve = value
    })
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        agents: [
          {
            id: '12',
            name: 'Previous agent',
            location: 'cloud',
            owner_type: 'user',
            owner_id: '7',
          },
        ],
      })
      .mockReturnValue(pending)
    const collaborationApi = { resources: { list } } as unknown as SharedWorkspaceApi
    const api = {} as PersonalIssuesApi
    const props = {
      api,
      collaborationApi,
      selected: [],
      onChange: vi.fn(),
      disabled: false,
      userId: 7,
    }
    const { rerender } = render(<IssueParticipantPicker {...props} />)
    fireEvent.click(screen.getByTestId('issue-participant-add'))
    fireEvent.click(screen.getByTestId('issue-participant-tab-agent'))
    await screen.findByTestId('issue-participant-invite-agent:12')
    const next = {
      ...props,
      ...(scope === 'account' ? { userId: 8 } : { api: {} as PersonalIssuesApi }),
    }
    rerender(<IssueParticipantPicker {...next} />)
    expect(screen.queryByTestId('issue-participant-invite-agent:12')).not.toBeInTheDocument()
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    resolve({
      agents: [
        {
          id: '22',
          name: 'Current agent',
          location: 'cloud',
          owner_type: 'user',
          owner_id: String(next.userId),
        },
      ],
    })
    await screen.findByTestId('issue-participant-invite-agent:22')
    expect(screen.queryByTestId('issue-participant-invite-agent:12')).not.toBeInTheDocument()
  }
)

it.each([
  ['human', 8, 'independent-issue-invite-8'],
  ['agent', 12, 'issue-participant-invite-agent:12'],
  ['group', 15, 'issue-participant-invite-group:15'],
] as const)(
  'finds and selects %s participants with padded mixed-case search text',
  async (kind, id, result) => {
    const searchUsers = vi.fn().mockResolvedValue({ users: [{ id: 8, user_name: 'Alice' }] })
    const collaborationApi = {
      resources: {
        list: vi.fn().mockResolvedValue({
          agents: [
            { id: '12', name: 'Alice Agent', location: 'cloud', owner_type: 'user', owner_id: '7' },
          ],
        }),
      },
      workspaces: {
        list: vi.fn().mockResolvedValue([{ id: 'w', location: 'cloud' }]),
        listCollaborationGroups: vi.fn().mockResolvedValue([{ id: '15', name: 'Alice Group' }]),
      },
    } as unknown as SharedWorkspaceApi
    const change = vi.fn()
    render(
      <IssueParticipantPicker
        api={{ searchUsers } as unknown as PersonalIssuesApi}
        collaborationApi={collaborationApi}
        selected={[]}
        onChange={change}
        disabled={false}
        userId={7}
      />
    )
    fireEvent.click(screen.getByTestId('issue-participant-add'))
    if (kind !== 'human') fireEvent.click(screen.getByTestId(`issue-participant-tab-${kind}`))
    fireEvent.change(screen.getByTestId('independent-issue-search-people'), {
      target: { value: '  ALICE  ' },
    })
    fireEvent.click(await screen.findByTestId(result))
    expect(change).toHaveBeenCalledWith([expect.objectContaining({ kind, id })])
    if (kind === 'human') expect(searchUsers).toHaveBeenCalledWith('ALICE')
  }
)
