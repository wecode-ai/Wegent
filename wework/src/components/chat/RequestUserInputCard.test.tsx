import '@/i18n'

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { RequestUserInputCard } from './RequestUserInputCard'

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
    expect(option).toHaveClass('min-h-9', 'items-start', 'py-2')
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
