import '@/i18n'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import { RequestUserInputCard, type RequestUserInputPayload } from './RequestUserInputCard'

function approval(instance: string): RequestUserInputPayload {
  return {
    requestId: 'native-git-write',
    itemId: 'mcp_server_elicitation',
    interactionScope: 'native-turn',
    interactionKind: 'mcp_form',
    interactionStatus: 'pending',
    serverName: 'wework_stand_in',
    approvalKind: 'mcp_tool_call',
    toolTitle: 'Publish GitHub/GitLab change',
    toolArguments: {
      requestId: 'comment',
      instance,
      accountId: '42',
      repository: 'org/repository',
      method: 'POST',
      path: 'issues/1/comments',
      body: { body: '完整评论 <b>作为文本</b>', nested: { value: '保留完整字段' } },
    },
    questions: [
      {
        id: '__mcp_approval',
        question: 'Allow this tool?',
        options: [{ label: 'Allow' }, { label: 'Decline' }],
      },
    ],
  }
}

function webhookApproval(events: unknown[]): RequestUserInputPayload {
  const payload = approval('https://github.com')
  payload.toolTitle = 'Configure repository webhook'
  payload.toolArguments = {
    requestId: 'hook',
    instance: 'https://github.com',
    repository: 'org/repository',
    callbackUrl: 'https://wework.example/api/v1/git-connections/hooks/receiver',
    subscriptionId: 'receiver',
    events,
  }
  return payload
}

test.each([['*'], ['issues_events', 'pipeline_events']])(
  'shows the exact native webhook destination and event scope: %j',
  async (...events) => {
    const payload = webhookApproval(events)
    const onSubmit = vi.fn(async () => true)
    render(<RequestUserInputCard payload={payload} onSubmit={onSubmit} />)
    const preview = screen.getByTestId('request-user-input-question-__mcp_approval')
    for (const value of [
      'https://github.com',
      'org/repository',
      'https://wework.example/api/v1/git-connections/hooks/receiver',
      ...events,
    ])
      expect(preview).toHaveTextContent(value)
    expect(onSubmit).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: /取消写入/ }))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        answers: { __mcp_approval: { answers: ['Decline'] } },
      })
    )
  }
)

test.each([[], [42], ['']])('rejects invalid webhook event metadata: %j', (...events) => {
  const onSubmit = vi.fn()
  render(<RequestUserInputCard payload={webhookApproval(events)} onSubmit={onSubmit} />)
  expect(screen.queryByText(/确认配置仓库 Webhook/)).not.toBeInTheDocument()
  expect(onSubmit).not.toHaveBeenCalled()
})

test.each(['https://github.com', 'https://gitlab.company.example'])(
  'shows exact native Git write details and preserves one-time denial: %s',
  async instance => {
    const payload = approval(instance)
    const original = structuredClone(payload)
    const onSubmit = vi.fn(async () => true)
    const messages = [
      {
        id: 'stale-turn',
        role: 'assistant',
        content: '',
        blocks: [
          {
            id: 'old-write',
            type: 'tool',
            toolName: 'wework_stand_in.git_write',
            toolInput: { repository: 'wrong/repository', body: { body: 'Stale body' } },
          },
        ],
      },
    ] as WorkbenchMessage[]
    render(<RequestUserInputCard payload={payload} messages={messages} onSubmit={onSubmit} />)
    const preview = screen.getByTestId('request-user-input-question-__mcp_approval')
    for (const value of [
      instance,
      '42',
      'org/repository',
      'POST',
      'issues/1/comments',
      '完整评论 <b>作为文本</b>',
      '保留完整字段',
    ])
      expect(preview).toHaveTextContent(value)
    expect(preview).not.toHaveTextContent('wrong/repository')
    expect(preview.querySelector('b')).toBeNull()
    expect(onSubmit).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: /取消写入/ }))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'native-git-write',
        itemId: 'mcp_server_elicitation',
        interactionScope: 'native-turn',
        answers: { __mcp_approval: { answers: ['Decline'] } },
      })
    )
    expect(payload).toEqual(original)
  }
)

test.each([
  'ordinary-form',
  'other-server',
  'other-tool',
  'missing-account',
  'array-body',
  'read-method',
])('does not present a malformed or unrelated form as a native Git write: %s', variant => {
  const payload = approval('https://github.com')
  if (variant === 'ordinary-form') delete payload.approvalKind
  if (variant === 'other-server') payload.serverName = 'other'
  if (variant === 'other-tool') payload.toolTitle = 'Other tool'
  if (variant === 'missing-account') delete payload.toolArguments!.accountId
  if (variant === 'array-body') payload.toolArguments!.body = []
  if (variant === 'read-method') payload.toolArguments!.method = 'GET'
  const onSubmit = vi.fn()
  render(<RequestUserInputCard payload={payload} onSubmit={onSubmit} />)
  expect(screen.queryByText(/完整评论/)).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /确认写入/ })).not.toBeInTheDocument()
  expect(onSubmit).not.toHaveBeenCalled()
})
