import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { useLocalConnectorAuthGate } from './useLocalConnectorAuthGate'
import { ConnectorAuthCard } from '@/components/chat/ConnectorAuthCard'
import { GITHUB_CLI_TARGET } from '@/api/local/githubCli'
import type { WorkbenchMessage } from '@/types/workbench'

const mocks = vi.hoisted(() => ({
  health: vi.fn(),
  start: vi.fn(),
  poll: vi.fn(),
  cancel: vi.fn(),
}))
vi.mock('@/api/local/localConnectorAuth', async original => ({
  ...(await original<typeof import('@/api/local/localConnectorAuth')>()),
  localConnectorAuthHealth: mocks.health,
  localConnectorAuthStart: mocks.start,
  localConnectorAuthPoll: mocks.poll,
  localConnectorAuthCancel: mocks.cancel,
}))
const input = '[$GitHub](plugin://github@openai-curated-remote) 查看项目列表'
function Conversation({
  onSend,
  messages = [],
  onRetry = () => true,
  taskInput = input,
  onError,
}: {
  onSend: (text: string) => void
  messages?: WorkbenchMessage[]
  onRetry?: (message: WorkbenchMessage) => boolean
  taskInput?: string
  onError?: (message: string) => void
}) {
  const gate = useLocalConnectorAuthGate({
    messages,
    onResumeSend: onSend,
    onRetryMessage: onRetry,
    onError,
  })
  return (
    <>
      <button
        onClick={async () => {
          if ((await gate.gateBeforeSend(taskInput)) === 'send') onSend(taskInput)
        }}
      >
        GitHub task
      </button>
      <button
        onClick={async () => {
          if ((await gate.gateBeforeSend('Hello')) === 'send') onSend('Hello')
        }}
      >
        Ordinary task
      </button>
      {gate.pending ? (
        <ConnectorAuthCard
          target={gate.pending.target}
          title={gate.pending.title}
          onSuccess={() => void gate.completePending()}
          onCancel={gate.clearPending}
        />
      ) : null}
    </>
  )
}

beforeEach(() => {
  mocks.health.mockReset()
  mocks.start.mockReset()
  mocks.poll.mockReset()
  mocks.cancel.mockReset().mockResolvedValue({ status: 'cancelled' })
})

test('GitHub preflight checks gh on every send, and resumes exactly once after native verification', async () => {
  mocks.health.mockResolvedValueOnce({ status: 'ok' }).mockResolvedValue({ status: 'need_login' })
  mocks.start.mockResolvedValue({ status: 'waiting_browser', sessionId: 'gh-session' })
  mocks.poll.mockResolvedValue({ status: 'ok', sessionId: 'gh-session' })
  const onSend = vi.fn()
  render(<Conversation onSend={onSend} />)
  fireEvent.click(screen.getByText('GitHub task'))
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByText('GitHub task'))
  expect(await screen.findByTestId('github-cli-login')).toBeInTheDocument()
  expect(mocks.health).toHaveBeenCalledTimes(2)
  expect(mocks.health).toHaveBeenLastCalledWith(GITHUB_CLI_TARGET)
  expect(mocks.start).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('github-cli-login'))
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2), { timeout: 2000 })
  expect(onSend).toHaveBeenLastCalledWith(input)
  expect(screen.queryByTestId('github-cli-auth')).not.toBeInTheDocument()
})

test.each(['cancel', 'ordinary'])(
  'a pending gh login never blocks ordinary chat: %s',
  async action => {
    mocks.health.mockResolvedValue({ status: 'need_login' })
    mocks.start.mockResolvedValue({ status: 'waiting_browser', sessionId: 'gh-session' })
    mocks.poll.mockImplementation(() => new Promise(() => undefined))
    const onSend = vi.fn()
    render(<Conversation onSend={onSend} />)
    fireEvent.click(screen.getByText('GitHub task'))
    fireEvent.click(await screen.findByTestId('github-cli-login'))
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1))
    if (action === 'cancel') fireEvent.click(screen.getByTestId('connector-auth-cancel'))
    fireEvent.click(screen.getByText('Ordinary task'))
    await waitFor(() => expect(onSend).toHaveBeenCalledExactlyOnceWith('Hello'))
    expect(screen.queryByTestId('github-cli-auth')).not.toBeInTheDocument()
    expect(mocks.cancel).toHaveBeenCalledWith(
      { pluginKey: 'github', connectorSlug: 'wework-github-cli' },
      'gh-session'
    )
  }
)

