import '@/i18n'

import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { RequestUserInputCard, RequestUserInputSummary } from './RequestUserInputCard'
import { openExternalUrl } from '@/lib/external-links'
import type { WorkbenchMessage } from '@/types/workbench'

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

describe('MCP form cancellation', () => {
  test.each(['button', 'Escape'])(
    '%s cancels only the correlated form and preserves retry after rejection',
    async action => {
      const onSubmit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
      const onIgnore = vi.fn()
      render(
        <RequestUserInputCard
          payload={{
            kind: 'request_user_input',
            interactionKind: 'mcp_form',
            requestId: 7,
            itemId: 'mcp_server_elicitation',
            interactionScope: 'turn-7',
            questions: [{ id: 'audience', question: 'Publish?', options: [{ label: 'Owner' }] }],
          }}
          onSubmit={onSubmit}
          onIgnore={onIgnore}
        />
      )
      const button = screen.getByTestId('request-user-input-ignore-button')
      const cancel = async () => {
        if (action === 'button') await userEvent.click(button)
        else
          await act(async () => {
            fireEvent.keyDown(button, { key: 'Escape' })
          })
      }
      await cancel()
      expect(button).toBeEnabled()
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
        requestId: 7,
        itemId: 'mcp_server_elicitation',
        interactionScope: 'turn-7',
        answers: {},
      })
      expect(onIgnore).not.toHaveBeenCalled()
      await cancel()
      expect(onSubmit).toHaveBeenCalledTimes(2)
      expect(button).toBeDisabled()
      expect(onIgnore).not.toHaveBeenCalled()
    }
  )

  test('a message-only MCP form can cancel without a task cancellation handler', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true)
    render(
      <RequestUserInputCard
        compact
        payload={{
          kind: 'request_user_input',
          interactionKind: 'mcp_form',
          requestId: 8,
          questions: [],
        }}
        onSubmit={onSubmit}
      />
    )
    await userEvent.click(screen.getByTestId('request-user-input-ignore-button'))
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      requestId: 8,
      itemId: undefined,
      answers: {},
    })
  })
})

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
  test('labels answer fields independently of protocol IDs and other mounted cards', async () => {
    const onSubmit = vi.fn()
    const question = { id: 'next step', question: '接下来做什么？' }
    render(
      <>
        <RequestUserInputCard
          payload={{ kind: 'request_user_input', questions: [question] }}
          onSubmit={onSubmit}
        />
        <RequestUserInputCard payload={{ kind: 'request_user_input', questions: [question] }} />
      </>
    )
    const answers = screen.getAllByRole('textbox', { name: question.question })
    expect(answers).toHaveLength(2)
    expect(answers[0].getAttribute('aria-labelledby')).not.toBe(
      answers[1].getAttribute('aria-labelledby')
    )
    const user = userEvent.setup()
    await user.type(answers[0], '继续')
    await user.click(screen.getAllByTestId('request-user-input-submit-button')[0])
    expect(onSubmit.mock.calls[0][0].answers).toEqual({ 'next step': { answers: ['继续'] } })
  })

  test.each([false, true])(
    'keeps long free-text questions outside the answer field (compact=%s)',
    async compact => {
      const question =
        '前两条已完成收发、移动和拆分验证。为补拍修正后的干净会话，请再手动发一条：@自己 AI 验证：最后确认完整的问题内容。\n发送后请告知结果。'
      const onSubmit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
      const user = userEvent.setup()
      render(
        <RequestUserInputCard
          compact={compact}
          payload={{
            kind: 'request_user_input',
            requestId: 43,
            questions: [{ id: 'details', question }],
          }}
          onSubmit={onSubmit}
        />
      )

      const prompt = screen.getByText(question, { collapseWhitespace: false })
      const answer = screen.getByRole('textbox', { name: question })
      expect(prompt).toHaveClass('whitespace-pre-wrap', 'break-words')
      expect(answer).toHaveValue('')
      expect(answer).toHaveAttribute('placeholder', '输入你的回答')

      await user.type(answer, '已发送')
      expect(prompt).toBeVisible()
      await user.click(screen.getByTestId('request-user-input-submit-button'))
      expect(onSubmit).toHaveBeenLastCalledWith({
        requestId: 43,
        itemId: undefined,
        answers: { details: { answers: ['已发送'] } },
      })
      expect(answer).toBeEnabled()
      expect(answer).toHaveValue('已发送')
      await user.click(screen.getByTestId('request-user-input-submit-button'))
      expect(onSubmit).toHaveBeenCalledTimes(2)
      expect(answer).toBeDisabled()
    }
  )

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

