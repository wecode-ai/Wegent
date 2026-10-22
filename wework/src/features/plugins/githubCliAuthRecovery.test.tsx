import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import { useLocalConnectorAuthRecovery } from './useLocalConnectorAuthRecovery'
import { ConnectorAuthCard } from '@/components/chat/ConnectorAuthCard'
import { GITHUB_CLI_TARGET } from '@/api/local/githubCli'
import type { LocalConnectorAuthResult } from '@/api/local/localConnectorAuth'
import type { WorkbenchMessage } from '@/types/workbench'

const mocks = vi.hoisted(() => ({
  health: vi.fn(),
  start: vi.fn(),
  poll: vi.fn(),
  cancel: vi.fn(),
  createPluginApi: vi.fn(),
}))
vi.mock('@/api/local/localConnectorAuth', async original => ({
  ...(await original<typeof import('@/api/local/localConnectorAuth')>()),
  localConnectorAuthHealth: mocks.health,
  localConnectorAuthStart: mocks.start,
  localConnectorAuthPoll: mocks.poll,
  localConnectorAuthCancel: mocks.cancel,
}))
vi.mock('@/api/local/codexPlugins', () => ({
  createLocalCodexPluginApi: mocks.createPluginApi,
}))

const input = '[$GitHub](plugin://github@openai-curated-remote) 查看项目列表'
const authMessage: WorkbenchMessage = {
  id: 'github-auth-needed',
  role: 'assistant',
  content: 'connector_auth_required\npluginKey=github\nconnectorSlug=wework-github-cli',
  status: 'failed',
  createdAt: '2026-10-15T00:00:00Z',
}

function Conversation({
  onSend,
  messages = [],
  taskInput = input,
  onError,
  active = true,
}: {
  onSend: (text: string) => void
  messages?: WorkbenchMessage[]
  taskInput?: string
  onError?: (message: string) => void
  active?: boolean
}) {
  const recovery = useLocalConnectorAuthRecovery({
    messages,
    onResumeSend: onSend,
    onError,
    active,
  })
  const submit = (text: string) => {
    recovery.clearPending()
    onSend(text)
  }
  return (
    <>
      <button data-testid="test-send-github" onClick={() => submit(taskInput)}>
        GitHub task
      </button>
      <button data-testid="test-send-ordinary" onClick={() => submit('Hello')}>
        Ordinary task
      </button>
      {recovery.pending ? (
        <ConnectorAuthCard
          target={recovery.pending.target}
          title={recovery.pending.title}
          onSuccess={() => void recovery.completePending()}
          onCancel={recovery.clearPending}
        />
      ) : null}
    </>
  )
}

beforeEach(() => {
  mocks.health.mockReset().mockResolvedValue({ status: 'need_login' })
  mocks.start.mockReset().mockResolvedValue({ status: 'waiting_browser', sessionId: 'gh-session' })
  mocks.poll.mockReset().mockResolvedValue({ status: 'ok', sessionId: 'gh-session' })
  mocks.cancel.mockReset().mockResolvedValue({ status: 'cancelled' })
  mocks.createPluginApi.mockReset()
})

afterEach(() => {
  expect(mocks.createPluginApi).not.toHaveBeenCalled()
})

test.each([input, '[$GitHub](app://connector_account_id) 查看项目列表'])(
  'sends %s without probing authorization before plugin use',
  taskInput => {
    const onSend = vi.fn()
    render(<Conversation onSend={onSend} taskInput={taskInput} />)

    fireEvent.click(screen.getByTestId('test-send-github'))
    fireEvent.click(screen.getByTestId('test-send-ordinary'))

    expect(onSend.mock.calls).toEqual([[taskInput], ['Hello']])
    expect(mocks.health).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
    expect(screen.queryByTestId('connector-auth-card')).not.toBeInTheDocument()
  }
)

test.each(['plain', 'markdown'])(
  'a %s authorization failure requires consent and continues the task once',
  async format => {
    const message =
      format === 'plain'
        ? authMessage
        : {
            ...authMessage,
            status: 'done' as const,
            content:
              'connector_auth_required\n\n- `pluginKey`: `github`\n- `connectorSlug`: `wework-github-cli`\n\n当前设备尚未登录。',
          }
    const onSend = vi.fn()
    const { rerender } = render(<Conversation onSend={onSend} messages={[message]} />)

    expect(await screen.findByTestId('github-cli-login')).toBeInTheDocument()
    expect(mocks.health).toHaveBeenCalledExactlyOnceWith(GITHUB_CLI_TARGET, { bypassCache: true })
    expect(mocks.start).not.toHaveBeenCalled()
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('github-cli-login'))

    await waitFor(
      () =>
        expect(onSend).toHaveBeenCalledExactlyOnceWith(
          i18n.t('common:workbench.plugins_local_auth_resume_prompt')
        ),
      { timeout: 2_000 }
    )
    rerender(<Conversation onSend={onSend} messages={[{ ...message }]} />)
    expect(onSend).not.toHaveBeenCalledWith(input)
    expect(screen.queryByTestId('github-cli-auth')).not.toBeInTheDocument()
    expect(mocks.health).toHaveBeenCalledTimes(1)
    expect(mocks.start).toHaveBeenCalledTimes(1)
  }
)