test('gh health transport failure does not silently send through the official connector', async () => {
  mocks.health.mockRejectedValue(new Error('offline'))
  const onSend = vi.fn()
  const onError = vi.fn()
  render(<Conversation onSend={onSend} onError={onError} />)
  fireEvent.click(screen.getByText('GitHub task'))
  await waitFor(() => expect(onError).toHaveBeenCalledOnce())
  expect(screen.queryByTestId('github-cli-login')).not.toBeInTheDocument()
  expect(onSend).not.toHaveBeenCalled()
})

test('account-specific GitHub app IDs use gh preflight instead of the official connector', async () => {
  mocks.health.mockResolvedValue({ status: 'need_login' })
  const onSend = vi.fn()
  render(
    <Conversation onSend={onSend} taskInput="[$GitHub](app://connector_account_id) 查看项目列表" />
  )
  expect(await screen.findByText('GitHub task')).toBeInTheDocument()
  fireEvent.click(screen.getByText('GitHub task'))
  expect(await screen.findByTestId('github-cli-login')).toBeInTheDocument()
  expect(mocks.health).toHaveBeenCalledWith(GITHUB_CLI_TARGET)
  expect(onSend).not.toHaveBeenCalled()
})

const authMessage: WorkbenchMessage = {
  id: 'github-auth-needed',
  role: 'assistant',
  content: 'connector_auth_required\npluginKey=github\nconnectorSlug=wework-github-cli',
  status: 'failed',
  createdAt: '2026-10-08T00:00:00Z',
}

test.each(['plain', 'markdown'])(
  'mid-task gh authorization retries only once: %s',
  async format => {
    mocks.health.mockResolvedValue({ status: 'need_login' })
    mocks.start.mockResolvedValue({ status: 'waiting_browser', sessionId: 'gh-resume' })
    mocks.poll.mockResolvedValue({ status: 'ok', sessionId: 'gh-resume' })
    const onRetry = vi.fn(() => true)
    const onSend = vi.fn()
    const message =
      format === 'plain'
        ? authMessage
        : {
            ...authMessage,
            status: 'done' as const,
            content:
              'connector_auth_required\n\n- `pluginKey`: `github`\n- `connectorSlug`: `wework-github-cli`\n\n当前设备尚未登录。',
          }
    const userMessage: WorkbenchMessage = {
      id: 'github-user-input',
      role: 'user',
      content: input,
      status: 'done',
      createdAt: '2026-10-08T00:00:00Z',
    }
    render(<Conversation onSend={onSend} onRetry={onRetry} messages={[userMessage, message]} />)
    fireEvent.click(await screen.findByTestId('github-cli-login'))
    if (format === 'plain') {
      await waitFor(() => expect(onRetry).toHaveBeenCalledExactlyOnceWith(message), {
        timeout: 2000,
      })
      expect(onSend).not.toHaveBeenCalled()
    } else {
      await waitFor(() => expect(onSend).toHaveBeenCalledExactlyOnceWith(input), {
        timeout: 2000,
      })
      expect(onRetry).not.toHaveBeenCalled()
    }
    expect(screen.queryByTestId('github-cli-auth')).not.toBeInTheDocument()
  }
)

test('a late gh health response cannot reopen authorization after an ordinary send', async () => {
  let finishHealth!: (value: { status: string }) => void
  mocks.health.mockImplementation(
    () =>
      new Promise(resolve => {
        finishHealth = resolve
      })
  )
  const onSend = vi.fn()
  render(<Conversation onSend={onSend} messages={[authMessage]} />)
  await waitFor(() => expect(mocks.health).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByText('Ordinary task'))
  await waitFor(() => expect(onSend).toHaveBeenCalledExactlyOnceWith('Hello'))
  await act(async () => finishHealth({ status: 'need_login' }))
  expect(screen.queryByTestId('github-cli-auth')).not.toBeInTheDocument()
  expect(mocks.start).not.toHaveBeenCalled()
})
