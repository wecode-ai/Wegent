import { StrictMode } from 'react'
import { act, fireEvent, render } from '@testing-library/react'
import QueryParamAutoSend from '@/features/tasks/components/params/QueryParamAutoSend'
import type { Team } from '@/types/api'

let mockSearchParams = new URLSearchParams()
let mockIsConnected = true
const mockReplace = jest.fn()

jest.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ replace: mockReplace }),
}))
jest.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({ isConnected: mockIsConnected }),
}))

type AutoSendProps = Parameters<typeof QueryParamAutoSend>[0]

const defaultTeam = { id: 10, name: 'default-team', namespace: 'default' } as Team
const recentTeam = { id: 20, name: 'recent-team', namespace: 'default' } as Team

function props(overrides: Partial<AutoSendProps> = {}): AutoSendProps {
  return {
    teams: [defaultTeam, recentTeam],
    isTeamsLoading: false,
    isTeamSelectionReady: true,
    selectedTeam: defaultTeam,
    onTeamChange: jest.fn(),
    onSendMessage: jest.fn().mockResolvedValue(undefined),
    hasTaskId: false,
    onPrefillMessage: jest.fn(),
    ...overrides,
  }
}

function setQuery(query: string) {
  mockSearchParams = new URLSearchParams(query)
  window.history.replaceState({}, '', `/chat?${mockSearchParams}`)
}

function advance(milliseconds = 200) {
  act(() => jest.advanceTimersByTime(milliseconds))
}

beforeEach(() => {
  jest.useFakeTimers()
  mockIsConnected = true
  mockReplace.mockReset()
  setQuery('q=hello&autoSend=true&projectId=3')
})

afterEach(() => {
  jest.clearAllTimers()
  jest.useRealTimers()
})

it('prefills immediately and sends through the latest callback after selection is ready', () => {
  setQuery('q=hello&autoSend=true&teamId=20&recommend=1&projectId=3')
  const initial = props({ isTeamSelectionReady: false })
  const { rerender } = render(<QueryParamAutoSend {...initial} />)

  expect(initial.onPrefillMessage).toHaveBeenCalledWith('hello')
  advance(600)
  expect(initial.onSendMessage).not.toHaveBeenCalled()

  const sendWithFinalTeam = jest.fn().mockResolvedValue(undefined)
  rerender(
    <QueryParamAutoSend
      {...initial}
      isTeamSelectionReady
      selectedTeam={recentTeam}
      onSendMessage={sendWithFinalTeam}
    />
  )
  advance()
  expect(initial.onSendMessage).not.toHaveBeenCalled()
  expect(sendWithFinalTeam).toHaveBeenCalledWith('hello', expect.any(Function))
  expect(mockReplace).not.toHaveBeenCalled()
  // The send callback navigates using the query captured before auto-send.
  setQuery('q=hello&autoSend=true&teamId=20&recommend=1&projectId=3&taskId=42')
  rerender(
    <QueryParamAutoSend
      {...initial}
      hasTaskId
      isTeamSelectionReady
      selectedTeam={recentTeam}
      onSendMessage={sendWithFinalTeam}
    />
  )
  expect(mockReplace).toHaveBeenCalledTimes(1)
  expect(mockReplace).toHaveBeenCalledWith('/chat?projectId=3&taskId=42')
  advance(1000)
  expect(sendWithFinalTeam).toHaveBeenCalledTimes(1)
})

it('does not send without a selected team even if readiness is true', () => {
  const initial = props({ selectedTeam: null })
  render(<QueryParamAutoSend {...initial} />)

  advance(10_200)
  expect(initial.onSendMessage).not.toHaveBeenCalled()
  expect(mockReplace).toHaveBeenCalledTimes(1)
  expect(mockReplace).toHaveBeenCalledWith('/chat?projectId=3')
})

