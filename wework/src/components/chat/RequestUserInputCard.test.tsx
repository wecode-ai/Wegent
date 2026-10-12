import '@/i18n'

import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { RequestUserInputCard } from './RequestUserInputCard'
import { openExternalUrl } from '@/lib/external-links'

vi.mock('@/lib/external-links', () => ({ openExternalUrl: vi.fn().mockResolvedValue(true) }))

const urlPayload = {
  kind: 'request_user_input',
  interactionKind: 'mcp_url',
  requestId: 0,
  itemId: 'mcp_server_elicitation',
  serverName: 'codex_apps',
  message: 'Connect GitHub',
  url: 'https://chatgpt.com/connect/github?state=secret',
  elicitationId: 'github-auth-1',
}

describe('MCP browser authorization', () => {
  test('shows the host and opens the system browser only after explicit consent', async () => {
    vi.mocked(openExternalUrl).mockClear()
    const onSubmit = vi.fn().mockResolvedValue(true)
    render(<RequestUserInputCard payload={urlPayload} onSubmit={onSubmit} />)
    expect(screen.getByTestId('mcp-url-authorization-card')).toHaveTextContent('chatgpt.com')
    expect(screen.getByTestId('mcp-url-authorization-card')).not.toHaveTextContent('state=secret')
    expect(openExternalUrl).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('mcp-url-authorization-open'))
    expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith(urlPayload.url, { target: 'system' })
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      requestId: 0,
      itemId: urlPayload.itemId,
      answers: { __mcp_url: { answers: ['accept'] } },
    })
  })

  test('cancel responds to the original request without opening the browser', async () => {
    vi.mocked(openExternalUrl).mockClear()
    const onSubmit = vi.fn()
    render(<RequestUserInputCard payload={urlPayload} onSubmit={onSubmit} />)
    await userEvent.click(screen.getByTestId('mcp-url-authorization-cancel'))
    expect(openExternalUrl).not.toHaveBeenCalled()
    expect(onSubmit).toHaveBeenCalledWith({
      requestId: 0,
      itemId: urlPayload.itemId,
      answers: { __mcp_url: { answers: ['cancel'] } },
    })
  })

  test('browser failure leaves the card retryable and does not acknowledge consent', async () => {
    vi.mocked(openExternalUrl).mockRejectedValueOnce(new Error('secret URL must not be displayed'))
    const onSubmit = vi.fn()
    render(<RequestUserInputCard payload={urlPayload} onSubmit={onSubmit} />)
    await userEvent.click(screen.getByTestId('mcp-url-authorization-open'))
    expect(screen.getByRole('alert')).not.toHaveTextContent('secret URL')
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByTestId('mcp-url-authorization-open')).toBeEnabled()
    await userEvent.click(screen.getByTestId('mcp-url-authorization-open'))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  test('unsafe URLs cannot be opened but can be cancelled', async () => {
    const onSubmit = vi.fn()
    render(
      <RequestUserInputCard
        payload={{ ...urlPayload, url: 'javascript:alert(1)' }}
        onSubmit={onSubmit}
      />
    )
    expect(screen.getByTestId('mcp-url-authorization-open')).toBeDisabled()
    await userEvent.click(screen.getByTestId('mcp-url-authorization-cancel'))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  test('rejected responses remain retryable and Escape sends cancellation', async () => {
    const onSubmit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    render(<RequestUserInputCard payload={urlPayload} onSubmit={onSubmit} />)
    await userEvent.click(screen.getByTestId('mcp-url-authorization-open'))
    expect(screen.getByRole('alert')).toBeVisible()
    expect(screen.getByTestId('mcp-url-authorization-cancel')).toBeEnabled()
    fireEvent.keyDown(screen.getByTestId('mcp-url-authorization-cancel'), { key: 'Escape' })
    await act(async () => {})
    expect(onSubmit).toHaveBeenLastCalledWith({
      requestId: 0,
      itemId: urlPayload.itemId,
      answers: { __mcp_url: { answers: ['cancel'] } },
    })
  })

  test('duplicate clicks cannot open two authorization windows', async () => {
    let finishOpen: (() => void) | undefined
    vi.mocked(openExternalUrl)
      .mockClear()
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishOpen = () => resolve(true)
          })
      )
    const onSubmit = vi.fn().mockResolvedValue(true)
    render(<RequestUserInputCard payload={urlPayload} onSubmit={onSubmit} />)
    const button = screen.getByTestId('mcp-url-authorization-open')
    fireEvent.click(button)
    fireEvent.click(button)
    expect(openExternalUrl).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
    await act(async () => {
      finishOpen?.()
    })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
})

