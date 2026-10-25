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
  expect(sendWithFinalTeam).toHaveBeenCalledWith('hello')
  expect(mockReplace).not.toHaveBeenCalled()
  // The send callback navigates using the query captured before auto-send.
  setQuery('q=hello&autoSend=true&teamId=20&projectId=3&taskId=42')
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

it('cleans the query when sending rejects without task navigation', async () => {
  const initial = props({ onSendMessage: jest.fn().mockRejectedValue(new Error('Send failed')) })
  await act(async () => {
    render(<QueryParamAutoSend {...initial} />)
  })

  expect(initial.onSendMessage).toHaveBeenCalledTimes(1)
  expect(mockReplace).toHaveBeenCalledWith('/chat?projectId=3')
  advance(1000)
  expect(initial.onSendMessage).toHaveBeenCalledTimes(1)
})

it.each(['teamId=20&teamName=default-team', 'teamName=recent-team&teamNamespace=default'])(
  'waits for the requested URL team to commit for %s',
  target => {
    setQuery(`q=hello&autoSend=true&${target}`)
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
    expect(initial.onSendMessage).toHaveBeenCalledWith('hello')
  }
)

it('times out rather than sending with a URL team change that never commits', () => {
  setQuery('q=hello&autoSend=true&teamId=20')
  const initial = props()
  render(<QueryParamAutoSend {...initial} />)

  advance(10_200)
  expect(initial.onTeamChange).toHaveBeenCalledTimes(1)
  expect(initial.onSendMessage).not.toHaveBeenCalled()
  expect(mockReplace).toHaveBeenCalledWith('/chat')
})

it('waits for the latest connection and catalog state before selecting and sending', () => {
  setQuery('q=hello&autoSend=true&teamId=20')
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
  rerender(<QueryParamAutoSend {...initial} isTeamsLoading={false} />)
  advance()
  expect(initial.onTeamChange).toHaveBeenCalledWith(recentTeam)
  expect(initial.onSendMessage).not.toHaveBeenCalled()
  rerender(<QueryParamAutoSend {...initial} isTeamsLoading={false} selectedTeam={recentTeam} />)
  advance()
  expect(initial.onSendMessage).toHaveBeenCalledWith('hello')
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

it('ignores query text while viewing an existing task', () => {
  const initial = props({ hasTaskId: true })
  render(<QueryParamAutoSend {...initial} />)

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
