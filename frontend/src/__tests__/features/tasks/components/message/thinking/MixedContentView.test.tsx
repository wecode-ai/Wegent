// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import MixedContentView from '@/features/tasks/components/message/thinking/MixedContentView'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/features/tasks/components/message/thinking/components/ToolBlock', () => ({
  ToolBlock: () => <div data-testid="tool-block" />,
}))

jest.mock('@/components/common/EnhancedMarkdown', () => ({
  __esModule: true,
  default: ({ source }: { source: string }) => <div>{source}</div>,
}))

jest.mock('@/features/tasks/components/clarification', () => ({
  AskUserForm: ({ data }: { data: { ask_id: string; questions: unknown[] } }) => (
    <div data-testid="ask-user-form-block">
      {data.ask_id}:{data.questions.length}
    </div>
  ),
}))

jest.mock('@/features/tasks/components/message/VideoPlayer', () => ({
  __esModule: true,
  default: () => <div data-testid="video-player" />,
}))

jest.mock('@/features/tasks/components/message/ImageGallery', () => ({
  ImageGallery: () => <div data-testid="image-gallery" />,
}))

jest.mock('@/features/tasks/components/subscription/SubscriptionPreviewCard', () => ({
  SubscriptionPreviewCard: () => <div data-testid="subscription-preview" />,
}))

jest.mock('@/features/tasks/components/message/block-registry', () => ({
  blockRendererRegistry: {
    findRenderer: () => null,
  },
}))

jest.mock('@/features/prompt-optimization/block-renderer', () => ({}))

describe('MixedContentView', () => {
  it('renders only the interactive form block that contains questions', () => {
    render(
      <MixedContentView
        thinking={null}
        content=""
        theme="light"
        taskId={2493}
        subtaskId={2730}
        currentMessageIndex={0}
        blocks={[
          {
            id: 'ask_2730',
            type: 'tool',
            status: 'pending',
            tool_name: 'interactive_form_question',
            tool_use_id: 'ask_2730',
            tool_input: {
              type: 'interactive_form_question',
              ask_id: 'ask_2730',
              task_id: 2493,
              subtask_id: 2730,
              questions: [
                {
                  id: 'additional_input',
                  question: '其他想法或补充说明',
                  input_type: 'text',
                  required: false,
                  multi_select: false,
                  options: null,
                  default: null,
                  placeholder: '在此输入其他想法、补充需求或特殊说明...',
                },
              ],
            },
          },
          {
            id: 'chatcmpl-tool-426bdd2d71374862a96c40baae380e92',
            type: 'tool',
            status: 'done',
            tool_name:
              'mcp__interactive-form-question_wegent-interactive-form-question__interactive_form_question',
            tool_use_id: 'chatcmpl-tool-426bdd2d71374862a96c40baae380e92',
            tool_input: {},
            tool_output:
              '{"result":"{\\"__silent_exit__\\": true, \\"reason\\": \\"interactive_form_question form displayed; waiting for user response via new conversation\\"}"}',
          },
          {
            id: 'text-intro',
            type: 'text',
            status: 'done',
            content: '我已经了解了项目的基本结构。让我向您询问关于登录功能的具体需求。',
          },
          {
            id: 'text-duplicate',
            type: 'text',
            status: 'done',
            content: '1. 其他想法或补充说明 2. 其他想法或补充说明，请回答以下问题。',
          },
        ]}
      />
    )

    const forms = screen.getAllByTestId('ask-user-form-block')
    expect(forms).toHaveLength(1)
    expect(forms[0]).toHaveTextContent('ask_2730:1')
    expect(screen.queryByTestId('tool-block')).not.toBeInTheDocument()
    expect(
      screen.getByText('我已经了解了项目的基本结构。让我向您询问关于登录功能的具体需求。')
    ).toBeInTheDocument()
    expect(
      screen.queryByText('1. 其他想法或补充说明 2. 其他想法或补充说明，请回答以下问题。')
    ).not.toBeInTheDocument()
  })

  it('does not render an interactive form when restored questions are empty objects', () => {
    render(
      <MixedContentView
        thinking={null}
        content=""
        theme="light"
        taskId={2493}
        subtaskId={2730}
        currentMessageIndex={0}
        blocks={[
          {
            id: 'toolu_invalid',
            type: 'tool',
            status: 'done',
            tool_name:
              'mcp__interactive-form-question_wegent-interactive-form-question__interactive_form_question',
            tool_use_id: 'toolu_invalid',
            tool_input: {
              type: 'interactive_form_question',
              ask_id: 'ask_2716',
              task_id: 2479,
              subtask_id: 2716,
              questions: [{}, {}, {}],
            },
            tool_output:
              '{"result":"{\\"__silent_exit__\\": true, \\"reason\\": \\"interactive_form_question form displayed; waiting for user response via new conversation\\"}"}',
          },
        ]}
      />
    )

    expect(screen.queryByTestId('ask-user-form-block')).not.toBeInTheDocument()
    expect(screen.queryByTestId('tool-block')).not.toBeInTheDocument()
  })
})
