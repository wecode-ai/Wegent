import '@/i18n'
import type { ProcessingBlock } from '@/types/workbench'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ToolBlocksDisplay } from './ToolBlocksDisplay'

const completedCommandBlock: ProcessingBlock = {
  id: 'call-1',
  subtaskId: 1,
  type: 'tool',
  toolName: 'bash',
  toolInput: { command: 'pwd' },
  toolOutput: '/workspace/project\n',
  status: 'done',
  createdAt: 1770000000000,
}

const completedFileChangesBlock: ProcessingBlock = {
  id: 'file-changes-1',
  subtaskId: 1,
  type: 'file_changes',
  status: 'done',
  createdAt: 1770000003000,
  fileChanges: {
    version: 1,
    status: 'active',
    artifact_id: 'artifact-1',
    device_id: 'device-1',
    workspace_path: '/tmp/project',
    file_count: 1,
    additions: 2,
    deletions: 1,
    files: [
      {
        path: 'scripts/env',
        change_type: 'modified',
        additions: 2,
        deletions: 1,
        binary: false,
      },
    ],
    reverted_at: null,
    revertible: false,
    diff: [
      'diff --git a/scripts/env b/scripts/env',
      '--- a/scripts/env',
      '+++ b/scripts/env',
      '@@ -8,2 +8,3 @@',
      '-OLD_ENV=remote',
      '+OLD_ENV=local',
      '+BACKEND_URL=127.0.0.1',
    ].join('\n'),
  },
}