it.each(['reported', 'rejected'])('cleans the query after a %s send failure', async kind => {
  const onSendMessage: AutoSendProps['onSendMessage'] = jest.fn(async (_message, onFailure) => {
    if (kind === 'rejected') throw new Error('Send failed')
    onFailure()
  })
  const initial = props({ onSendMessage })
  await act(async () => {
    render(<QueryParamAutoSend {...initial} />)
  })

  expect(initial.onSendMessage).toHaveBeenCalledTimes(1)
  expect(mockReplace).toHaveBeenCalledWith('/chat?projectId=3')
  advance(1000)
  expect(initial.onSendMessage).toHaveBeenCalledTimes(1)
})

it('handles a second URL prompt without resending the original on back navigation', () => {
  const initial = props()
  const { rerender } = render(<QueryParamAutoSend {...initial} />)
  expect(initial.onSendMessage).toHaveBeenCalledWith('hello', expect.any(Function))

  setQuery('q=hello&autoSend=true&projectId=3&taskId=42')
  rerender(<QueryParamAutoSend {...initial} hasTaskId />)
  expect(mockReplace).toHaveBeenLastCalledWith('/chat?projectId=3&taskId=42')

  setQuery('q=second&autoSend=true&teamId=20')
  rerender(<QueryParamAutoSend {...initial} selectedTeam={recentTeam} />)
  expect(initial.onPrefillMessage).toHaveBeenLastCalledWith('second')
  expect(initial.onSendMessage).toHaveBeenLastCalledWith('second', expect.any(Function))

  setQuery('q=hello&autoSend=true&projectId=3')
  rerender(<QueryParamAutoSend {...initial} />)
  advance()
  expect(initial.onSendMessage).toHaveBeenCalledTimes(2)
})

it.each(['projectId', 'conversationGroupId'])(
  'sends identical prompts to distinct targets selected by %s',
  targetParam => {
    const first = new URLSearchParams({ q: 'hello', autoSend: 'true', [targetParam]: '3' })
    const second = new URLSearchParams({ q: 'hello', autoSend: 'true', [targetParam]: '4' })
    setQuery(first.toString())
    const initial = props()
    const { rerender } = render(<QueryParamAutoSend {...initial} />)
    expect(initial.onSendMessage).toHaveBeenCalledTimes(1)

    setQuery(second.toString())
    rerender(<QueryParamAutoSend {...initial} />)
    expect(initial.onSendMessage).toHaveBeenCalledTimes(2)

    const accepted = new URLSearchParams(second)
    accepted.set('taskId', '42')
    setQuery(accepted.toString())
    rerender(<QueryParamAutoSend {...initial} hasTaskId />)
    expect(mockReplace).toHaveBeenLastCalledWith(
      targetParam === 'projectId' ? '/chat?projectId=4&taskId=42' : '/chat?taskId=42'
    )

    setQuery(first.toString())
    rerender(<QueryParamAutoSend {...initial} />)
    expect(initial.onSendMessage).toHaveBeenCalledTimes(2)
  }
)

it.each(['projectId=4', 'conversationGroupId=3'])(
  'keeps the replacement target %s when the previous project send fails',
  async target => {
    const onSendMessage = jest
      .fn<ReturnType<AutoSendProps['onSendMessage']>, Parameters<AutoSendProps['onSendMessage']>>()
      .mockResolvedValue(undefined)
    const initial = props({ onSendMessage })
    const view = render(<QueryParamAutoSend {...initial} />)
    const onFailure = onSendMessage.mock.calls[0][1]

    setQuery(`q=hello&autoSend=true&${target}`)
    await act(async () => onFailure())
    expect(mockReplace).not.toHaveBeenCalled()
    view.rerender(<QueryParamAutoSend {...initial} />)
    expect(onSendMessage).toHaveBeenCalledTimes(2)

    setQuery('q=hello&autoSend=true&projectId=3')
    view.rerender(<QueryParamAutoSend {...initial} />)
    expect(onSendMessage).toHaveBeenCalledTimes(2)
  }
)

