import '@/i18n'

import type { ProcessingBlock } from '@/types/workbench'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ToolBlockItem } from './ToolBlockItem'

const runtimeMock = vi.hoisted(() => ({
  electron: false,
}))
const desktopHostMock = vi.hoisted(() => ({
  invokeDesktopHost: vi.fn(),
}))

vi.mock('@/lib/runtime-environment', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/runtime-environment')>()),
  isElectronRuntime: () => runtimeMock.electron,
}))
vi.mock('@/api/dsh/desktopHost', () => desktopHostMock)

const originalCreateObjectUrl = URL.createObjectURL

const streamingTextBlock: ProcessingBlock = {
  id: 'text-1',
  subtaskId: 1,
  type: 'text',
  content: 'Let me explore the repository structure.',
  status: 'streaming',
  createdAt: 1770000000001,
}

describe('ToolBlockItem', () => {
  afterEach(() => {
    runtimeMock.electron = false
    desktopHostMock.invokeDesktopHost.mockReset()
    URL.createObjectURL = originalCreateObjectUrl
    vi.restoreAllMocks()
  })

  test('uses muted text with inherited UI weight for the completed tool summary', () => {
    render(
      <ToolBlockItem
        block={{
          id: 'tool-duration',
          subtaskId: 1,
          type: 'tool',
          toolName: 'bash',
          status: 'done',
          createdAt: 1770000000000,
          completedAt: 1770000003333,
        }}
      />
    )

    const duration = screen.getByTestId('tool-block-duration')
    expect(duration).toHaveTextContent('3.3s')
    expect(duration.parentElement).toHaveClass('text-text-muted')
    expect(duration.parentElement!.parentElement).not.toHaveClass('font-normal')
  })

  test('hides the shell launcher from expanded command details', async () => {
    const user = userEvent.setup()

    render(
      <ToolBlockItem
        block={{
          id: 'shell-command-detail',
          subtaskId: 1,
          type: 'tool',
          toolName: 'exec_command',
          toolInput: {
            cmd: "/opt/homebrew/bin/zsh -lc 'node wework/e2e/desktop/run-checkpoints.mjs --segment offline-local-project-space'",
            cwd: '/Users/axb-mac/.wework/workspace/worktrees/runtime-782010714/Wegent',
          },
          status: 'done',
          createdAt: 1770000000000,
        }}
      />
    )

    await user.click(screen.getByRole('button', { name: /展开工具详情/ }))

    expect(
      screen.getByText(
        'node wework/e2e/desktop/run-checkpoints.mjs --segment offline-local-project-space'
      )
    ).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('/opt/homebrew/bin/zsh')
  })

  test('keeps the latest shell output lines in terminal-style scrollback', async () => {
    const user = userEvent.setup()
    const toolOutput = Array.from({ length: 201 }, (_, index) => `line ${index}`).join('\n')
    const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(400)

    render(
      <ToolBlockItem
        block={{
          id: 'cmd-scrollback',
          subtaskId: 1,
          type: 'tool',
          toolName: 'exec_command',
          toolInput: { cmd: 'long-running-command' },
          toolOutput,
          status: 'done',
          createdAt: 1770000000002,
        }}
      />
    )

    await user.click(screen.getByRole('button', { name: /展开工具详情/ }))

    const outputElement = screen.getByTestId('shell-tool-output')
    const renderedOutput = outputElement.textContent
    expect(renderedOutput).not.toContain('line 0\n')
    expect(renderedOutput).toContain('line 1\n')
    expect(renderedOutput).toContain('line 200')
    expect(outputElement.scrollTop).toBe(400)
    scrollHeight.mockRestore()
  })

  test('opens streaming process text file links with line numbers in the workspace', () => {
    const onOpenWorkspaceFile = vi.fn()

    render(
      <ToolBlockItem
        block={{
          ...streamingTextBlock,
          content:
            '[workbenchPaneStack.test.tsx](/Users/dev/Wegent/wework/src/components/layout/workbenchPaneStack.test.tsx:184)',
        }}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />
    )

    expect(
      screen.queryByRole('link', { name: /workbenchPaneStack\.test\.tsx/ })
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('assistant-markdown-link-line')).toHaveTextContent('(line 184)')

    fireEvent.click(screen.getByTestId('assistant-markdown-link'))

    expect(onOpenWorkspaceFile).toHaveBeenCalledWith(
      '/Users/dev/Wegent/wework/src/components/layout/workbenchPaneStack.test.tsx',
      { lineStart: 184, lineEnd: undefined }
    )
  })
})
