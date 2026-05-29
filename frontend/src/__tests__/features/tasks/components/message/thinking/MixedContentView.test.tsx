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

jest.mock('@/features/tasks/components/message/thinking/components/GuidanceBlock', () => ({
  GuidanceBlock: ({ block }: { block: { content: string } }) => (
    <div data-testid="guidance-block">{block.content}</div>
  ),
}))

jest.mock('@/features/tasks/components/message/thinking/ReasoningDisplay', () => ({
  __esModule: true,
  default: ({
    reasoningContent,
    isStreaming,
  }: {
    reasoningContent: string
    isStreaming?: boolean
  }) => (
    <div data-testid="inline-thinking-block" data-streaming={isStreaming ? 'true' : 'false'}>
      {reasoningContent}
    </div>
  ),
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
  it('renders thinking blocks in chronological order as standalone collapsible items', () => {
    render(
      <MixedContentView
        thinking={null}
        content=""
        theme="light"
        blocks={[
          {
            id: 'thinking-1',
            type: 'thinking',
            status: 'done',
            content: 'First thought.',
          },
          {
            id: 'text-1',
            type: 'text',
            status: 'done',
            content: 'First answer.',
          },
          {
            id: 'tool-1',
            type: 'tool',
            status: 'done',
            tool_name: 'Read',
            tool_use_id: 'tool-1',
            tool_input: { file_path: 'README.md' },
          },
          {
            id: 'thinking-2',
            type: 'thinking',
            status: 'streaming',
            content: 'Second thought.',
          },
          {
            id: 'text-2',
            type: 'text',
            status: 'streaming',
            content: 'Final answer.',
          },
        ]}
      />
    )

    const firstThought = screen.getByText('First thought.')
    const firstAnswer = screen.getByText('First answer.')
    const toolBlock = screen.getByTestId('tool-block')
    const secondThought = screen.getByText('Second thought.')
    const finalAnswer = screen.getByText('Final answer.')

    expect(firstThought.compareDocumentPosition(firstAnswer)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(firstAnswer.compareDocumentPosition(toolBlock)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(toolBlock.compareDocumentPosition(secondThought)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(secondThought.compareDocumentPosition(finalAnswer)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(screen.getAllByTestId('inline-thinking-block')).toHaveLength(2)
    expect(screen.getByText('Second thought.')).toHaveAttribute('data-streaming', 'true')
  })

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

  it('shows the processing indicator when task is running', () => {
    render(
      <MixedContentView
        thinking={null}
        content="雨后的清晨"
        taskStatus="RUNNING"
        theme="light"
        taskId={2493}
        subtaskId={2730}
        currentMessageIndex={0}
        blocks={[
          {
            id: 'text-final',
            type: 'text',
            status: 'done',
            content: '雨后的清晨',
          },
        ]}
      />
    )

    expect(screen.getByText('雨后的清晨')).toBeInTheDocument()
    const indicator = screen.getByTestId('streaming-wait-indicator')

    expect(screen.getAllByText('thinking.processing')).toHaveLength(1)
    expect(screen.getByTestId('streaming-wait-runner-dot')).toBeInTheDocument()
    expect(indicator.querySelectorAll('.animate-pulse')).toHaveLength(0)
  })

  it('renders guidance blocks in mixed content', () => {
    render(
      <MixedContentView
        thinking={null}
        content=""
        theme="light"
        blocks={[
          {
            id: 'guidance-1',
            type: 'guidance',
            guidance_id: 'guidance-1',
            content: 'Keep it concise',
            status: 'applied',
          },
        ]}
      />
    )

    expect(screen.getByTestId('guidance-block')).toHaveTextContent('Keep it concise')
  })
})
