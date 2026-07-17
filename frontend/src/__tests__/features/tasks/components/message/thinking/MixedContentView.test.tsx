// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
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
  AskUserForm: ({ data }: { data: { tool_use_id: string; questions: unknown[] } }) => (
    <div data-testid="ask-user-form-block">
      {data.tool_use_id}:{data.questions.length}
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

const createToolOutput = (result: Record<string, unknown>) =>
  JSON.stringify({ result: JSON.stringify(result) })

const createSuccessfulFormOutput = (form: Record<string, unknown>) =>
  createToolOutput({
    __silent_exit__: true,
    reason:
      'interactive_form_question form displayed; waiting for user response via new conversation',
    success: true,
    status: 'form_rendered',
    form,
  })

describe('MixedContentView', () => {
  it('renders child agent output inside an expandable subagent block', () => {
    render(
      <MixedContentView
        thinking={null}
        content=""
        theme="light"
        blocks={[
          {
            id: 'Agent_0',
            type: 'subagent',
            tool_use_id: 'Agent_0',
            title: 'Inspect backend',
            agent_type: 'Explore',
            summary: 'Inspection completed',
            status: 'done',
            children: [
              {
                id: 'child-text',
                type: 'text',
                parent_tool_use_id: 'Agent_0',
                content: 'Found the parser path',
                status: 'done',
              },
              {
                id: 'child-tool',
                type: 'tool',
                parent_tool_use_id: 'Agent_0',
                tool_use_id: 'child-tool',
                tool_name: 'Read',
                status: 'done',
              },
            ],
          },
        ]}
      />
    )

    const subagent = screen.getByTestId('subagent-block')
    expect(subagent).toHaveTextContent('Inspect backend')
    expect(screen.queryByText('Found the parser path')).not.toBeInTheDocument()

    fireEvent.click(subagent)

    expect(screen.getByText('Inspection completed')).toBeInTheDocument()
    expect(screen.getByText('Found the parser path')).toBeInTheDocument()
    expect(screen.getByTestId('tool-block')).toBeInTheDocument()
  })

  it('rebuilds subagent children from persisted flat blocks after refresh', () => {
    render(
      <MixedContentView
        thinking={null}
        content=""
        theme="light"
        blocks={[
          {
            id: 'Agent_0',
            type: 'subagent',
            tool_use_id: 'Agent_0',
            title: 'Write essays',
            agent_type: 'Agent',
            status: 'invoking',
            children: [],
          },
          {
            id: 'Write_1',
            type: 'tool',
            parent_tool_use_id: 'Agent_0',
            tool_use_id: 'Write_1',
            tool_name: 'Write',
            status: 'done',
          },
          {
            id: 'Write_2',
            type: 'tool',
            parent_tool_use_id: 'Agent_0',
            tool_use_id: 'Write_2',
            tool_name: 'Write',
            status: 'done',
          },
        ]}
      />
    )

    const subagent = screen.getByTestId('subagent-block')
    expect(screen.queryAllByTestId('tool-block')).toHaveLength(0)

    fireEvent.click(subagent)

    expect(screen.getAllByTestId('tool-block')).toHaveLength(2)
  })

  it('groups consecutive parallel subagents into one native execution block', () => {
    render(
      <MixedContentView
        thinking={null}
        content=""
        theme="light"
        blocks={[
          {
            id: 'Agent_0',
            type: 'subagent',
            tool_use_id: 'Agent_0',
            title: 'Two Sum solution',
            status: 'done',
            children: [
              {
                id: 'Write_0',
                type: 'tool',
                parent_tool_use_id: 'Agent_0',
                tool_use_id: 'Write_0',
                tool_name: 'Write',
                status: 'done',
              },
            ],
          },
          {
            id: 'Agent_1',
            type: 'subagent',
            tool_use_id: 'Agent_1',
            title: 'Reverse linked list',
            status: 'done',
            children: [
              {
                id: 'Write_1',
                type: 'tool',
                parent_tool_use_id: 'Agent_1',
                tool_use_id: 'Write_1',
                tool_name: 'Write',
                status: 'done',
              },
            ],
          },
        ]}
      />
    )

    expect(screen.getByTestId('subagent-group-block')).toBeInTheDocument()
    expect(screen.queryByTestId('subagent-block')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('subagent-tree-item')).toHaveLength(2)
    expect(screen.getAllByTestId('tool-block')).toHaveLength(1)

    fireEvent.click(screen.getByTestId('subagent-tree-toggle-Agent_1'))
    expect(screen.getAllByTestId('tool-block')).toHaveLength(1)

    fireEvent.click(screen.getByTestId('subagent-group-toggle'))
    expect(screen.queryByTestId('subagent-tree-item')).not.toBeInTheDocument()
  })

  it('renders queued, running, and completed subagent lifecycle states explicitly', () => {
    render(
      <MixedContentView
        thinking={null}
        content=""
        theme="light"
        blocks={[
          {
            id: 'Agent_queued',
            type: 'subagent',
            tool_use_id: 'Agent_queued',
            title: 'Waiting task',
            status: 'queued',
          },
          {
            id: 'Agent_running',
            type: 'subagent',
            tool_use_id: 'Agent_running',
            title: 'Running task',
            status: 'invoking',
          },
          {
            id: 'Agent_done',
            type: 'subagent',
            tool_use_id: 'Agent_done',
            title: 'Completed task',
            status: 'done',
          },
        ]}
      />
    )

    expect(screen.getByTestId('subagent-tree-status-Agent_queued')).toHaveTextContent(
      'thinking.subagent.status_queued'
    )
    expect(screen.getByTestId('subagent-tree-status-Agent_running')).toHaveTextContent(
      'thinking.subagent.status_running'
    )
    expect(screen.getByTestId('subagent-tree-status-Agent_done')).toHaveTextContent(
      'thinking.subagent.status_completed'
    )
  })

  it('does not treat a queued standalone subagent as completed', () => {
    render(
      <MixedContentView
        thinking={null}
        content=""
        theme="light"
        blocks={[
          {
            id: 'Agent_queued',
            type: 'subagent',
            tool_use_id: 'Agent_queued',
            title: 'Waiting task',
            status: 'queued',
          },
        ]}
      />
    )

    expect(screen.getByTestId('subagent-status')).toHaveTextContent(
      'thinking.subagent.status_queued'
    )
  })

  it('collapses additional subagents behind a show-all action', () => {
    render(
      <MixedContentView
        thinking={null}
        content=""
        theme="light"
        blocks={Array.from({ length: 7 }, (_, index) => ({
          id: `Agent_${index}`,
          type: 'subagent' as const,
          tool_use_id: `Agent_${index}`,
          title: `Task ${index + 1}`,
          status: 'done' as const,
        }))}
      />
    )

    expect(screen.getAllByTestId('subagent-tree-item')).toHaveLength(5)
    fireEvent.click(screen.getByTestId('subagent-group-show-all'))
    expect(screen.getAllByTestId('subagent-tree-item')).toHaveLength(7)
  })

  it('renders interactive forms from render_payload', () => {
    const renderPayload = {
      type: 'interactive_form_question',
      task_id: 2493,
      subtask_id: 2730,
      questions: [
        {
          id: 'target_lang',
          question: '目标语言',
          input_type: 'choice',
          required: true,
          multi_select: false,
          options: [{ label: 'English', value: 'en' }],
          default: null,
          placeholder: null,
        },
      ],
    }

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
            id: 'tool_render_payload',
            type: 'tool',
            status: 'pending',
            tool_name: 'interactive_form_question',
            tool_use_id: 'tool_render_payload',
            tool_input: {
              questions: [{ id: 'raw', question: 'raw should not render' }],
            },
            tool_output: createToolOutput({
              __deferred_user_input__: true,
              success: true,
              status: 'waiting_for_user_response',
            }),
            render_payload: renderPayload,
          },
        ]}
      />
    )

    expect(screen.getByTestId('ask-user-form-block')).toHaveTextContent('tool_render_payload:1')
  })

  it('deduplicates interactive forms with the same tool_use_id', () => {
    const renderPayload = {
      type: 'interactive_form_question',
      task_id: 2493,
      subtask_id: 2730,
      questions: [
        {
          id: 'target_lang',
          question: '目标语言',
          input_type: 'choice',
          required: true,
          multi_select: false,
          options: [{ label: 'English', value: 'en' }],
          default: null,
          placeholder: null,
        },
      ],
    }

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
            id: 'tool_duplicate_first',
            type: 'tool',
            status: 'pending',
            tool_name: 'interactive_form_question',
            tool_use_id: 'tool_duplicate',
            tool_output: createToolOutput({
              __deferred_user_input__: true,
              success: true,
              status: 'waiting_for_user_response',
            }),
            render_payload: renderPayload,
          },
          {
            id: 'tool_duplicate_second',
            type: 'tool',
            status: 'pending',
            tool_name: 'interactive_form_question',
            tool_use_id: 'tool_duplicate',
            tool_output: createToolOutput({
              __deferred_user_input__: true,
              success: true,
              status: 'waiting_for_user_response',
            }),
            render_payload: renderPayload,
          },
        ]}
      />
    )

    const forms = screen.getAllByTestId('ask-user-form-block')
    expect(forms).toHaveLength(1)
    expect(forms[0]).toHaveTextContent('tool_duplicate:1')
  })

  it('does not render interactive forms from tool_output.form', () => {
    const form = {
      type: 'interactive_form_question',
      task_id: 2493,
      subtask_id: 2730,
      questions: [
        {
          id: 'target_lang',
          question: '目标语言',
          input_type: 'choice',
          required: true,
          multi_select: false,
          options: [{ label: 'English', value: 'en' }],
          default: null,
          placeholder: null,
        },
      ],
    }

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
            id: 'tool_output_form',
            type: 'tool',
            status: 'pending',
            tool_name: 'interactive_form_question',
            tool_use_id: 'tool_output_form',
            tool_input: {},
            tool_output: createSuccessfulFormOutput(form),
          },
        ]}
      />
    )

    expect(screen.queryByTestId('ask-user-form-block')).not.toBeInTheDocument()
  })

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
    const form = {
      type: 'interactive_form_question',
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
    }

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
            id: 'tool_2730',
            type: 'tool',
            status: 'pending',
            tool_name: 'interactive_form_question',
            tool_use_id: 'tool_2730',
            tool_output: createToolOutput({
              __deferred_user_input__: true,
              success: true,
              status: 'waiting_for_user_response',
            }),
            tool_input: {},
            render_payload: form,
          },
          {
            id: 'chatcmpl-tool-426bdd2d71374862a96c40baae380e92',
            type: 'tool',
            status: 'done',
            tool_name:
              'mcp__interactive-form-question_wegent-interactive-form-question__interactive_form_question',
            tool_use_id: 'chatcmpl-tool-426bdd2d71374862a96c40baae380e92',
            tool_input: {},
            tool_output: createToolOutput({
              __silent_exit__: true,
              reason:
                'interactive_form_question form displayed; waiting for user response via new conversation',
              success: true,
            }),
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
    expect(forms[0]).toHaveTextContent('tool_2730:1')
    expect(screen.queryByTestId('tool-block')).not.toBeInTheDocument()
    expect(
      screen.getByText('我已经了解了项目的基本结构。让我向您询问关于登录功能的具体需求。')
    ).toBeInTheDocument()
    expect(
      screen.queryByText('1. 其他想法或补充说明 2. 其他想法或补充说明，请回答以下问题。')
    ).not.toBeInTheDocument()
  })

  it('does not render an interactive form when restored questions are empty objects', () => {
    const form = {
      type: 'interactive_form_question',
      task_id: 2479,
      subtask_id: 2716,
      questions: [{}, {}, {}],
    }

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
              task_id: 2479,
              subtask_id: 2716,
              questions: [{}, {}, {}],
            },
            tool_output: createToolOutput({
              __deferred_user_input__: true,
              success: true,
              status: 'waiting_for_user_response',
            }),
            render_payload: form,
          },
        ]}
      />
    )

    expect(screen.queryByTestId('ask-user-form-block')).not.toBeInTheDocument()
    expect(screen.queryByTestId('tool-block')).not.toBeInTheDocument()
  })

  it('does not render interactive form tool arguments when the tool result is not successful', () => {
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
            id: 'toolu_error',
            type: 'tool',
            status: 'done',
            tool_name:
              'mcp__interactive-form-question_wegent-interactive-form-question__interactive_form_question',
            tool_use_id: 'toolu_error',
            tool_input: {
              questions: [
                {
                  id: 'source_lang',
                  question: '源语言',
                  input_type: 'single_select',
                  required: true,
                  options: [{ label: '自动检测', value: 'auto' }],
                },
              ],
            },
            tool_output: createToolOutput({
              error: '1 validation error for InteractiveFormQuestionItem',
            }),
          },
        ]}
      />
    )

    expect(screen.queryByTestId('ask-user-form-block')).not.toBeInTheDocument()
    expect(screen.queryByTestId('tool-block')).not.toBeInTheDocument()
  })

  it('does not render interactive form tool arguments when the successful result has no form', () => {
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
            id: 'toolu_success_without_form',
            type: 'tool',
            status: 'done',
            tool_name:
              'mcp__interactive-form-question_wegent-interactive-form-question__interactive_form_question',
            tool_use_id: 'toolu_success_without_form',
            tool_input: {
              questions: [
                {
                  id: 'source_lang',
                  question: '源语言',
                  input_type: 'choice',
                  required: true,
                  options: [{ label: '自动检测', value: 'auto' }],
                },
              ],
            },
            tool_output: createToolOutput({
              __silent_exit__: true,
              reason:
                'interactive_form_question form displayed; waiting for user response via new conversation',
              success: true,
            }),
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
