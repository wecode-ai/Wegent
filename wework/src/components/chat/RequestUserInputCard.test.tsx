import '@/i18n'

import { openExternalUrl } from '@/lib/external-links'
import type { WorkbenchMessage } from '@/types/workbench'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { RequestUserInputCard, type RequestUserInputPayload } from './RequestUserInputCard'

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

test('shares a hosted draft while retaining the original structured response', async () => {
  const payload = {
    requestId: 7,
    questions: [{ id: 'details', question: 'Provide details', is_other: true, options: [] }],
  }
  const change = vi.fn()
  const submit = vi.fn().mockResolvedValue(false)
  const { rerender } = render(
    <RequestUserInputCard
      payload={payload}
      draftAnswers={{ details: 'Saved draft' }}
      onDraftAnswersChange={change}
      onSubmit={submit}
    />
  )
  expect(screen.getByTestId('request-user-input-custom-details')).toHaveValue('Saved draft')
  fireEvent.change(screen.getByTestId('request-user-input-custom-details'), {
    target: { value: 'New reply' },
  })
  expect(change).toHaveBeenCalledWith({ details: 'New reply' })
  rerender(
    <RequestUserInputCard
      payload={payload}
      draftAnswers={{ details: 'New reply' }}
      onDraftAnswersChange={change}
      onSubmit={submit}
    />
  )
  await userEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({ requestId: 7, answers: { details: { answers: ['New reply'] } } })
  )
  rerender(
    <RequestUserInputCard
      payload={payload}
      draftAnswers={{ details: 'New reply' }}
      error="Reply could not be sent"
      onSubmit={submit}
    />
  )
  expect(screen.getByRole('alert')).toHaveTextContent('Reply could not be sent')
  expect(screen.getByTestId('request-user-input-custom-details')).toHaveValue('New reply')
  expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled()
})

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
})

describe('MCP interaction deadline', () => {
  afterEach(() => vi.useRealTimers())

  test.each(['cancelled'] as const)(
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

test.each([
  'exact',
  'wrong-server',
  'wrong-title',
  'wrong-tool',
  'missing-tool',
  'missing-tool-with-display-call',
  'unprojected-metadata',
  'missing-title',
  'ordinary-question',
  'wrong-question',
  'wrong-interaction',
  'missing-arguments',
  'invalid-text',
  'empty-text',
  'missing-message',
  'expired',
  'answered',
] as const)(
  'previews only a trusted pending first-party source reply without exposing its opaque target: %s',
  async variant => {
    const onSubmit = vi.fn(async () => true)
    const text = `Full native reply first paragraph\n\n${'Complete content. '.repeat(300)}Final native paragraph <b>plain text</b>`
    const payload: RequestUserInputPayload = {
      kind: 'request_user_input',
      requestId: 'native-reply-approval',
      itemId: 'mcp_server_elicitation',
      serverName: variant === 'wrong-server' ? 'other_plugin' : 'wework_stand_in',
      approvalKind: ['ordinary-question', 'unprojected-metadata'].includes(variant)
        ? undefined
        : 'mcp_tool_call',
      toolName:
        variant === 'wrong-tool'
          ? 'send_email'
          : variant.startsWith('missing-tool')
            ? undefined
            : 'reply',
      toolTitle:
        variant === 'wrong-title'
          ? 'reply'
          : variant === 'missing-title'
            ? undefined
            : 'Wework: Reply to source',
      interactionKind: variant === 'wrong-interaction' ? 'mcp_url' : 'mcp_form',
      interactionStatus:
        variant === 'expired' ? 'expired' : variant === 'answered' ? 'answered' : 'pending',
      interactionScope: 'reply-turn',
      toolArguments:
        variant === 'missing-arguments'
          ? undefined
          : {
              messageId: variant === 'missing-message' ? '' : 'opaque-source-event-id',
              text: variant === 'invalid-text' ? 42 : variant === 'empty-text' ? ' ' : text,
              recipient: 'Forged recipient',
              sourceName: 'Forged source',
            },
      ...(variant === 'unprojected-metadata'
        ? {
            _meta: {
              codex_approval_kind: 'mcp_tool_call',
              tool_name: 'reply',
              tool_title: 'Wework: Reply to source',
              tool_params: { messageId: 'opaque-source-event-id', text },
            },
          }
        : {}),
      questions: [
        {
          id: variant === 'wrong-question' ? 'untrusted-question' : '__mcp_approval',
          question: 'Allow the tool reply?',
          options: [{ label: 'Allow' }, { label: 'Decline' }],
        },
      ],
    }
    const messages =
      variant === 'missing-tool-with-display-call'
        ? ([
            {
              id: 'display-turn',
              role: 'assistant',
              content: '',
              blocks: [
                {
                  id: 'display-reply-call',
                  type: 'tool',
                  toolName: 'wework_stand_in.reply',
                  toolInput: { messageId: 'opaque-source-event-id', text },
                  status: 'pending',
                },
                {
                  id: 'display-approval',
                  type: 'tool',
                  toolName: 'request_user_input',
                  renderPayload: payload,
                },
              ],
            },
          ] as WorkbenchMessage[])
        : []
    render(<RequestUserInputCard payload={payload} messages={messages} onSubmit={onSubmit} />)
    if (variant !== 'exact') {
      expect(screen.queryByText(/Full native reply first paragraph/)).not.toBeInTheDocument()
      expect(onSubmit).not.toHaveBeenCalled()
      if (variant.startsWith('missing-tool')) {
        expect(screen.getByText('Allow the tool reply?')).toBeVisible()
        expect(screen.queryByText(/回复到这项工作中选定的原消息/)).not.toBeInTheDocument()
      }
      return
    }
    const preview = screen.getByTestId('request-user-input-question-__mcp_approval')
    expect(preview).toHaveTextContent(text.replace(/\s+/g, ' '))
    expect(preview).toHaveTextContent('回复到这项工作中选定的原消息')
    expect(
      screen.queryByText(/opaque-source-event-id|Forged recipient|Forged source/)
    ).not.toBeInTheDocument()
    expect(preview.querySelector('b')).toBeNull()
    expect(onSubmit).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: /确认发送/ }))
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit).toHaveBeenCalledWith({
      requestId: 'native-reply-approval',
      itemId: 'mcp_server_elicitation',
      interactionScope: 'reply-turn',
      answers: { __mcp_approval: { answers: ['Allow'] } },
    })
  }
)

