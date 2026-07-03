import '@/i18n'

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ToolBlocksDisplay } from './ToolBlocksDisplay'
import type { ProcessingBlock } from '@/types/workbench'

const completedCommandBlock: ProcessingBlock = {
  id: 'call-1',
  turnId: 1,
  type: 'tool',
  toolName: 'bash',
  toolInput: { command: 'pwd' },
  toolOutput: '/workspace/project\n',
  status: 'done',
  createdAt: 1770000000000,
}

const completedWebSearchBlocks: ProcessingBlock[] = [
  {
    id: 'web-search-1',
    turnId: 1,
    type: 'tool',
    toolName: 'web_search',
    toolInput: {
      type: 'search',
      query: 'Beijing weather today June 17 2026 temperature rain',
      queries: [
        'Beijing weather today June 17 2026 temperature rain',
        'Beijing China current weather forecast today AccuWeather',
      ],
    },
    status: 'done',
    createdAt: 1770000000000,
  },
  {
    id: 'web-search-2',
    turnId: 1,
    type: 'tool',
    toolName: 'web_search',
    toolInput: {
      type: 'search',
      query: 'site:weather.com weather today Beijing China',
    },
    status: 'done',
    createdAt: 1770000001000,
  },
  {
    id: 'web-open-1',
    turnId: 1,
    type: 'tool',
    toolName: 'web_search',
    toolInput: {
      type: 'open_page',
      url: 'https://www.weather.com/weather/today/l/Beijing+China',
    },
    status: 'done',
    createdAt: 1770000002000,
  },
]