it('leaves a replacement link intact when the earlier send rejects', async () => {
  let rejectFirst!: (error: Error) => void
  const onSendMessage = jest
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirst = reject
        })
    )
    .mockResolvedValue(undefined)
  const initial = props({ onSendMessage })
  const { rerender } = render(<QueryParamAutoSend {...initial} />)

  setQuery('q=new+draft&teamId=20')
  await act(async () => rejectFirst(new Error('Send failed')))
  expect(mockReplace).not.toHaveBeenCalled()

  rerender(<QueryParamAutoSend {...initial} selectedTeam={recentTeam} />)
  expect(initial.onPrefillMessage).toHaveBeenLastCalledWith('new draft')
  expect(onSendMessage).toHaveBeenCalledTimes(1)
})

it('waits for the requested team name to commit', () => {
  setQuery('q=hello&autoSend=true&teamName=recent-team&teamNamespace=default')
  const initial = props({ isTeamSelectionReady: false })
  const { rerender } = render(<QueryParamAutoSend {...initial} />)

  expect(initial.onTeamChange).toHaveBeenCalledWith(recentTeam)
  advance(600)
  expect(initial.onTeamChange).toHaveBeenCalledTimes(1)
  expect(initial.onSendMessage).not.toHaveBeenCalled()

  rerender(<QueryParamAutoSend {...initial} isTeamSelectionReady />)
  advance()
  expect(initial.onSendMessage).not.toHaveBeenCalled()
  rerender(<QueryParamAutoSend {...initial} selectedTeam={recentTeam} />)
  advance()
  expect(initial.onSendMessage).not.toHaveBeenCalled()

  rerender(<QueryParamAutoSend {...initial} selectedTeam={recentTeam} isTeamSelectionReady />)
  advance()
  expect(initial.onSendMessage).toHaveBeenCalledTimes(1)
  expect(initial.onSendMessage).toHaveBeenCalledWith('hello', expect.any(Function))
})

it('times out rather than sending with a URL team change that never commits', () => {
  setQuery('q=hello&autoSend=true&teamId=20&recommend=1')
  const initial = props()
  render(<QueryParamAutoSend {...initial} />)

  advance(10_200)
  expect(initial.onTeamChange).not.toHaveBeenCalled()
  expect(initial.onSendMessage).not.toHaveBeenCalled()
  expect(mockReplace).toHaveBeenCalledWith('/chat?teamId=20&recommend=1')
})

it('honors an explicit ID ahead of a team name without waiting for the catalog', () => {
  setQuery('q=100%25+match&autoSend=true&teamId=20&teamName=default-team')
  mockIsConnected = false
  const initial = props({ isTeamsLoading: true })
  const { rerender } = render(<QueryParamAutoSend {...initial} />)
  advance(400)
  expect(initial.onTeamChange).not.toHaveBeenCalled()
  expect(initial.onSendMessage).not.toHaveBeenCalled()

  mockIsConnected = true
  rerender(<QueryParamAutoSend {...initial} />)
  advance()
  expect(initial.onTeamChange).not.toHaveBeenCalled()
  expect(initial.onSendMessage).not.toHaveBeenCalled()
  rerender(<QueryParamAutoSend {...initial} selectedTeam={recentTeam} />)
  advance()
  expect(initial.onTeamChange).not.toHaveBeenCalled()
  expect(initial.onPrefillMessage).toHaveBeenCalledWith('100% match')
  expect(initial.onSendMessage).toHaveBeenCalledWith('100% match', expect.any(Function))
})

