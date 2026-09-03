import '@/i18n'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ToolBlockItem } from './ToolBlockItem'
import type { ProcessingBlock } from '@/types/workbench'

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

  test('renders a completed tool duration with 0.1 second precision', () => {
    render(
      <ToolBlockItem
        block={{
          id: 'tool-duration',
          subtaskId: 1,
          type: 'tool',
          toolName: 'bash',
          toolInput: { command: 'sleep 3' },
          status: 'done',
          createdAt: 1770000000000,
          completedAt: 1770000003278,
        }}
      />
    )

    expect(screen.getByText('3.3s')).toBeInTheDocument()
  })

  test('uses the standard tool row height for file changes', () => {
    render(
      <ToolBlockItem
        block={{
          id: 'file-change-height',
          subtaskId: 1,
          type: 'file_changes',
          status: 'done',
          createdAt: 1770000000000,
          fileChanges: {
            version: 1,
            status: 'completed',
            artifact_id: 'artifact-1',
            device_id: 'device-1',
            workspace_path: '/workspace',
            file_count: 1,
            additions: 1,
            deletions: 0,
            files: [
              {
                path: 'src/example.ts',
                change_type: 'modified',
                additions: 1,
                deletions: 0,
                binary: false,
              },
            ],
          },
        }}
      />
    )

    expect(screen.getByRole('button')).toHaveClass('min-h-8')
  })

  test('renders streaming process text directly in the timeline', () => {
    render(<ToolBlockItem block={streamingTextBlock} />)

    const block = screen.getByTestId('process-text-block')

    expect(block).toHaveAccessibleName('正在处理')
    expect(block).toHaveTextContent('Let me explore the repository structure.')
    expect(block).toHaveClass('text-text-primary')
    expect(block).not.toHaveClass('text-text-secondary')
    expect(block.querySelector('svg')).not.toBeInTheDocument()
    expect(screen.queryByTestId('process-text-toggle-button')).not.toBeInTheDocument()
  })

  test('renders completed process text without folding it', () => {
    render(<ToolBlockItem block={{ ...streamingTextBlock, status: 'done' }} />)

    expect(screen.queryByTestId('process-text-toggle-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('process-text-block')).toHaveTextContent(
      'Let me explore the repository structure.'
    )
  })

  test('renders web search tools without raw JSON details', async () => {
    const user = userEvent.setup()

    render(
      <ToolBlockItem
        block={{
          id: 'web-search-1',
          subtaskId: 1,
          type: 'tool',
          toolName: 'web_search',
          toolInput: {
            type: 'search',
            query: 'Beijing weather today June 17 2026 temperature rain',
          },
          status: 'done',
          createdAt: 1770000000002,
        }}
      />
    )

    expect(screen.getByText('搜索网页')).toBeInTheDocument()
    expect(screen.queryByText('运行 web_search')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /展开工具详情/ }))

    expect(screen.getByTestId('web-search-block-detail')).toHaveTextContent(
      'Beijing weather today June 17 2026 temperature rain'
    )
    expect(screen.queryByText(/"query"/)).not.toBeInTheDocument()
  })

  test('renders shell command working directory in expanded details', async () => {
    const user = userEvent.setup()

    render(
      <ToolBlockItem
        block={{
          id: 'cmd-1',
          subtaskId: 1,
          type: 'tool',
          toolName: 'exec_command',
          toolInput: {
            cmd: 'pwd',
            cwd: '/Users/crystal/project',
          },
          toolOutput: '/Users/crystal/project\n',
          status: 'done',
          createdAt: 1770000000002,
        }}
      />
    )

    await user.click(screen.getByRole('button', { name: /展开工具详情/ }))

    expect(screen.getByText('cwd: /Users/crystal/project')).toBeInTheDocument()
  })

  test('renders terminal control sequences as stable plain shell output', async () => {
    const user = userEvent.setup()

    render(
      <ToolBlockItem
        block={{
          id: 'cmd-ansi',
          subtaskId: 1,
          type: 'tool',
          toolName: 'exec_command',
          toolInput: { cmd: 'npm install' },
          toolOutput:
            '\u001b[1G\u001b[0K⠙\u001b[1G\u001b[0K⠹\u001b[1G\u001b[0Kadded 703 packages\n\u001b[32msuccess\u001b[0m',
          status: 'done',
          createdAt: 1770000000002,
        }}
      />
    )

    await user.click(screen.getByRole('button', { name: /展开工具详情/ }))

    expect(screen.getByText(/added 703 packages/)).toHaveTextContent('added 703 packages success')
    expect(screen.queryByText(/⠙|⠹/)).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('\u001b')
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

  test('renders unknown tool with generic input and output details', async () => {
    const user = userEvent.setup()

    render(
      <ToolBlockItem
        block={{
          id: 'tool-unknown',
          subtaskId: 1,
          type: 'tool',
          toolName: 'custom_agent_tool',
          toolInput: {
            action: 'inspect',
            payload: 'raw details should stay hidden',
          },
          toolOutput: {
            status: 'ok',
          },
          status: 'done',
          createdAt: 1770000000002,
        }}
      />
    )

    expect(screen.getByText('调用 custom agent tool')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /展开工具详情/ }))

    expect(screen.getByTestId('generic-tool-block-detail')).toHaveTextContent('custom_agent_tool')
    expect(screen.getByTestId('generic-tool-input')).toHaveTextContent(
      'raw details should stay hidden'
    )
    expect(screen.getByTestId('generic-tool-output')).toHaveTextContent('"status": "ok"')
  })

  test('renders node_repl js as JavaScript command activity with details', async () => {
    const user = userEvent.setup()

    render(
      <ToolBlockItem
        block={{
          id: 'node-repl-js',
          subtaskId: 1,
          type: 'tool',
          toolName: 'node_repl.js',
          toolInput: {
            code: "nodeRepl.write('hello')",
          },
          toolOutput: 'hello',
          status: 'done',
          createdAt: 1770000000002,
        }}
      />
    )

    expect(screen.getByText('运行 JavaScript')).toBeInTheDocument()
    expect(screen.queryByText('调用 js')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /展开工具详情/ }))

    expect(screen.getByTestId('generic-tool-block-detail')).toHaveTextContent('node_repl.js')
    expect(screen.getByTestId('generic-tool-input')).toHaveTextContent("nodeRepl.write('hello')")
    expect(screen.getByTestId('generic-tool-output')).toHaveTextContent('hello')
  })

  test('expands view_image tool details with an image preview', async () => {
    const user = userEvent.setup()
    const imageUrl = 'data:image/png;base64,aW1hZ2U='

    render(
      <ToolBlockItem
        block={{
          id: 'view-image-1',
          subtaskId: 1,
          type: 'tool',
          toolName: 'functions.view_image',
          toolInput: { path: '/tmp/screenshot.png' },
          toolOutput: { image_url: imageUrl, detail: 'high' },
          status: 'done',
          createdAt: 1770000000002,
        }}
      />
    )

    expect(screen.getByText('查看 screenshot.png')).toBeInTheDocument()
    expect(screen.queryByTestId('image-view-preview')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /展开工具详情/ }))

    expect(screen.getByTestId('image-view-preview')).toHaveAttribute('src', imageUrl)
    expect(screen.getByTestId('image-view-preview')).toHaveAttribute('alt', '工具查看的图片')
  })

  test('expands an Electron local view_image result through the declared file capability', async () => {
    runtimeMock.electron = true
    URL.createObjectURL = vi.fn(
      () => 'blob:electron-view-image'
    ) as unknown as typeof URL.createObjectURL
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    desktopHostMock.invokeDesktopHost.mockResolvedValueOnce({
      chunkBase64: Buffer.from('image').toString('base64'),
      bytesRead: 5,
      eof: true,
      size: 5,
    })
    const user = userEvent.setup()

    render(
      <ToolBlockItem
        block={{
          id: 'view-image-electron',
          subtaskId: 1,
          type: 'tool',
          toolName: 'view_image',
          toolInput: { path: '/tmp/electron-screenshot.png' },
          status: 'done',
          createdAt: 1770000000002,
        }}
      />
    )

    await user.click(screen.getByRole('button', { name: /展开工具详情/ }))
    await waitFor(() => {
      expect(screen.getByTestId('image-view-preview')).toHaveAttribute(
        'src',
        'blob:electron-view-image'
      )
    })
    expect(desktopHostMock.invokeDesktopHost).toHaveBeenCalledWith('filesystem.readFileChunk', {
      path: '/tmp/electron-screenshot.png',
      offset: 0,
      length: 512 * 1024,
    })
  })

  test('keeps view_image details expanded after remounting', async () => {
    const user = userEvent.setup()
    const block: ProcessingBlock = {
      id: 'view-image-remount',
      subtaskId: 1,
      type: 'tool',
      toolName: 'view_image',
      toolInput: { path: '/tmp/remount.png' },
      toolOutput: { image_url: 'data:image/png;base64,aW1hZ2U=' },
      status: 'done',
      createdAt: 1770000000002,
    }
    const stateKey = 'view-image-remount-expansion'
    const firstRender = render(<ToolBlockItem block={block} stateKey={stateKey} />)

    await user.click(screen.getByRole('button', { name: /展开工具详情/ }))
    expect(screen.getByTestId('image-view-preview')).toBeInTheDocument()

    firstRender.unmount()
    render(<ToolBlockItem block={block} stateKey={stateKey} />)

    expect(screen.getByRole('button', { name: /收起工具详情/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByTestId('image-view-preview')).toBeInTheDocument()
  })

  test('uses Codex filePath aliases for file tool labels and open actions', async () => {
    const user = userEvent.setup()
    const onOpenWorkspaceFile = vi.fn()

    render(
      <ToolBlockItem
        block={{
          id: 'read-1',
          subtaskId: 1,
          type: 'tool',
          toolName: 'Read',
          toolInput: { filePath: '/Users/crystal/package.json' },
          status: 'done',
          createdAt: 1770000000002,
        }}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />
    )

    await user.click(screen.getByRole('button', { name: /读取 package.json/ }))

    expect(onOpenWorkspaceFile).toHaveBeenCalledWith('/Users/crystal/package.json')
  })

  test('renders Claude MultiEdit blocks as editable file activity', async () => {
    const user = userEvent.setup()

    render(
      <ToolBlockItem
        block={{
          id: 'edit-1',
          subtaskId: 1,
          type: 'tool',
          toolName: 'MultiEdit',
          toolInput: {
            file_path: '/Users/crystal/src/config.ts',
            edits: [
              {
                old_string: 'enabled: false',
                new_string: 'enabled: true',
              },
            ],
          },
          status: 'done',
          createdAt: 1770000000002,
        }}
      />
    )

    expect(screen.getByText('编辑 config.ts')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /展开工具详情/ }))

    expect(screen.getByText('/Users/crystal/src/config.ts')).toBeInTheDocument()
    expect(screen.getByText('enabled: false')).toBeInTheDocument()
    expect(screen.getByText('enabled: true')).toBeInTheDocument()
  })

  test('renders apply_patch blocks with file names parsed from the patch body', async () => {
    const user = userEvent.setup()

    render(
      <ToolBlockItem
        block={{
          id: 'patch-1',
          subtaskId: 1,
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
          createdAt: 1770000000002,
        }}
      />
    )

    expect(screen.getByText('编辑 mod.rs')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /展开工具详情/ }))

    expect(screen.getByText('/workspace/project/executor/src/server/mod.rs')).toBeInTheDocument()
  })

  test('renders unknown edit targets without an awkward file fallback', () => {
    render(
      <ToolBlockItem
        block={{
          id: 'edit-unknown',
          subtaskId: 1,
          type: 'tool',
          toolName: 'apply_patch',
          toolInput: { input: 'invalid patch text' },
          status: 'done',
          createdAt: 1770000000002,
        }}
      />
    )

    expect(screen.getByText('编辑文件')).toBeInTheDocument()
    expect(screen.queryByText('编辑 文件')).not.toBeInTheDocument()
  })

  test('renders process text code blocks with shared syntax highlighting', () => {
    render(
      <ToolBlockItem
        block={{
          ...streamingTextBlock,
          status: 'done',
          content: [
            'Use CSS:',
            '',
            '```css',
            '.collapsible {',
            '  display: grid;',
            '}',
            '```',
          ].join('\n'),
        }}
      />
    )

    expect(screen.getByTestId('markdown-code-block')).toHaveTextContent('.collapsible')
    expect(screen.getByTestId('markdown-code-block-language')).toHaveTextContent('css')
    expect(screen.queryByTestId('markdown-code-wrap-button')).not.toBeInTheDocument()
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

  test('renders markdown code labels as md and toggles line wrapping', async () => {
    const user = userEvent.setup()

    render(
      <ToolBlockItem
        block={{
          ...streamingTextBlock,
          status: 'done',
          content: ['```markdown', 'After creating the PR, check for merge conflicts.', '```'].join(
            '\n'
          ),
        }}
      />
    )

    expect(screen.getByTestId('markdown-code-block-language')).toHaveTextContent('md')

    const wrapButton = screen.getByTestId('markdown-code-wrap-button')
    const scrollContainer = screen.getByTestId('markdown-code-scroll-container')
    const code = screen.getByTestId('markdown-code-block').querySelector('code')

    expect(wrapButton).toHaveAttribute('aria-pressed', 'false')
    expect(wrapButton).toHaveAttribute('aria-label', '开启自动换行')
    expect(wrapButton).toHaveAttribute('title', '开启自动换行')
    expect(screen.getByTestId('markdown-code-wrap-disabled-icon')).toBeInTheDocument()
    expect(scrollContainer).toHaveAttribute('data-wrap', 'false')
    expect(scrollContainer).toHaveClass('overflow-x-auto')
    expect(code).toHaveStyle({
      whiteSpace: 'pre',
      overflowWrap: 'normal',
      wordBreak: 'normal',
    })

    await user.click(wrapButton)

    expect(wrapButton).toHaveAttribute('aria-pressed', 'true')
    expect(wrapButton).toHaveAttribute('aria-label', '禁用自动换行')
    expect(wrapButton).toHaveAttribute('title', '禁用自动换行')
    expect(screen.getByTestId('markdown-code-wrap-enabled-icon')).toBeInTheDocument()
    expect(scrollContainer).toHaveAttribute('data-wrap', 'true')
    expect(scrollContainer).toHaveClass('overflow-x-hidden')
    expect(code).toHaveStyle({
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
      wordBreak: 'break-word',
    })

    await user.unhover(wrapButton)

    expect(wrapButton).toHaveAttribute('aria-pressed', 'true')
    expect(wrapButton).toHaveAttribute('aria-label', '禁用自动换行')
    expect(scrollContainer).toHaveAttribute('data-wrap', 'true')
    expect(code).toHaveStyle({
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
      wordBreak: 'break-word',
    })

    await user.click(wrapButton)

    expect(wrapButton).toHaveAttribute('aria-pressed', 'false')
    expect(wrapButton).toHaveAttribute('aria-label', '开启自动换行')
    expect(scrollContainer).toHaveAttribute('data-wrap', 'false')
    expect(code).toHaveStyle({
      whiteSpace: 'pre',
      overflowWrap: 'normal',
      wordBreak: 'normal',
    })
  })

  test('keeps markdown line wrapping when the code block remounts', async () => {
    const user = userEvent.setup()
    const markdownContent = [
      '```markdown',
      'Persistent markdown wrap state after pointer leaves and the block remounts.',
      '```',
    ].join('\n')

    const { unmount } = render(
      <ToolBlockItem
        block={{
          ...streamingTextBlock,
          status: 'done',
          content: markdownContent,
        }}
      />
    )

    await user.click(screen.getByTestId('markdown-code-wrap-button'))

    expect(screen.getByTestId('markdown-code-scroll-container')).toHaveAttribute(
      'data-wrap',
      'true'
    )

    unmount()

    render(
      <ToolBlockItem
        block={{
          ...streamingTextBlock,
          status: 'done',
          content: markdownContent,
        }}
      />
    )

    expect(screen.getByTestId('markdown-code-wrap-button')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('markdown-code-scroll-container')).toHaveAttribute(
      'data-wrap',
      'true'
    )
  })
})