describe('MCP interaction deadline', () => {
  afterEach(() => vi.useRealTimers())

  test('counts down from the runtime deadline and expires without submitting a choice', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-22T03:37:25Z'))
    const onSubmit = vi.fn()
    const timedPayload = {
      ...payload,
      interactionKind: 'mcp_form',
      interactionScope: 'turn-publish',
      interactionStatus: 'pending' as const,
      expiresAtUnixMs: Date.now() + 5 * 60_000,
    }
    const view = render(<RequestUserInputCard payload={timedPayload} onSubmit={onSubmit} />)
    expect(screen.getByRole('timer')).toHaveTextContent('5:00')
    act(() => vi.advanceTimersByTime(4 * 60_000))
    expect(screen.getByRole('timer')).toHaveTextContent('1:00')

    view.unmount()
    render(<RequestUserInputCard payload={timedPayload} onSubmit={onSubmit} />)
    expect(screen.getByRole('timer')).toHaveTextContent('1:00')
    act(() => vi.advanceTimersByTime(60_000))
    expect(screen.getByRole('status')).toHaveTextContent('请求已超时，未确认操作')
    expect(screen.queryByTestId('request-user-input-card')).not.toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  test('checks the deadline at click time even when the timer has not run', () => {
    vi.useFakeTimers()
    const now = Date.now()
    const onSubmit = vi.fn()
    render(
      <RequestUserInputCard
        payload={{ ...payload, expiresAtUnixMs: now + 1000 }}
        onSubmit={onSubmit}
      />
    )
    vi.setSystemTime(now + 1001)
    fireEvent.click(screen.getByTestId('request-user-input-option-goal-0'))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  test.each(['expired', 'cancelled'] as const)(
    'preserves explicit %s status over a cached answer and local deadline',
    status => {
      const onSubmit = vi.fn()
      render(
        <RequestUserInputCard
          payload={{
            ...payload,
            interactionStatus: status,
            expiresAtUnixMs: Date.now() - 1,
            response: { answers: { goal: { answers: ['技术决策'] } } },
          }}
          onSubmit={onSubmit}
        />
      )
      expect(screen.getByTestId(`request-user-input-${status}`)).toBeVisible()
      expect(screen.queryByRole('button')).not.toBeInTheDocument()
      expect(onSubmit).not.toHaveBeenCalled()
    }
  )

  test('preserves the turn scope in a submitted form response', async () => {
    const onSubmit = vi.fn()
    render(
      <RequestUserInputCard
        payload={{ ...payload, interactionScope: 'turn-new', expiresAtUnixMs: Date.now() + 60_000 }}
        onSubmit={onSubmit}
      />
    )
    await userEvent.click(screen.getByTestId('request-user-input-option-goal-1'))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 42,
        interactionScope: 'turn-new',
        answers: { goal: { answers: ['技术决策'] } },
      })
    )
  })

  test('does not expire an already answered request after its original deadline', () => {
    render(
      <RequestUserInputCard
        payload={{ ...payload, interactionStatus: 'answered', expiresAtUnixMs: Date.now() - 1 }}
      />
    )
    expect(screen.getByTestId('request-user-input-summary')).toBeVisible()
    expect(screen.queryByTestId('request-user-input-expired')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  test('keeps an acknowledged answer after expiry and remount without a settled event', async () => {
    vi.useFakeTimers()
    const onSubmit = vi.fn().mockResolvedValue(true)
    const timedPayload = {
      ...payload,
      interactionKind: 'mcp_form',
      interactionScope: 'turn-acknowledged',
      interactionStatus: 'pending' as const,
      expiresAtUnixMs: Date.now() + 1000,
    }
    const view = render(<RequestUserInputCard payload={timedPayload} onSubmit={onSubmit} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('request-user-input-option-goal-1'))
    })
    const acknowledgedPayload = { ...timedPayload, response: onSubmit.mock.calls[0][0] }
    view.rerender(<RequestUserInputCard payload={acknowledgedPayload} onSubmit={onSubmit} />)
    expect(screen.getByTestId('request-user-input-summary')).toHaveTextContent('技术决策')
    expect(screen.queryByRole('timer')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()

    act(() => vi.advanceTimersByTime(2000))
    view.rerender(<RequestUserInputSummary payload={acknowledgedPayload} />)
    expect(screen.getByTestId('request-user-input-summary')).toHaveTextContent('技术决策')
    expect(screen.queryByTestId('request-user-input-expired')).not.toBeInTheDocument()

    view.unmount()
    render(<RequestUserInputCard payload={acknowledgedPayload} onSubmit={onSubmit} />)
    expect(screen.getByTestId('request-user-input-summary')).toHaveTextContent('技术决策')
    expect(screen.queryByTestId('request-user-input-expired')).not.toBeInTheDocument()
    expect(screen.queryByRole('timer')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  test('does not open an authorization window after its deadline', () => {
    vi.mocked(openExternalUrl).mockClear()
    const onSubmit = vi.fn()
    render(
      <RequestUserInputCard
        payload={{ ...urlPayload, expiresAtUnixMs: Date.now() - 1 }}
        onSubmit={onSubmit}
      />
    )
    expect(screen.getByTestId('request-user-input-expired')).toBeVisible()
    expect(openExternalUrl).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('compact inline questions', () => {
  test('single-question options send the original answer without an extra submit control', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true)
    const user = userEvent.setup()
    render(
      <RequestUserInputCard
        compact
        payload={{
          kind: 'request_user_input',
          requestId: 17,
          itemId: 'retention-1',
          questions: [
            {
              id: 'retention',
              question: '删除后是否保留历史会话？',
              options: [
                { label: '保留会话', value: 'keep' },
                { label: '一并删除', value: 'delete' },
              ],
            },
          ],
        }}
        onSubmit={onSubmit}
      />
    )
    expect(screen.queryByTestId('request-user-input-submit-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('request-user-input-ignore-button')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('request-user-input-option-retention-0'))
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      requestId: 17,
      itemId: 'retention-1',
      answers: { retention: { answers: ['keep'] } },
    })
  })
  test('custom inline answers retain their submit action', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true)
    const user = userEvent.setup()
    render(
      <RequestUserInputCard
        compact
        payload={{
          kind: 'request_user_input',
          questions: [{ id: 'details', question: '补充要求', is_other: true }],
        }}
        onSubmit={onSubmit}
      />
    )
    await user.type(screen.getByTestId('request-user-input-custom-details'), '保留历史会话')
    await user.click(screen.getByTestId('request-user-input-submit-button'))
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit.mock.calls[0][0].answers).toEqual({ details: { answers: ['保留历史会话'] } })
  })
})

test('shows the exact bound reply and localized actions while preserving native approval values', async () => {
  const onSubmit = vi.fn(async () => true)
  const messages = [
    {
      id: 'assistant',
      role: 'assistant',
      content: '',
      status: 'streaming',
      blocks: [
        {
          id: 'call-reply',
          type: 'tool',
          toolName: 'wework_stand_in.reply',
          status: 'pending',
          toolInput: { text: '现在是北京时间13:25。' },
        },
        {
          id: 'approval-1',
          type: 'tool',
          toolName: 'request_user_input',
          status: 'pending',
          renderPayload: {
            kind: 'request_user_input',
            requestId: 'approval-1',
            itemId: 'call-reply',
          },
        },
        {
          id: 'unrelated',
          type: 'tool',
          toolName: 'wework_stand_in.reply',
          status: 'pending',
          toolInput: { text: '另一个审批的内容' },
        },
      ],
    },
  ] as WorkbenchMessage[]
  render(
    <RequestUserInputCard
      messages={messages}
      onSubmit={onSubmit}
      payload={{
        kind: 'request_user_input',
        requestId: 'approval-1',
        itemId: 'call-reply',
        questions: [
          {
            id: 'mcp_tool_call_approval_call-reply',
            question: 'Allow the tool?',
            options: [{ label: 'Allow' }, { label: 'Cancel' }],
          },
        ],
      }}
    />
  )
  expect(screen.getByText('现在是北京时间13:25。')).toBeVisible()
  expect(screen.queryByText('另一个审批的内容')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: /确认发送/ }))
  expect(onSubmit).toHaveBeenCalledWith({
    requestId: 'approval-1',
    itemId: 'call-reply',
    answers: { 'mcp_tool_call_approval_call-reply': { answers: ['Allow'] } },
  })
})

test('binds reused tool IDs to the message owning the current approval request', () => {
  const payload = {
    kind: 'request_user_input',
    requestId: 'current-request',
    itemId: 'call-reused',
    questions: [
      {
        id: 'mcp_tool_call_approval_call-reused',
        question: 'Allow the tool?',
        options: [{ label: 'Allow' }, { label: 'Cancel' }],
      },
    ],
  }
  const messages = [
    {
      id: 'old-turn',
      role: 'assistant',
      content: '',
      status: 'done',
      blocks: [
        {
          id: 'call-reused',
          type: 'tool',
          toolName: 'wework_stand_in.reply',
          status: 'done',
          toolInput: { text: '上一回合的旧回复' },
        },
      ],
    },
    {
      id: 'current-turn',
      role: 'assistant',
      content: '',
      status: 'streaming',
      blocks: [
        {
          id: 'call-reused',
          type: 'tool',
          toolName: 'wework_stand_in.reply',
          status: 'pending',
          toolInput: { text: '本次准备发送的回复' },
        },
        {
          id: 'approval-current',
          type: 'tool',
          toolName: 'request_user_input',
          status: 'pending',
          renderPayload: payload,
        },
      ],
    },
  ] as WorkbenchMessage[]
  render(<RequestUserInputCard messages={messages} payload={payload} onSubmit={vi.fn()} />)
  expect(screen.getByText('本次准备发送的回复')).toBeVisible()
  expect(screen.queryByText('上一回合的旧回复')).not.toBeInTheDocument()
})

test('keeps the native request when its owning message has no matching reply parameters', () => {
  const payload = {
    kind: 'request_user_input',
    requestId: 'current-request',
    itemId: 'call-reused',
    questions: [
      {
        id: 'mcp_tool_call_approval_call-reused',
        question: 'Native confirmation without bound text',
        options: [{ label: 'Allow' }],
      },
    ],
  }
  const messages = [
    {
      id: 'old-turn',
      role: 'assistant',
      content: '',
      status: 'done',
      blocks: [
        {
          id: 'call-reused',
          type: 'tool',
          toolName: 'wework_stand_in.reply',
          toolInput: { text: '不能用于本次确认的旧回复' },
        },
      ],
    },
    {
      id: 'current-turn',
      role: 'assistant',
      content: '',
      status: 'streaming',
      blocks: [
        {
          id: 'approval-current',
          type: 'tool',
          toolName: 'request_user_input',
          renderPayload: payload,
        },
      ],
    },
  ] as WorkbenchMessage[]
  render(<RequestUserInputCard messages={messages} payload={payload} onSubmit={vi.fn()} />)
  expect(screen.getByText('Native confirmation without bound text')).toBeVisible()
  expect(screen.queryByText('不能用于本次确认的旧回复')).not.toBeInTheDocument()
})