const completedFileChangesBlock: ProcessingBlock = {
  id: 'file-changes-1',
  turnId: 1,
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

const completedGuidanceBlock: ProcessingBlock = {
  id: 'guidance-1',
  subtaskId: 1,
  type: 'tool',
  toolName: 'conversation_guidance',
  toolInput: { message: '继续分析 package.json' },
  status: 'done',
  createdAt: 1770000004000,
}

const completedContextCompactionBlock: ProcessingBlock = {
  id: 'ctx-1',
  subtaskId: 1,
  type: 'tool',
  toolName: 'context_compaction',
  status: 'done',
  createdAt: 1770000004500,
}

describe('ToolBlocksDisplay', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('groups completed tools into an activity summary', () => {
    render(<ToolBlocksDisplay blocks={[completedCommandBlock]} isStreaming={false} />)

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))

    expect(screen.getByText('已运行 1 条命令')).toBeInTheDocument()
    expect(screen.queryByText('已运行 pwd')).not.toBeInTheDocument()
  })

  test('renders completed conversation guidance as a static activity label', () => {
    render(<ToolBlocksDisplay blocks={[completedGuidanceBlock]} isStreaming={false} />)

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))

    expect(screen.getByTestId('processing-activity-group-label')).toHaveTextContent('已引导对话')
    expect(screen.queryByRole('button', { name: '已引导对话' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('processing-activity-group-content')).not.toBeInTheDocument()
  })

  test('renders context compaction as an independent divider while preserving tool groups', () => {
    const completedSearchBlock: ProcessingBlock = {
      id: 'search-1',
      subtaskId: 1,
      type: 'tool',
      toolName: 'bash',
      toolInput: { command: "/bin/zsh -lc 'rg -n context .'" },
      status: 'done',
      createdAt: 1770000005000,
    }

    render(
      <ToolBlocksDisplay
        blocks={[completedCommandBlock, completedContextCompactionBlock, completedSearchBlock]}
        isStreaming={false}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))

    expect(screen.getByTestId('context-compaction-indicator')).toHaveTextContent('上下文已自动压缩')
    const activityToggles = screen.getAllByTestId('processing-activity-group-toggle')
    expect(activityToggles).toHaveLength(2)
    expect(activityToggles[0]).toHaveTextContent('已运行 1 条命令')
    expect(activityToggles[1]).toHaveTextContent('已搜索代码')
  })

  test('renders running context compaction status without the generic thinking placeholder', () => {
    render(
      <ToolBlocksDisplay
        blocks={[{ ...completedContextCompactionBlock, status: 'streaming' }]}
        isStreaming={true}
      />
    )

    expect(screen.getByTestId('context-compaction-indicator')).toHaveTextContent(
      '正在自动压缩上下文'
    )
    expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument()
  })

  test('renders completed web search tools as a Codex-style web search activity', () => {
    render(<ToolBlocksDisplay blocks={completedWebSearchBlocks} isStreaming={false} />)

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))

    expect(screen.getByText('已搜索网页')).toBeInTheDocument()
    expect(screen.queryByText('已运行 web_search')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '已搜索网页' }))

    expect(screen.getByTestId('web-search-activity-results')).toHaveTextContent(
      'Beijing weather today June 17 2026 temperature rain'
    )
    expect(screen.getByTestId('web-search-activity-results')).toHaveTextContent(
      'https://www.weather.com/weather/today/l/Beijing+China'
    )
    expect(screen.getByTestId('web-search-activity-results')).toHaveTextContent(
      'weather today Beijing China | weather.com'
    )
    expect(
      screen.queryByText('Beijing China current weather forecast today AccuWeather')
    ).toBeNull()
    expect(screen.getAllByText('Beijing weather today June 17 2026 temperature rain')).toHaveLength(
      1
    )
    expect(screen.getByTestId('web-search-activity-results').parentElement).not.toHaveClass(
      'border-l'
    )
    expect(screen.getAllByTestId('web-search-source-icon').length).toBeGreaterThanOrEqual(2)
  })

  test('renders read file activity details as file rows instead of shell commands', () => {
    render(
      <ToolBlocksDisplay
        blocks={[
          {
            id: 'read-command-1',
            turnId: 1,
            type: 'tool',
            toolName: 'bash',
            toolInput: {
              command: 'nl -ba wework/src/components/chat/blocks/toolBlockActivity.ts',
            },
            status: 'done',
            createdAt: 1770000000000,
          },
          {
            id: 'read-command-2',
            turnId: 1,
            type: 'tool',
            toolName: 'bash',
            toolInput: {
              command:
                '/bin/zsh -lc "sed -n \'1,120p\' wework/src/components/chat/blocks/toolBlockKinds.ts"',
            },
            status: 'done',
            createdAt: 1770000000001,
          },
        ]}
        isStreaming={false}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))
    fireEvent.click(screen.getByRole('button', { name: /已读取 2 个文件/ }))

    expect(screen.getByText('Read toolBlockActivity.ts')).toBeInTheDocument()
    expect(screen.getByText('Read toolBlockKinds.ts')).toBeInTheDocument()
    expect(screen.queryByText(/已运行 nl -ba/)).not.toBeInTheDocument()
  })

  test('renders code search activity details as search summaries instead of shell commands', () => {
    render(
      <ToolBlocksDisplay
        blocks={[
          {
            id: 'rg-command-1',
            turnId: 1,
            type: 'tool',
            toolName: 'bash',
            toolInput: {
              command:
                '/bin/zsh -lc "rg -n \'ToolBlockItem|toolBlock|file_changes|renderPayload|read.*file|command\'"',
              workdir: '/Users/crystal/dev/git/Wegent/wework/src/components/chat/blocks',
            },
            status: 'done',
            createdAt: 1770000000000,
          },
          {
            id: 'rg-command-2',
            turnId: 1,
            type: 'tool',
            toolName: 'bash',
            toolInput: {
              command: "rg -n '已编辑|edited|edited_file|edit.*file' wework",
            },
            status: 'done',
            createdAt: 1770000000001,
          },
          {
            id: 'git-command-1',
            turnId: 1,
            type: 'tool',
            toolName: 'bash',
            toolInput: {
              command: 'git diff --name-only',
            },
            status: 'done',
            createdAt: 1770000000002,
          },
        ]}
        isStreaming={false}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))

    const activityToggle = screen.getByRole('button', {
      name: /已搜索代码 已运行 1 条命令/,
    })
    expect(screen.getByTestId('processing-activity-search-icon')).toBeInTheDocument()

    fireEvent.click(activityToggle)

    expect(screen.getByText('已运行 git diff --name-only')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Searched for ToolBlockItem|toolBlock|file_changes|renderPayload|read.*file|command in blocks'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText('Searched for 已编辑|edited|edited_file|edit.*file in wework')
    ).toBeInTheDocument()
    expect(screen.queryByText(/已运行 rg -n/)).not.toBeInTheDocument()
  })

  test('renders mixed code search and read file activity with specialized rows', () => {
    render(
      <ToolBlocksDisplay
        blocks={[
          {
            id: 'rg-command-1',
            turnId: 1,
            type: 'tool',
            toolName: 'bash',
            toolInput: {
              command: 'rg -n "toolBlock" wework/src/components/chat/blocks',
            },
            status: 'done',
            createdAt: 1770000000000,
          },
          {
            id: 'read-command-1',
            turnId: 1,
            type: 'tool',
            toolName: 'bash',
            toolInput: {
              command: "sed -n '1,220p' wework/src/components/chat/blocks/toolBlockActivity.ts",
            },
            status: 'done',
            createdAt: 1770000000001,
          },
        ]}
        isStreaming={false}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))
    fireEvent.click(screen.getByRole('button', { name: /已读取 1 个文件 已搜索代码/ }))

    const activityContent = screen.getByTestId('processing-activity-group-content')
      .firstElementChild?.firstElementChild as HTMLElement
    expect(activityContent).toHaveClass('mt-1.5', 'gap-1.5')
    expect(activityContent).not.toHaveClass('border-l', 'pl-4', 'gap-3')
    expect(screen.getByText('Searched for toolBlock in blocks')).toBeInTheDocument()
    expect(screen.getByText('Read toolBlockActivity.ts')).toBeInTheDocument()
    expect(screen.queryByText(/已运行 sed -n/)).not.toBeInTheDocument()
  })

  test('hides internal stdin polling tools from completed activity', () => {
    render(
      <ToolBlocksDisplay
        blocks={[
          completedGuidanceBlock,
          {
            id: 'stdin-1',
            turnId: 1,
            type: 'tool',
            toolName: 'write_stdin',
            toolInput: { session_id: 90870, chars: '' },
            status: 'done',
            createdAt: 1770000000001,
          },
        ]}
        isStreaming={false}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))

    expect(screen.getByTestId('processing-activity-group-label')).toHaveTextContent('已引导对话')
    expect(screen.queryByRole('button', { name: /已执行 1 个工具/ })).not.toBeInTheDocument()
    expect(screen.queryByText('已执行')).not.toBeInTheDocument()
  })

  test('renders file changes inside completed processing details', () => {
    render(<ToolBlocksDisplay blocks={[completedFileChangesBlock]} isStreaming={false} />)

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))

    expect(screen.getByTestId('process-file-changes-block')).toHaveTextContent('已编辑 1 个文件')
    expect(screen.queryByText('已编辑 env')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /已编辑 1 个文件/ }))

    expect(screen.getByText('已编辑 env')).toBeInTheDocument()
    expect(screen.getByText('+2')).toBeInTheDocument()
    expect(screen.getByText('-1')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /已编辑 env/ }))

    expect(screen.getByTestId('process-file-change-diff')).toHaveTextContent('OLD_ENV=remote')
    expect(screen.getByTestId('process-file-change-diff')).toHaveTextContent(
      'BACKEND_URL=127.0.0.1'
    )
  })

  test('uses an edit icon for completed edit activity groups', () => {
    render(
      <ToolBlocksDisplay
        blocks={[
          {
            id: 'patch-1',
            turnId: 1,
            type: 'tool',
            toolName: 'apply_patch',
            toolInput: {
              input: [
                '*** Begin Patch',
                '*** Update File: /workspace/project/executor/src/server/mod.rs',
                '@@',
                '-old',
                '+new',
                '*** End Patch',
              ].join('\n'),
            },
            status: 'done',
            createdAt: 1770000000000,
          },
        ]}
        isStreaming={false}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))

    expect(screen.getByRole('button', { name: /已编辑 1 个文件/ })).toBeInTheDocument()
    expect(screen.getByTestId('processing-activity-edit-icon')).toBeInTheDocument()
  })

  test('hides redundant apply_patch activity when file changes are already rendered', () => {
    render(
      <ToolBlocksDisplay
        blocks={[
          {
            id: 'patch-1',
            turnId: 1,
            type: 'tool',
            toolName: 'apply_patch',
            toolInput: {
              input: [
                '*** Begin Patch',
                '*** Update File: /tmp/project/scripts/env',
                '@@',
                '-OLD_ENV=remote',
                '+BACKEND_URL=127.0.0.1',
                '*** End Patch',
              ].join('\n'),
            },
            status: 'done',
            createdAt: 1770000000000,
          },
          completedFileChangesBlock,
        ]}
        isStreaming={false}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))

    expect(screen.queryByTestId('processing-activity-group-toggle')).not.toBeInTheDocument()
    expect(screen.getByTestId('process-file-changes-block')).toHaveTextContent('已编辑 1 个文件')
  })

  test('only persists the top-level processing expansion state', () => {
    const { unmount } = render(
      <ToolBlocksDisplay
        blocks={[completedFileChangesBlock]}
        isStreaming={false}
        stateKey="file-changes-local-expansion"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))
    fireEvent.click(screen.getByRole('button', { name: /已编辑 1 个文件/ }))
    expect(screen.getByText('已编辑 env')).toBeInTheDocument()

    unmount()
    render(
      <ToolBlocksDisplay
        blocks={[completedFileChangesBlock]}
        isStreaming={false}
        stateKey="file-changes-local-expansion"
      />
    )

    expect(screen.getByTestId('processing-collapse-content')).toHaveAttribute(
      'aria-hidden',
      'false'
    )
    expect(screen.getByTestId('process-file-changes-block')).toHaveTextContent('已编辑 1 个文件')
    expect(screen.queryByText('已编辑 env')).toBeNull()
  })

  test('opens completed processing details with a short content transition', () => {
    render(<ToolBlocksDisplay blocks={[completedCommandBlock]} isStreaming={false} />)

    const toggle = screen.getByRole('button', { name: /已处理/ })
    const collapseContent = screen.getByTestId('processing-collapse-content')
    expect(toggle).toHaveClass('inline-flex')
    expect(toggle).not.toHaveClass('w-full')
    expect(collapseContent).toHaveAttribute('aria-hidden', 'true')
    expect(collapseContent).toHaveClass(
      'transition-[max-height,opacity]',
      'duration-[260ms]',
      'opacity-0',
      'pointer-events-none'
    )
    expect(collapseContent).toHaveStyle({ maxHeight: '0px' })
    expect(toggle.querySelector('svg')).toHaveClass('-rotate-90')

    fireEvent.click(toggle.parentElement as HTMLElement)
    expect(collapseContent).toHaveAttribute('aria-hidden', 'true')

    fireEvent.click(toggle)

    expect(collapseContent).toHaveAttribute('aria-hidden', 'false')
    expect(collapseContent).toHaveClass('opacity-100')
    expect(toggle.querySelector('svg')).not.toHaveClass('-rotate-90')
  })

  test('keeps live duration when the run finishes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-05T00:00:00.000Z'))

    const runningBlock: ProcessingBlock = {
      ...completedCommandBlock,
      status: 'streaming',
      createdAt: Date.now(),
    }
    const { rerender } = render(<ToolBlocksDisplay blocks={[runningBlock]} isStreaming={true} />)

    act(() => {
      vi.advanceTimersByTime(3000)
    })

    rerender(
      <ToolBlocksDisplay blocks={[{ ...runningBlock, status: 'done' }]} isStreaming={false} />
    )

    act(() => {
      vi.advanceTimersByTime(0)
    })

    expect(screen.getByRole('button', { name: /已处理 3 秒/ })).toBeInTheDocument()
  })

  test('uses restored block timestamps for completed historical duration', () => {
    const turnStart = new Date('2026-06-05T00:00:00.000Z').getTime()
    const completedHistoricalBlock: ProcessingBlock = {
      ...completedCommandBlock,
      createdAt: turnStart + 368000,
    }

    render(
      <ToolBlocksDisplay
        blocks={[completedHistoricalBlock]}
        isStreaming={false}
        startedAt={turnStart}
      />
    )

    expect(screen.getByRole('button', { name: /已处理 6 分 8 秒/ })).toBeInTheDocument()
  })

  test('formats live duration with natural Chinese units', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-05T00:00:00.000Z'))

    const runningBlock: ProcessingBlock = {
      ...completedCommandBlock,
      status: 'streaming',
      createdAt: Date.now(),
    }

    render(<ToolBlocksDisplay blocks={[runningBlock]} isStreaming={true} />)

    act(() => {
      vi.advanceTimersByTime(62000)
    })

    expect(screen.getByText(/已处理 1 分 2 秒/)).toBeInTheDocument()
  })

  test('keeps ticking while streaming even when all tool blocks are done', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-05T00:00:00.000Z'))

    // All blocks are done but the model is still streaming (pure thinking
    // phase with no new tool output). The timer must keep advancing.
    const doneBlock: ProcessingBlock = {
      ...completedCommandBlock,
      status: 'done',
      createdAt: Date.now(),
    }

    render(<ToolBlocksDisplay blocks={[doneBlock]} isStreaming={true} />)

    act(() => {
      vi.advanceTimersByTime(5000)
    })

    expect(screen.getByText('已处理 5 秒')).toBeInTheDocument()
  })

  test('keeps running process visible with inner tool details collapsed', () => {
    render(<ToolBlocksDisplay blocks={[completedCommandBlock]} isStreaming={true} />)

    const collapseContent = screen.getByTestId('processing-collapse-content')
    expect(collapseContent).toHaveAttribute('aria-hidden', 'false')
    expect(screen.queryByRole('button', { name: /已处理/ })).not.toBeInTheDocument()
    expect(screen.getByText('已运行 1 条命令')).toBeInTheDocument()
    expect(screen.queryByText('已运行 pwd')).not.toBeInTheDocument()
    expect(screen.queryByText('/workspace/project')).not.toBeInTheDocument()
  })

  test('leaves generic thinking placeholders to the message list', () => {
    render(<ToolBlocksDisplay blocks={[completedCommandBlock]} isStreaming={true} />)

    expect(screen.getByTestId('processing-collapse-content')).toHaveAttribute(
      'aria-hidden',
      'false'
    )
    expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument()
  })

  test('collapses streaming processing once final content is visible', () => {
    render(
      <ToolBlocksDisplay
        blocks={[completedCommandBlock]}
        isStreaming={true}
        hasFinalContent={true}
      />
    )

    const toggle = screen.getByRole('button', { name: /已处理/ })
    const collapseContent = screen.getByTestId('processing-collapse-content')

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(collapseContent).toHaveAttribute('aria-hidden', 'true')

    fireEvent.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(collapseContent).toHaveAttribute('aria-hidden', 'false')
    expect(screen.getByText('已运行 1 条命令')).toBeInTheDocument()
  })

  test('groups completed tools while keeping the current running command visible', () => {
    const completedSearchBlock: ProcessingBlock = {
      id: 'search-1',
      subtaskId: 1,
      type: 'tool',
      toolName: 'bash',
      toolInput: { command: "/bin/zsh -lc 'rg -n paas-context .'" },
      status: 'done',
      createdAt: 1770000001000,
    }
    const runningBlock: ProcessingBlock = {
      id: 'running-1',
      subtaskId: 1,
      type: 'tool',
      toolName: 'bash',
      toolInput: { command: 'bin/paas-context --help' },
      status: 'streaming',
      createdAt: 1770000002000,
    }

    render(
      <ToolBlocksDisplay
        blocks={[completedCommandBlock, completedSearchBlock, runningBlock]}
        isStreaming={true}
      />
    )

    const activityToggle = screen.getByRole('button', {
      name: /已搜索代码 已运行 1 条命令/,
    })

    expect(activityToggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/已运行 \/bin\/zsh/)).not.toBeInTheDocument()
    expect(screen.getByText('正在运行 bin/paas-context --help')).toBeInTheDocument()
    expect(screen.queryByText('/workspace/project')).not.toBeInTheDocument()
  })

  test('anchors the running duration to the turn start, surviving a refresh', () => {
    vi.useFakeTimers()
    // The page was refreshed 10s into a still-running turn.
    vi.setSystemTime(new Date('2026-06-05T00:00:10.000Z'))

    // After a refresh the in-progress blocks are re-streamed with fresh client
    // timestamps (createdAt === now), so anchoring to the first block would
    // restart the timer. The turn actually started 10s ago.
    const restreamedBlock: ProcessingBlock = {
      ...completedCommandBlock,
      status: 'streaming',
      createdAt: Date.now(),
    }
    const turnStart = new Date('2026-06-05T00:00:00.000Z').getTime()

    render(
      <ToolBlocksDisplay blocks={[restreamedBlock]} isStreaming={true} startedAt={turnStart} />
    )

    act(() => {
      vi.advanceTimersByTime(0)
    })

    expect(screen.getByText('已处理 10 秒')).toBeInTheDocument()
  })

  test('renders the running header as plain text', () => {
    const runningBlock: ProcessingBlock = {
      ...completedCommandBlock,
      status: 'streaming',
    }

    render(<ToolBlocksDisplay blocks={[runningBlock]} isStreaming={true} />)

    expect(screen.queryByRole('button', { name: /已处理 .* 秒/ })).not.toBeInTheDocument()
    expect(screen.getByText(/已处理 .* 秒/)).toBeInTheDocument()
  })

  test('does not duplicate the generic thinking indicator when live thinking is visible', () => {
    const thinkingBlock: ProcessingBlock = {
      id: 'thinking-1',
      turnId: 1,
      type: 'thinking',
      content: 'Reading files',
      status: 'streaming',
      createdAt: 1770000000000,
    }

    render(<ToolBlocksDisplay blocks={[thinkingBlock]} isStreaming={true} />)

    expect(screen.getByTestId('thinking-live-preview')).toBeInTheDocument()
    expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument()
  })

  test('does not duplicate the generic thinking indicator when live process text is visible', () => {
    const textBlock: ProcessingBlock = {
      id: 'text-1',
      turnId: 1,
      type: 'text',
      content: 'Let me explore the repository structure.',
      status: 'streaming',
      createdAt: 1770000000000,
    }

    render(<ToolBlocksDisplay blocks={[textBlock]} isStreaming={true} />)

    expect(screen.getByTestId('process-text-block')).toBeInTheDocument()
    expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument()
  })

  test('renders request user input blocks as interactive cards', () => {
    const onSubmit = vi.fn()
    const block: ProcessingBlock = {
      id: 'request-1',
      turnId: 9,
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
      <ToolBlocksDisplay blocks={[block]} isStreaming={true} onRequestUserInputSubmit={onSubmit} />
    )

    expect(screen.getByTestId('request-user-input-card')).toHaveTextContent(
      '你希望我接下来问你哪些问题？'
    )
    fireEvent.click(screen.getByTestId('request-user-input-submit-button'))

    expect(onSubmit).toHaveBeenCalledWith({
      requestId: 42,
      itemId: undefined,
      answers: {
        goal: { answers: ['工作目标'] },
      },
    })
  })

  test('can hide request user input blocks when the composer owns them', () => {
    const block: ProcessingBlock = {
      id: 'request-1',
      turnId: 9,
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

    render(<ToolBlocksDisplay blocks={[block]} isStreaming={true} hideRequestUserInputBlocks />)

    expect(screen.queryByTestId('request-user-input-card')).not.toBeInTheDocument()
  })

  test('shows answered request user input blocks as summaries while hiding pending blocks', () => {
    const pendingBlock: ProcessingBlock = {
      id: 'request-pending',
      turnId: 9,
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
      turnId: 10,
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

  test('can hide pending request user input blocks by request id', () => {
    const block: ProcessingBlock = {
      id: 'request-1',
      turnId: 9,
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