it.each([
  ['empty', ''],
  ['non-numeric', 'abc'],
])('falls back to the team name when teamId is %s', (_label, teamId) => {
  setQuery(`q=hello&autoSend=true&teamId=${teamId}&teamName=recent-team&teamNamespace=default`)
  const initial = props({ isTeamSelectionReady: false })
  const { rerender } = render(<QueryParamAutoSend {...initial} />)

  expect(initial.onTeamChange).toHaveBeenCalledWith(recentTeam)
  rerender(<QueryParamAutoSend {...initial} selectedTeam={recentTeam} isTeamSelectionReady />)
  advance()
  expect(initial.onSendMessage).toHaveBeenCalledTimes(1)
  expect(initial.onSendMessage).toHaveBeenCalledWith('hello', expect.any(Function))
})

it('keeps a prompt as a draft when the explicit ID is invalid and no name was provided', () => {
  setQuery('q=hello&autoSend=true&teamId=invalid')
  const initial = props({ isTeamSelectionReady: false })
  const { rerender } = render(<QueryParamAutoSend {...initial} />)

  expect(initial.onPrefillMessage).toHaveBeenCalledWith('hello')
  rerender(<QueryParamAutoSend {...initial} isTeamSelectionReady />)
  advance()
  expect(initial.onSendMessage).not.toHaveBeenCalled()
  expect(mockReplace).toHaveBeenCalledWith('/chat?teamId=invalid')
})

it('preserves modifier keys and cancels automatic sending after user input', () => {
  const initial = props({ isTeamSelectionReady: false })
  const { rerender } = render(<QueryParamAutoSend {...initial} />)
  fireEvent.keyDown(window, { key: 'Shift' })
  advance()
  expect(mockReplace).not.toHaveBeenCalled()

  fireEvent.keyDown(window, { key: 'x' })
  rerender(<QueryParamAutoSend {...initial} isTeamSelectionReady />)
  advance()
  expect(initial.onSendMessage).not.toHaveBeenCalled()
  expect(mockReplace).toHaveBeenCalledWith('/chat?projectId=3')
})

it('only prefills when automatic sending is not requested', () => {
  setQuery('q=hello')
  const initial = props()
  render(<QueryParamAutoSend {...initial} />)

  expect(initial.onPrefillMessage).toHaveBeenCalledWith('hello')
  expect(initial.onSendMessage).not.toHaveBeenCalled()
  expect(jest.getTimerCount()).toBe(0)
})

it('ignores the same query action when it was opened with an existing task', () => {
  const initial = props({ hasTaskId: true })
  const { rerender } = render(<QueryParamAutoSend {...initial} />)

  advance(400)
  rerender(<QueryParamAutoSend {...initial} hasTaskId={false} />)
  advance(400)
  expect(initial.onPrefillMessage).not.toHaveBeenCalled()
  expect(initial.onSendMessage).not.toHaveBeenCalled()
  expect(mockReplace).not.toHaveBeenCalled()
})

it('continues waiting through StrictMode replay and sends once when selection commits', () => {
  const initial = props({ isTeamSelectionReady: false })
  const { rerender } = render(
    <StrictMode>
      <QueryParamAutoSend {...initial} />
    </StrictMode>
  )
  expect(initial.onSendMessage).not.toHaveBeenCalled()

  rerender(
    <StrictMode>
      <QueryParamAutoSend {...initial} selectedTeam={recentTeam} isTeamSelectionReady />
    </StrictMode>
  )
  advance()
  expect(initial.onSendMessage).toHaveBeenCalledTimes(1)
  advance(1000)
  expect(initial.onSendMessage).toHaveBeenCalledTimes(1)
  expect(initial.onPrefillMessage).toHaveBeenCalledTimes(1)
})

it('cancels polling when unmounted', () => {
  const initial = props({ isTeamSelectionReady: false })
  const { unmount } = render(<QueryParamAutoSend {...initial} />)

  unmount()
  expect(jest.getTimerCount()).toBe(0)
  advance(10_200)
  expect(initial.onSendMessage).not.toHaveBeenCalled()
  expect(mockReplace).not.toHaveBeenCalled()
})