describe('ToolBlocksDisplay', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('keeps tool output truncation invisible while rendering the retained output', () => {
    const { container } = render(
      <ToolBlocksDisplay
        blocks={[
          {
            ...completedCommandBlock,
            toolOutput: 'latest retained shell output',
            toolOutputTruncated: true,
            toolOutputOriginalChars: 120_001,
          },
        ]}
        isStreaming={false}
      />
    )

    expect(container.firstElementChild).not.toHaveClass('border-b')
    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))
    fireEvent.click(screen.getByText('运行 pwd'))

    expect(screen.getByTestId('shell-tool-output')).toHaveTextContent(
      'latest retained shell output'
    )
    expect(screen.queryByText(/早期输出.*卸载/)).not.toBeInTheDocument()
    expect(screen.queryByText(/加载完整输出/)).not.toBeInTheDocument()
  })

  test('groups parallel subagents and delegates selection to the conversation opener', () => {
    const onOpenSubagent = vi.fn()
    render(
      <ToolBlocksDisplay
        blocks={[
          {
            id: 'subagent-thread-1',
            subtaskId: 'turn-1',
            type: 'subagent',
            title: 'Explorer',
            status: 'streaming',
            createdAt: 1770000000000,
            children: [
              {
                id: 'child-text-1',
                subtaskId: 'turn-1',
                parentToolUseId: 'subagent-thread-1',
                type: 'text',
                content: 'Explorer output',
                status: 'streaming',
                createdAt: 1770000000100,
              },
            ],
          },
          {
            id: 'subagent-thread-2',
            subtaskId: 'turn-1',
            type: 'subagent',
            title: 'Reviewer',
            status: 'streaming',
            createdAt: 1770000000200,
            children: [
              {
                id: 'child-text-2',
                subtaskId: 'turn-1',
                parentToolUseId: 'subagent-thread-2',
                type: 'text',
                content: 'Reviewer output',
                status: 'streaming',
                createdAt: 1770000000300,
              },
            ],
          },
        ]}
        isStreaming
        onOpenSubagent={onOpenSubagent}
      />
    )

    expect(screen.getAllByTestId('subagent-activity-chip')).toHaveLength(2)
    expect(screen.getByTestId('subagent-activity-status')).toHaveTextContent('工作中')
    expect(screen.queryByText('Explorer output')).not.toBeInTheDocument()
    expect(screen.queryByText('Reviewer output')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '打开 Reviewer 子代理' }))

    expect(onOpenSubagent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'subagent-thread-2' })
    )
  })

  test('does not finish an in-flight diff copy after unmount', async () => {
    let resolveWriteText: (() => void) | undefined
    const writeText = vi.fn(
      () =>
        new Promise<void>(resolve => {
          resolveWriteText = resolve
        })
    )
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    const { unmount } = render(
      <ToolBlocksDisplay blocks={[completedFileChangesBlock]} isStreaming={false} />
    )
    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))
    fireEvent.click(screen.getByRole('button', { name: /编辑 env/ }))
    fireEvent.click(screen.getByTestId('copy-process-file-change-diff-button'))
    expect(writeText).toHaveBeenCalledOnce()

    unmount()
    const timerCallsBeforeCopyResolved = setTimeoutSpy.mock.calls.length

    await act(async () => {
      resolveWriteText?.()
      await Promise.resolve()
    })

    expect(setTimeoutSpy).toHaveBeenCalledTimes(timerCallsBeforeCopyResolved)
    setTimeoutSpy.mockRestore()
  })

  test('renders reversed diff lines for a created file as additions', () => {
    render(
      <ToolBlocksDisplay
        blocks={[
          {
            ...completedFileChangesBlock,
            fileChanges: {
              ...completedFileChangesBlock.fileChanges,
              additions: 1,
              deletions: 0,
              files: [
                {
                  path: 'shot-list.md',
                  change_type: 'created',
                  additions: 1,
                  deletions: 0,
                  binary: false,
                },
              ],
              diff: [
                'diff --git a/shot-list.md b/shot-list.md',
                '--- a/shot-list.md',
                '+++ /dev/null',
                '@@ -1 +0,0 @@',
                '-课程标题：云端工作模式实战',
              ].join('\n'),
            },
          },
        ]}
        isStreaming={false}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /编辑 1 个文件 已处理/ }))
    fireEvent.click(screen.getByRole('button', { name: /创建 shot-list.md/ }))

    const content = screen.getByText('课程标题：云端工作模式实战')
    const line = content.parentElement

    expect(line?.firstElementChild).toHaveTextContent('1')
    expect(line).toHaveClass(
      'border-[rgb(var(--color-diff-added,34_197_94))]',
      'bg-[rgb(var(--color-diff-added,34_197_94)/0.1)]'
    )
    expect(line).not.toHaveClass('border-[rgb(var(--color-diff-removed,239_68_68))]')
  })

  test('persists file detail across summary keys and clears it when the summary closes', () => {
    const { unmount } = render(
      <ToolBlocksDisplay
        blocks={[completedFileChangesBlock]}
        isStreaming={false}
        stateKey="file-changes-live-summary"
        detailStateScopeKey="file-changes-message"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))
    expect(screen.getByText('编辑 env')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /编辑 env/ }))
    expect(screen.getByTestId('process-file-change-diff')).toBeInTheDocument()

    unmount()
    render(
      <ToolBlocksDisplay
        blocks={[completedFileChangesBlock]}
        isStreaming={false}
        stateKey="file-changes-ordered-summary"
        detailStateScopeKey="file-changes-message"
      />
    )

    expect(screen.getByTestId('processing-collapse-content')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('processing-live-preview')).toBeInTheDocument()
    expect(screen.getByTestId('process-file-changes-block')).toHaveTextContent('编辑 env')
    expect(screen.getByTestId('process-file-change-diff')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('processing-summary-toggle'))

    expect(screen.getByTestId('processing-summary-toggle')).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.queryByTestId('processing-live-preview')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('processing-summary-toggle'))

    expect(screen.getByRole('button', { name: /编辑 env/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.queryByTestId('process-file-change-diff')).not.toBeInTheDocument()
  })

  test('uses the same tool list for completed and streaming processing', () => {
    render(<ToolBlocksDisplay blocks={[completedCommandBlock]} isStreaming={false} />)

    const toggle = screen.getByRole('button', { name: /已处理/ })
    const collapseContent = screen.getByTestId('processing-collapse-content')
    expect(collapseContent).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByTestId('processing-live-preview')).not.toBeInTheDocument()

    fireEvent.click(toggle)

    expect(collapseContent).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('processing-live-preview')).toHaveTextContent('运行 pwd')
    expect(screen.getByTestId('processing-live-preview-scroll')).toHaveStyle({
      maxHeight: '7rem',
      overflowY: 'auto',
    })
  })

  test('keeps an explicitly expanded tool detail open when streaming enters the final phase', () => {
    const { rerender } = render(
      <ToolBlocksDisplay
        blocks={[completedCommandBlock]}
        isStreaming={true}
        processingPhase="live"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '展开工具详情' }))
    expect(screen.getByText('/workspace/project')).toBeInTheDocument()

    rerender(
      <ToolBlocksDisplay
        blocks={[completedCommandBlock]}
        isStreaming={true}
        processingPhase="final"
      />
    )

    expect(screen.getByTestId('processing-live-preview')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '收起工具详情' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByText('/workspace/project')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '收起工具详情' }))

    expect(screen.queryByTestId('processing-live-preview')).not.toBeInTheDocument()
  })

  test.each([
    { modelKind: 'custom', forceExpanded: false },
    { modelKind: 'codex-official', forceExpanded: false },
    { modelKind: 'codex-official', forceExpanded: true },
  ])(
    'shows retries immediately and clears them on recovery: %o',
    ({ modelKind, forceExpanded }) => {
      const retryBlock: ProcessingBlock = {
        id: 'retry-immediate',
        type: 'tool',
        toolName: 'runtime_reconnecting',
        toolInput: { model_kind: modelKind, retry_reason: 'connection' },
        status: 'streaming',
        createdAt: Date.now(),
      }
      const { rerender } = render(
        <ToolBlocksDisplay
          blocks={[completedCommandBlock, retryBlock]}
          isStreaming
          forceExpanded={forceExpanded}
          showInterToolThinking
          thinkingContent="Previous reasoning"
        />
      )
      expect(screen.getByTestId('processing-summary-header')).toHaveTextContent('正在自动重试…')
      const announcement = within(screen.getByTestId('processing-summary-header')).getByRole(
        'status'
      )
      expect(announcement).toHaveTextContent('正在自动重试…')
      expect(announcement).toHaveAttribute('aria-live', 'polite')
      expect(announcement).toHaveAttribute('aria-atomic', 'true')
      expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument()
      expect(screen.queryByTestId('tool-thinking-indicator')).not.toBeInTheDocument()

      rerender(
        <ToolBlocksDisplay
          blocks={[completedCommandBlock, { ...retryBlock, status: 'done' }]}
          isStreaming
          forceExpanded={forceExpanded}
        />
      )
      expect(screen.queryByText('正在自动重试…')).not.toBeInTheDocument()
      expect(
        screen.queryByTestId('processing-summary-header')?.querySelector('[role="status"]')
      ).toBeFalsy()
    }
  )

  test('shows answered request user input blocks as summaries while hiding pending blocks', () => {
    const pendingBlock: ProcessingBlock = {
      id: 'request-pending',
      subtaskId: 9,
      type: 'tool',
      toolName: 'request_user_input',
      status: 'done',
      createdAt: 1770000000000,
      renderPayload: {
        kind: 'request_user_input',
        request_id: 42,
        questions: [{ id: 'goal', question: '你希望我接下来问你哪些问题？' }],
      },
    }
    const answeredBlock: ProcessingBlock = {
      id: 'request-answered',
      subtaskId: 10,
      type: 'tool',
      toolName: 'request_user_input',
      status: 'done',
      createdAt: 1770000000001,
      renderPayload: {
        kind: 'request_user_input',
        request_id: 43,
        questions: [{ id: 'goal', question: '这次计划优先解决哪个问题？' }],
        response: {
          requestId: 43,
          answers: {
            goal: { answers: ['任务启动更顺'] },
          },
        },
      },
    }

    render(
      <ToolBlocksDisplay
        blocks={[pendingBlock, answeredBlock]}
        isStreaming={true}
        hideRequestUserInputBlocks
      />
    )

    expect(screen.queryByTestId('request-user-input-card')).not.toBeInTheDocument()
    expect(screen.getByTestId('request-user-input-summary')).toHaveTextContent('任务启动更顺')
  })

  test.each(['pending', 'expired'] as const)(
    'keeps an expired %s interaction visible while a new pending card is in the composer',
    status => {
      const expiredBlock: ProcessingBlock = {
        id: 'request-expired',
        subtaskId: 9,
        type: 'tool',
        toolName: 'request_user_input',
        status: 'done',
        createdAt: Date.now() - 1000,
        renderPayload: {
          kind: 'request_user_input',
          requestId: 0,
          interactionScope: 'old-turn',
          interactionStatus: status,
          expiresAtUnixMs: Date.now() - 1,
          questions: [{ id: 'decision', question: '是否发布？' }],
        },
      }
      render(
        <ToolBlocksDisplay blocks={[expiredBlock]} isStreaming={true} hideRequestUserInputBlocks />
      )
      expect(screen.getByTestId('request-user-input-expired')).toHaveTextContent('请求已超时')
      expect(screen.queryByTestId('request-user-input-card')).not.toBeInTheDocument()
    }
  )

  test('can hide pending request user input blocks by request id', () => {
    const block: ProcessingBlock = {
      id: 'request-1',
      subtaskId: 9,
      type: 'tool',
      toolName: 'request_user_input',
      status: 'pending',
      createdAt: 1770000000000,
      renderPayload: {
        kind: 'request_user_input',
        request_id: 42,
        questions: [
          {
            id: 'goal',
            question: '你希望我接下来问你哪些问题？',
            options: [{ label: '工作目标', description: '聚焦具体事情。' }],
          },
        ],
      },
    }

    render(
      <ToolBlocksDisplay
        blocks={[block]}
        isStreaming={true}
        hiddenRequestUserInputIds={new Set(['request:42'])}
      />
    )

    expect(screen.queryByTestId('request-user-input-card')).not.toBeInTheDocument()
  })
})