test('previews complete email contents and preserves the native cancellation value', async () => {
  const onSubmit = vi.fn(async () => true)
  const payload = {
    kind: 'request_user_input',
    requestId: 'email-approval',
    itemId: 'mail-call',
    questions: [
      {
        id: 'mcp_tool_call_approval_mail-call',
        question: 'Allow?',
        options: [{ label: 'Allow' }, { label: 'Cancel' }],
      },
    ],
  }
  const messages = [
    {
      id: 'mail-turn',
      role: 'assistant',
      content: '',
      blocks: [
        {
          id: 'mail-call',
          type: 'tool',
          toolName: 'wework_stand_in.send_email',
          toolInput: {
            from: 'owner@example.com',
            to: 'recipient@example.com',
            subject: 'Review this email',
            text: 'First paragraph\n\nComplete final paragraph',
          },
        },
        { id: 'approval', type: 'tool', toolName: 'request_user_input', renderPayload: payload },
      ],
    },
  ] as WorkbenchMessage[]
  render(<RequestUserInputCard messages={messages} payload={payload} onSubmit={onSubmit} />)
  const preview = screen.getByTestId('request-user-input-question-mcp_tool_call_approval_mail-call')
  for (const value of [
    'owner@example.com',
    'recipient@example.com',
    'Review this email',
    'Complete final paragraph',
  ])
    expect(preview).toHaveTextContent(value)
  await userEvent.click(screen.getByRole('button', { name: /不发送/ }))
  expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({
      answers: { 'mcp_tool_call_approval_mail-call': { answers: ['Cancel'] } },
    })
  )
})