test.each(['cancel', 'ordinary'])(
  '%s cancels a running login and ignores a late success',
  async action => {
    let finishPoll!: (value: LocalConnectorAuthResult) => void
    mocks.poll.mockImplementation(
      () =>
        new Promise(resolve => {
          finishPoll = resolve
        })
    )
    const onSend = vi.fn()
    render(<Conversation onSend={onSend} messages={[authMessage]} />)
    fireEvent.click(await screen.findByTestId('github-cli-login'))
    await waitFor(() => expect(mocks.poll).toHaveBeenCalledOnce(), { timeout: 2_000 })

    if (action === 'cancel') fireEvent.click(screen.getByTestId('connector-auth-cancel'))
    fireEvent.click(screen.getByTestId('test-send-ordinary'))
    await act(async () => finishPoll({ status: 'ok', sessionId: 'gh-session' }))

    expect(onSend).toHaveBeenCalledExactlyOnceWith('Hello')
    expect(screen.queryByTestId('connector-auth-card')).not.toBeInTheDocument()
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(
      { pluginKey: 'github', connectorSlug: 'wework-github-cli' },
      'gh-session'
    )
    expect(mocks.health).toHaveBeenCalledOnce()
  }
)

test.each(['transport', 'error', 'healthy'])(
  '%s health does not open a GitHub login card',
  async status => {
    if (status === 'transport') mocks.health.mockRejectedValue(new Error('offline'))
    else mocks.health.mockResolvedValue({ status: status === 'healthy' ? 'ok' : 'error' })
    const onSend = vi.fn()
    const onError = vi.fn()
    render(<Conversation onSend={onSend} messages={[authMessage]} onError={onError} />)

    await act(async () => undefined)

    expect(onError).toHaveBeenCalledTimes(status === 'healthy' ? 0 : 1)
    expect(screen.queryByTestId('github-cli-login')).not.toBeInTheDocument()
    expect(mocks.start).not.toHaveBeenCalled()
    expect(onSend).not.toHaveBeenCalled()
  }
)

test('deactivating a pane cancels its native session and permits fresh login consent on return', async () => {
  let finishPoll!: (value: LocalConnectorAuthResult) => void
  mocks.poll.mockImplementation(
    () =>
      new Promise(resolve => {
        finishPoll = resolve
      })
  )
  const onSend = vi.fn()
  const { rerender } = render(<Conversation onSend={onSend} messages={[authMessage]} />)
  fireEvent.click(await screen.findByTestId('github-cli-login'))
  await waitFor(() => expect(mocks.poll).toHaveBeenCalledOnce(), { timeout: 2_000 })

  rerender(<Conversation onSend={onSend} messages={[authMessage]} active={false} />)
  expect(screen.queryByTestId('connector-auth-card')).not.toBeInTheDocument()
  expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(
    { pluginKey: 'github', connectorSlug: 'wework-github-cli' },
    'gh-session'
  )
  rerender(<Conversation onSend={onSend} messages={[authMessage]} />)
  expect(await screen.findByTestId('github-cli-login')).toBeInTheDocument()
  await act(async () => finishPoll({ status: 'ok', sessionId: 'gh-session' }))

  expect(onSend).not.toHaveBeenCalled()
  expect(screen.getByTestId('github-cli-login')).toBeInTheDocument()
  expect(mocks.health).toHaveBeenCalledTimes(2)
  expect(mocks.start).toHaveBeenCalledOnce()
})

test('an unrelated cloud GitHub connector failure does not launch gh login', async () => {
  mocks.health.mockRejectedValue(new Error('local_auth_connector_not_found'))
  const onError = vi.fn()
  render(
    <Conversation
      onSend={vi.fn()}
      onError={onError}
      messages={[
        {
          ...authMessage,
          content: 'connector_auth_required\npluginKey=github\nconnectorSlug=github',
        },
      ]}
    />
  )

  await waitFor(() => expect(onError).toHaveBeenCalledOnce())
  expect(mocks.health).toHaveBeenCalledExactlyOnceWith(
    { pluginKey: 'github', connectorSlug: 'github' },
    { bypassCache: true }
  )
  expect(screen.queryByTestId('connector-auth-card')).not.toBeInTheDocument()
  expect(mocks.start).not.toHaveBeenCalled()
})

test('a late gh health result cannot reopen authorization after an ordinary send', async () => {
  let finishHealth!: (value: LocalConnectorAuthResult) => void
  mocks.health.mockImplementation(
    () =>
      new Promise(resolve => {
        finishHealth = resolve
      })
  )
  const onSend = vi.fn()
  render(<Conversation onSend={onSend} messages={[authMessage]} />)
  expect(mocks.health).toHaveBeenCalledOnce()

  fireEvent.click(screen.getByTestId('test-send-ordinary'))
  await act(async () => finishHealth({ status: 'need_login' }))

  expect(onSend).toHaveBeenCalledExactlyOnceWith('Hello')
  expect(screen.queryByTestId('connector-auth-card')).not.toBeInTheDocument()
  expect(mocks.start).not.toHaveBeenCalled()
})
