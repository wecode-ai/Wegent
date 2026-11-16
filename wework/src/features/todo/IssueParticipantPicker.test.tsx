import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import type { PersonalIssuesApi } from '@/api/personalIssues'
import { IssueParticipantPicker } from './IssueParticipantPicker'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)

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