test.each([
  'exact',
  'mismatched',
  'ambiguous',
  'unknown-tool',
  'completed',
  'wrong-server',
  'plain-form',
  'missing-arguments',
  'other-owner',
  'no-tools',
  'wrong-title',
  'missing-title',
  'wrong-question',
  'wrong-interaction',
  'invalid-field',
  'expired',
  'answered',
] as const)(
  'uses the current native email approval identity and arguments independently of tool display state: %s',
  async variant => {
    const input = {
      from: 'owner@example.com',
      to: 'sender@example.com',
      subject: 'Re: Review',
      text: 'Complete native email body\n\nFinal paragraph <b>plain text</b>',
    }
    const payload: RequestUserInputPayload = {
      kind: 'request_user_input',
      requestId: 'native-email-approval',
      itemId: 'mcp_server_elicitation',
      serverName: variant === 'wrong-server' ? 'other-server' : 'wework_stand_in',
      approvalKind: variant === 'plain-form' ? undefined : 'mcp_tool_call',
      toolTitle:
        variant === 'wrong-title'
          ? 'Other tool'
          : variant === 'missing-title'
            ? undefined
            : 'Wework: Send email',
      interactionKind: variant === 'wrong-interaction' ? 'mcp_url' : 'mcp_form',
      interactionStatus:
        variant === 'expired' ? 'expired' : variant === 'answered' ? 'answered' : 'pending',
      interactionScope: 'native-turn',
      toolArguments:
        variant === 'missing-arguments'
          ? undefined
          : variant === 'mismatched'
            ? { ...input, text: 'Different body' }
            : variant === 'invalid-field'
              ? { ...input, text: 42 }
              : input,
      questions: [
        {
          id: variant === 'wrong-question' ? 'other-question' : '__mcp_approval',
          question: 'Native approval',
          options: [{ label: 'Allow' }, { label: 'Decline' }],
        },
      ],
    }
    const tool = {
      id: 'mail-call',
      type: 'tool',
      status: variant === 'completed' ? 'done' : 'pending',
      toolName: 'wework_stand_in.send_email',
      toolInput: input,
    }
    const messages = [
      {
        id: 'current-turn',
        role: 'assistant',
        content: '',
        blocks: [
          ...(variant === 'other-owner' ? [] : [tool]),
          ...(variant === 'ambiguous' || variant === 'unknown-tool'
            ? [
                {
                  ...tool,
                  id: 'other-mail-call',
                  toolName: variant === 'unknown-tool' ? 'other.send' : tool.toolName,
                },
              ]
            : []),
          { id: 'approval', type: 'tool', toolName: 'request_user_input', renderPayload: payload },
        ],
      },
      ...(variant === 'other-owner'
        ? [{ id: 'previous-turn', role: 'assistant', content: '', blocks: [tool] }]
        : []),
    ] as WorkbenchMessage[]
    const onSubmit = vi.fn(async () => true)
    render(
      <RequestUserInputCard
        messages={variant === 'no-tools' ? [] : messages}
        payload={payload}
        onSubmit={onSubmit}
      />
    )
    if (
      [
        'wrong-server',
        'plain-form',
        'missing-arguments',
        'wrong-title',
        'missing-title',
        'wrong-question',
        'wrong-interaction',
        'invalid-field',
        'expired',
        'answered',
      ].includes(variant)
    ) {
      expect(screen.queryByText(/Complete native email body/)).not.toBeInTheDocument()
      expect(onSubmit).not.toHaveBeenCalled()
      return
    }
    const preview = screen.getByTestId('request-user-input-question-__mcp_approval')
    for (const value of Object.values(payload.toolArguments!))
      expect(preview).toHaveTextContent(String(value).replace(/\s+/g, ' '))
    await userEvent.click(screen.getByRole('button', { name: /不发送/ }))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'native-email-approval',
        itemId: 'mcp_server_elicitation',
        interactionScope: 'native-turn',
        answers: { __mcp_approval: { answers: ['Decline'] } },
      })
    )
  }
)

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

test('preserves a typed draft when another question arrives and submits both answers', async () => {
  const onSubmit = vi.fn(async () => true)
  const payload: RequestUserInputPayload = {
    kind: 'request_user_input',
    delivery: 'async',
    itemId: 'first',
    questions: [{ id: 'first', question: 'First?' }],
  }
  const { rerender } = render(<RequestUserInputCard payload={payload} onSubmit={onSubmit} />)
  fireEvent.change(screen.getByTestId('request-user-input-custom-first'), {
    target: { value: 'Draft answer' },
  })
  rerender(
    <RequestUserInputCard
      payload={{
        ...payload,
        questions: [
          ...payload.questions!,
          {
            id: 'second',
            question: 'Second?',
            options: [{ label: 'Default answer' }],
          },
        ],
      }}
      onSubmit={onSubmit}
    />
  )
  expect(screen.getByTestId('request-user-input-custom-first')).toHaveValue('Draft answer')
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  await waitFor(() =>
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        answers: { first: { answers: ['Draft answer'] }, second: { answers: ['Default answer'] } },
      })
    )
  )
})