const payload = {
  kind: 'request_user_input',
  request_id: 42,
  item_id: 'item-1',
  questions: [
    {
      id: 'goal',
      header: '工作目标',
      question: '你希望我接下来问你哪些问题？',
      options: [
        {
          label: '工作目标 (Recommended)',
          description: '聚焦你今天最想推进的一件具体事情。',
        },
        {
          label: '技术决策',
          description: '围绕实现方案、架构取舍或代码质量提问。',
        },
      ],
    },
  ],
}

describe('RequestUserInputCard', () => {
  test('renders Codex-style questions and submits selected answers', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<RequestUserInputCard payload={payload} onSubmit={onSubmit} />)

    expect(screen.getByTestId('request-user-input-card')).toHaveTextContent(
      '你希望我接下来问你哪些问题？'
    )
    expect(screen.getByTestId('request-user-input-option-goal-0')).toHaveTextContent(
      '工作目标 (Recommended)'
    )
    expect(screen.getByTestId('request-user-input-option-goal-1')).toHaveTextContent('技术决策')

    await user.click(screen.getByTestId('request-user-input-option-goal-1'))

    expect(onSubmit).toHaveBeenCalledWith({
      requestId: 42,
      itemId: 'item-1',
      answers: {
        goal: { answers: ['技术决策'] },
      },
    })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  test('ignores duplicate submissions while the runtime request is in flight', async () => {
    let resolveSubmit: ((accepted: boolean) => void) | undefined
    const onSubmit = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          resolveSubmit = resolve
        })
    )
    render(<RequestUserInputCard payload={payload} onSubmit={onSubmit} />)

    const option = screen.getByTestId('request-user-input-option-goal-1')
    fireEvent.click(option)
    fireEvent.click(option)

    expect(onSubmit).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveSubmit?.(true)
    })
  })

  test('wraps long option text and scrolls an oversized question list', () => {
    const longLabel = '组合型项目（推荐）：将多个仓库、工作项目和外部任务源关联到同一看板中'
    const longDescription =
      '卡片可以关联其中一个上下文，并在后续步骤中持续保留完整的看板、项目和任务来源信息。'
    const questions = Array.from({ length: 12 }, (_, index) => ({
      id: `question-${index + 1}`,
      question: `第 ${index + 1} 个需要确认的问题`,
      options: [{ label: longLabel, description: longDescription }],
    }))

    render(<RequestUserInputCard payload={{ kind: 'request_user_input', questions }} />)

    const card = screen.getByTestId('request-user-input-card')
    const questionsContainer = screen.getByTestId('request-user-input-questions')
    const option = screen.getByTestId('request-user-input-option-question-1-0')

    expect(card).toHaveClass('max-h-[min(60dvh,36rem)]', 'flex', 'flex-col')
    expect(questionsContainer).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto')
    expect(option).toHaveClass('min-h-9', 'items-start', 'py-1.5')
    expect(option.querySelector('span.min-w-0')).toHaveClass('whitespace-normal', 'break-words')
    expect(option).toHaveTextContent(longLabel)
    expect(option).toHaveTextContent(longDescription)
  })

  test('submits the implementation plan option when option one is clicked', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(
      <RequestUserInputCard
        payload={{
          kind: 'request_user_input',
          questions: [
            {
              id: 'implement',
              question: '执行此计划?',
              options: [{ label: '是的，执行此计划' }],
            },
            {
              id: 'adjustment',
              question: '否，请告知 WeWork 如何调整',
              is_other: true,
            },
          ],
        }}
        onSubmit={onSubmit}
      />
    )

    await user.click(screen.getByTestId('request-user-input-option-implement-0'))

    expect(onSubmit).toHaveBeenCalledWith({
      requestId: undefined,
      itemId: undefined,
      answers: {
        implement: { answers: ['是的，执行此计划'] },
      },
    })
  })

  test('submits only custom implementation plan adjustment text', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(
      <RequestUserInputCard
        payload={{
          kind: 'request_user_input',
          questions: [
            {
              id: 'implement',
              question: '执行此计划?',
              options: [{ label: '是的，执行此计划' }],
            },
            {
              id: 'adjustment',
              question: '否，请告知 WeWork 如何调整',
              is_other: true,
            },
          ],
        }}
        onSubmit={onSubmit}
      />
    )

    await user.type(screen.getByTestId('request-user-input-custom-adjustment'), '先缩小范围')
    await user.click(screen.getByTestId('request-user-input-submit-button'))

    expect(onSubmit).toHaveBeenCalledWith({
      requestId: undefined,
      itemId: undefined,
      answers: {
        adjustment: { answers: ['先缩小范围'] },
      },
    })
  })

  test('submits custom text answers', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(
      <RequestUserInputCard
        payload={{
          kind: 'request_user_input',
          request_id: 43,
          questions: [
            {
              id: 'adjustment',
              question: '请告知 Codex 如何调整',
              is_other: true,
            },
          ],
        }}
        onSubmit={onSubmit}
      />
    )

    await user.type(screen.getByTestId('request-user-input-custom-adjustment'), '先解释方案')
    await user.click(screen.getByTestId('request-user-input-submit-button'))

    expect(onSubmit).toHaveBeenCalledWith({
      requestId: 43,
      itemId: undefined,
      answers: {
        adjustment: { answers: ['先解释方案'] },
      },
    })
  })

  test('supports ignore', async () => {
    const user = userEvent.setup()
    const onIgnore = vi.fn()
    render(<RequestUserInputCard payload={payload} onIgnore={onIgnore} />)

    await user.click(screen.getByTestId('request-user-input-ignore-button'))

    expect(onIgnore).toHaveBeenCalledTimes(1)
  })

  test('localizes Codex approvals while submitting protocol decision values', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(
      <RequestUserInputCard
        payload={{
          kind: 'request_user_input',
          requestId: 44,
          itemId: 'command-1',
          interactionKind: 'approval',
          approvalKind: 'command',
          command: 'git push origin feature/permission-modes',
          questions: [
            {
              id: '__codex_approval',
              question: 'command',
              options: [
                { label: 'allow_once' },
                { label: 'allow_session' },
                { label: 'decline' },
                { label: 'cancel' },
              ],
            },
          ],
        }}
        onSubmit={onSubmit}
      />
    )

    expect(screen.getByTestId('request-user-input-card')).toHaveTextContent('需要审批')
    expect(screen.getByTestId('request-user-input-card')).toHaveTextContent(
      'git push origin feature/permission-modes'
    )
    expect(screen.getByTestId('request-user-input-option-__codex_approval-1')).toHaveTextContent(
      '本会话允许'
    )

    await user.click(screen.getByTestId('request-user-input-option-__codex_approval-1'))

    expect(onSubmit).toHaveBeenCalledWith({
      requestId: 44,
      itemId: 'command-1',
      answers: {
        __codex_approval: { answers: ['allow_session'] },
      },
    })
  })

  test('localizes and submits structured Codex approval decisions', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(
      <RequestUserInputCard
        payload={{
          kind: 'request_user_input',
          requestId: 45,
          itemId: 'command-2',
          interactionKind: 'approval',
          approvalKind: 'command',
          command: 'curl https://example.com',
          questions: [
            {
              id: '__codex_approval',
              options: [
                {
                  label: 'allow_execpolicy:1',
                  description: 'curl',
                },
                {
                  label: 'apply_network_policy:2',
                  description: 'allow:example.com',
                },
              ],
            },
          ],
        }}
        onSubmit={onSubmit}
      />
    )

    expect(screen.getByTestId('request-user-input-option-__codex_approval-0')).toHaveTextContent(
      '允许此命令规则'
    )
    expect(screen.getByTestId('request-user-input-option-__codex_approval-0')).toHaveTextContent(
      'curl'
    )
    expect(screen.getByTestId('request-user-input-option-__codex_approval-1')).toHaveTextContent(
      '始终允许 example.com'
    )

    await user.click(screen.getByTestId('request-user-input-option-__codex_approval-1'))

    expect(onSubmit).toHaveBeenCalledWith({
      requestId: 45,
      itemId: 'command-2',
      answers: {
        __codex_approval: { answers: ['apply_network_policy:2'] },
      },
    })
  })

  test('localizes strict permission review decisions', () => {
    render(
      <RequestUserInputCard
        payload={{
          kind: 'request_user_input',
          interactionKind: 'approval',
          approvalKind: 'permissions',
          questions: [
            {
              id: '__codex_approval',
              options: [{ label: 'allow_turn_strict_review' }],
            },
          ],
        }}
      />
    )

    expect(screen.getByTestId('request-user-input-option-__codex_approval-0')).toHaveTextContent(
      '允许并严格审查'
    )
    expect(screen.getByTestId('request-user-input-option-__codex_approval-0')).toHaveTextContent(
      '逐一审查后续每条命令'
    )
  })

  test('submits with Enter and ignores with Escape', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    const onIgnore = vi.fn()
    render(<RequestUserInputCard payload={payload} onSubmit={onSubmit} onIgnore={onIgnore} />)

    expect(screen.getByTestId('request-user-input-card')).toHaveFocus()

    await user.keyboard('{Enter}')

    expect(onSubmit).toHaveBeenCalledWith({
      requestId: 42,
      itemId: 'item-1',
      answers: {
        goal: { answers: ['工作目标 (Recommended)'] },
      },
    })

    render(<RequestUserInputCard payload={payload} onIgnore={onIgnore} />)
    await user.keyboard('{Escape}')

    expect(onIgnore).toHaveBeenCalledTimes(1)
  })
})
