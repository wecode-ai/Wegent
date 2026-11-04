// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Workbench } from '@/features/tasks/components/workbench'
import { taskApis, type BranchDiffResponse } from '@/apis/tasks'
import { selectTaskFileChanges } from '@/features/tasks/components/workbench/taskFileChanges'
import type { TaskFileChanges } from '@/types/api'
import type { UnifiedMessage } from '@wegent/chat-core'

jest.mock('@/features/theme/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'light' }),
}))

jest.mock('@/components/common/EnhancedMarkdown', () => ({
  __esModule: true,
  default: ({ source }: { source: string }) => <div>{source}</div>,
}))

jest.mock('@/apis/tasks', () => ({
  taskApis: {
    getBranchDiff: jest.fn(),
  },
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { returnObjects?: boolean }) => {
      if (options?.returnObjects && key === 'tasks:workbench.loading_states') {
        return ['Loading task data...', 'Loading code diff...', 'Analyzing results...']
      }
      if (options?.returnObjects && key === 'tasks:workbench.tips') {
        return ['Workbench tip']
      }

      const translations: Record<string, string> = {
        'tasks:workbench.overview': 'Overview',
        'tasks:workbench.files_changed': 'Files Changed',
        'tasks:workbench.status.completed': 'Completed',
        'tasks:workbench.status.failed': 'Failed',
        'tasks:workbench.status.pending_confirmation': 'Awaiting confirmation',
        'tasks:workbench.status.running': 'Running',
        'tasks:workbench.close_panel': 'Close panel',
        'tasks:workbench.open_main_menu': 'Open main menu',
        'tasks:workbench.no_repository': 'No repository',
        'tasks:workbench.no_file_changes': 'No file changes',
        'tasks:workbench.no_changes_found': 'No changes found',
        'tasks:workbench.loading_diff_message': 'Loading diff',
        'tasks:workbench.task_file_changes': 'Cumulative task file changes',
        'tasks:workbench.file_changes_unavailable': 'No saved file change data',
        'tasks:workbench.snapshot_failed': 'Snapshot failed',
        'tasks:workbench.diff_truncated': 'Partial diff',
        'tasks:workbench.retry': 'Retry',
      }

      return translations[key] || key
    },
  }),
}))

describe('Workbench', () => {
  const props = { isOpen: true, onClose: jest.fn(), onOpen: jest.fn() }
  const filePath = 'nested folder/changed file.txt'
  const changes: TaskFileChanges = {
    status: 'active',
    files: [{ path: filePath, change_type: 'modified', additions: 1, deletions: 1, binary: false }],
    diff: `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n@@ -1 +1 @@\n---before token\n+++after token\n`,
  }
  const branchDiff = (path: string): BranchDiffResponse => ({
    status: 'ahead',
    ahead_by: 1,
    behind_by: 0,
    total_commits: 1,
    diff_url: '',
    html_url: '',
    permalink_url: '',
    files: [
      {
        filename: path,
        status: 'added',
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: '@@ -0,0 +1 @@\n+new file\n',
        previous_filename: '',
        blob_url: '',
        raw_url: '',
        contents_url: '',
      },
    ],
  })

  beforeEach(() => jest.clearAllMocks())

  const runningWorkbenchData = {
    taskTitle: 'Pipeline task',
    taskNumber: '#91',
    status: 'running' as const,
    completedTime: '',
    repository: 'wecode-ai/Wegent',
    branch: 'main',
    sessions: 1,
    premiumRequests: 0,
    lastUpdated: '2026-05-11T10:00:00.000Z',
    summary: '',
    changes: [],
    originalPrompt: '',
    file_changes: [],
    git_info: {
      initial_commit_id: '',
      initial_commit_message: '',
      task_commits: [],
      source_branch: 'main',
      target_branch: '',
    },
  }

  test('shows completed status instead of loading forever when completed task has no workbench data', () => {
    render(
      <Workbench
        isOpen={true}
        onClose={jest.fn()}
        onOpen={jest.fn()}
        isLoading={false}
        taskTitle="Finished task"
        taskNumber="#84"
        taskStatus="COMPLETED"
      />
    )

    expect(screen.getByText('Finished task')).toBeInTheDocument()
    expect(screen.getByText('Completed')).toBeInTheDocument()
    expect(screen.queryByText('Loading task data...')).not.toBeInTheDocument()
  })

  test('shows awaiting confirmation when task status has paused even if workbench data is still running', () => {
    render(
      <Workbench
        isOpen={true}
        onClose={jest.fn()}
        onOpen={jest.fn()}
        isLoading={false}
        workbenchData={runningWorkbenchData}
        taskStatus="PENDING_CONFIRMATION"
      />
    )

    expect(screen.getByText('Pipeline task')).toBeInTheDocument()
    expect(screen.getByText('Awaiting confirmation')).toBeInTheDocument()
    expect(screen.queryByText('Running')).not.toBeInTheDocument()
  })

  test('uses the task repository when workbench metadata is missing', () => {
    render(<Workbench {...props} taskStatus="COMPLETED" repository="owner/repository" />)
    fireEvent.click(screen.getByRole('button', { name: 'Files Changed' }))

    expect(screen.getByTestId('workbench-files')).toHaveTextContent('No saved file change data')
    expect(screen.queryByText('No repository')).not.toBeInTheDocument()
    expect(taskApis.getBranchDiff).not.toHaveBeenCalled()
  })

  test.each(['git_info', 'file_changes'])(
    'handles partial workbench metadata without %s',
    missingField => {
      const workbenchData = { ...runningWorkbenchData }
      Reflect.deleteProperty(workbenchData, missingField)
      render(<Workbench {...props} taskStatus="COMPLETED" workbenchData={workbenchData} />)
      fireEvent.click(screen.getByRole('button', { name: 'Files Changed' }))

      expect(screen.getByTestId('workbench-files')).toHaveTextContent('No changes found')
      expect(taskApis.getBranchDiff).not.toHaveBeenCalled()
    }
  )

  test('renders an inline Git snapshot with complete headers and separate added and deleted lines', () => {
    render(<Workbench {...props} taskStatus="COMPLETED" fileChanges={changes} />)
    fireEvent.click(screen.getByRole('button', { name: /Files Changed/ }))
    fireEvent.click(screen.getByTestId('diff-file-toggle'))

    const diff = screen.getByTestId('diff-file-content')
    expect(diff).toHaveTextContent(`diff --git a/${filePath} b/${filePath}`)
    expect(within(diff).getByText('@@ -1 +1 @@')).toBeInTheDocument()
    expect(within(diff).getByText('--before token')).toBeInTheDocument()
    expect(within(diff).getByText('++after token')).toBeInTheDocument()
    expect(diff.querySelector('[data-diff-line-type="deletion"]')).toHaveTextContent('before token')
    expect(diff.querySelector('[data-diff-line-type="addition"]')).toHaveTextContent('after token')
    expect(diff.querySelectorAll('[data-diff-line-type="addition"]')).toHaveLength(1)
    expect(screen.queryByText('No repository')).not.toBeInTheDocument()
    expect(taskApis.getBranchDiff).not.toHaveBeenCalled()
  })

  test('clears the latest cumulative snapshot across recovered and live message clocks', () => {
    const recoveredAt = Date.UTC(2026, 10, 4, 20, 24, 58)
    const message = (id: number, fileChanges: TaskFileChanges): UnifiedMessage => ({
      id: String(id),
      type: 'ai',
      status: 'completed',
      content: '',
      timestamp: recoveredAt + id,
      messageId: id * 2,
      result: { task_file_changes: fileChanges } as UnifiedMessage['result'],
    })
    const cumulative: TaskFileChanges = {
      ...changes,
      files: [
        ...changes.files,
        { path: 'second.txt', change_type: 'created', additions: 1, deletions: 0, binary: false },
      ],
      diff:
        changes.diff +
        'diff --git a/second.txt b/second.txt\n--- /dev/null\n+++ b/second.txt\n@@ -0,0 +1 @@\n+second file\n',
    }
    const first = message(1, changes)
    const second = message(2, cumulative)
    const readOnly = message(3, { ...cumulative })
    const selected = selectTaskFileChanges([first, second, readOnly])
    expect(selected).toBe(
      (readOnly.result as { task_file_changes: TaskFileChanges }).task_file_changes
    )
    const { rerender } = render(
      <Workbench {...props} taskNumber="#1" taskStatus="COMPLETED" fileChanges={selected} />
    )
    fireEvent.click(screen.getByRole('button', { name: /Files Changed/ }))
    expect(screen.getAllByTestId('diff-file-toggle')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: /second.txt/ }))
    expect(screen.getByTestId('diff-file-content')).toHaveTextContent('second file')

    const restored: TaskFileChanges = { status: 'active', files: [], diff: '' }
    const live = { ...message(4, restored), timestamp: recoveredAt - 8 * 60 * 60 * 1000 + 4 }
    const latest = selectTaskFileChanges([live, first, second, readOnly])
    expect(latest).toBe(restored)
    rerender(<Workbench {...props} taskNumber="#1" taskStatus="COMPLETED" fileChanges={latest} />)
    expect(screen.queryByTestId('diff-file-toggle')).not.toBeInTheDocument()
    expect(screen.getByText('No changes found')).toBeInTheDocument()

    // Changing tasks must not retain the previous task's snapshot or expanded file.
    rerender(
      <Workbench {...props} taskNumber="#2" taskStatus="COMPLETED" repository="other/repo" />
    )
    expect(screen.queryByTestId('diff-file-toggle')).not.toBeInTheDocument()
    expect(screen.queryByText(filePath)).not.toBeInTheDocument()
  })

  test('does not use a per-turn snapshot as a cumulative task diff', () => {
    const message: UnifiedMessage = {
      id: 'turn-only',
      type: 'ai',
      status: 'completed',
      content: '',
      timestamp: 100,
      result: { file_changes: changes } as UnifiedMessage['result'],
    }
    expect(selectTaskFileChanges([message])).toBeNull()
  })

  test('opens a real Git patch for an unquoted path containing the diff prefix separator', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wegent-workbench-diff-'))
    const path = 'dir b/file.txt'
    const git = (args: string[]) =>
      execFileSync('git', args, {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))
          ),
          NODE_ENV: process.env.NODE_ENV,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        },
      })
    try {
      git(['init', '--initial-branch=main'])
      mkdirSync(join(directory, 'dir b'))
      writeFileSync(join(directory, path), 'before real Git\n')
      git(['add', '.'])
      git([
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.test',
        'commit',
        '-m',
        'baseline',
      ])
      writeFileSync(join(directory, path), 'after real Git\n')
      const diff = git(['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', 'HEAD'])
      expect(diff).toContain('diff --git a/dir b/file.txt b/dir b/file.txt')
      const fileChanges: TaskFileChanges = {
        status: 'active',
        diff,
        files: [{ path, change_type: 'modified', additions: 1, deletions: 1, binary: false }],
      }
      render(<Workbench {...props} taskStatus="COMPLETED" fileChanges={fileChanges} />)
      fireEvent.click(screen.getByRole('button', { name: /Files Changed/ }))
      const file = screen.getByRole('button', { name: /dir b\/file.txt/ })
      expect(file).toBeEnabled()
      fireEvent.click(file)
      const content = screen.getByTestId('diff-file-content')
      expect(content.querySelector('[data-diff-line-type="addition"]')).toHaveTextContent(
        'after real Git'
      )
      expect(content.querySelector('[data-diff-line-type="deletion"]')).toHaveTextContent(
        'before real Git'
      )
      expect(taskApis.getBranchDiff).not.toHaveBeenCalled()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('keeps a file expanded when the same snapshot is refreshed and displays changed content', () => {
    const { rerender } = render(
      <Workbench {...props} taskStatus="COMPLETED" fileChanges={changes} />
    )
    fireEvent.click(screen.getByRole('button', { name: /Files Changed/ }))
    fireEvent.click(screen.getByTestId('diff-file-toggle'))
    rerender(<Workbench {...props} taskStatus="COMPLETED" fileChanges={{ ...changes }} />)
    expect(screen.getByTestId('diff-file-content')).toHaveTextContent('after token')

    rerender(
      <Workbench
        {...props}
        taskStatus="COMPLETED"
        fileChanges={{
          ...changes,
          diff: changes.diff.replace('after token', 'updated token'),
        }}
      />
    )
    expect(screen.getByTestId('diff-file-content')).toHaveTextContent('updated token')
    expect(screen.getByTestId('diff-file-content')).not.toHaveTextContent('after token')
  })

  test('orders unnumbered completed snapshots after server turns, then by time', () => {
    const previous: UnifiedMessage = {
      id: 'older',
      type: 'ai',
      status: 'completed',
      content: '',
      timestamp: 400,
      messageId: 316109593140201,
      result: { task_file_changes: changes } as UnifiedMessage['result'],
    }
    const newerChanges = { ...changes, diff: changes.diff.replace('after token', 'newest token') }
    const newer: UnifiedMessage = {
      id: 'newer',
      type: 'ai',
      status: 'completed',
      content: '',
      timestamp: 200,
      result: { task_file_changes: newerChanges } as UnifiedMessage['result'],
    }
    const earlier = { ...newer, id: 'unnumbered-earlier', timestamp: 150, result: previous.result }
    for (const messages of [
      [previous, earlier, newer],
      [previous, newer, earlier],
      [earlier, previous, newer],
      [earlier, newer, previous],
      [newer, previous, earlier],
      [newer, earlier, previous],
    ]) {
      expect(selectTaskFileChanges(messages)).toBe(newerChanges)
    }
    expect(selectTaskFileChanges([{ ...newer, status: 'streaming' }, previous])).toBe(changes)
  })

  test('renders added and deleted files in their corresponding diff sections', () => {
    const fileChanges: TaskFileChanges = {
      status: 'active',
      files: [
        { path: 'new.txt', change_type: 'created', additions: 1, deletions: 0, binary: false },
        { path: 'old.txt', change_type: 'deleted', additions: 0, deletions: 1, binary: false },
      ],
      diff: 'diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+created content\ndiff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-removed content\n',
    }
    render(<Workbench {...props} taskStatus="COMPLETED" fileChanges={fileChanges} />)
    fireEvent.click(screen.getByRole('button', { name: /Files Changed/ }))
    fireEvent.click(screen.getByRole('button', { name: /new.txt/ }))
    fireEvent.click(screen.getByRole('button', { name: /old.txt/ }))
    const [created, removed] = screen.getAllByTestId('diff-file-content')
    expect(created.querySelector('[data-diff-line-type="addition"]')).toHaveTextContent(
      'created content'
    )
    expect(created).not.toHaveTextContent('removed content')
    expect(removed.querySelector('[data-diff-line-type="deletion"]')).toHaveTextContent(
      'removed content'
    )
    expect(removed).not.toHaveTextContent('created content')
  })

  test('distinguishes a capture error from an empty snapshot and marks truncated content', () => {
    const { rerender } = render(
      <Workbench
        {...props}
        taskStatus="COMPLETED"
        fileChanges={{ status: 'error', files: [], diff: '' }}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Files Changed/ }))
    expect(screen.getByRole('alert')).toHaveTextContent('Snapshot failed')
    expect(screen.queryByText('No changes found')).not.toBeInTheDocument()

    rerender(
      <Workbench
        {...props}
        taskStatus="COMPLETED"
        fileChanges={{ ...changes, diff_truncated: true }}
      />
    )
    expect(screen.getByText('Partial diff')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('requests historical branch diffs only in the file tab and ignores an old task response', async () => {
    let finishOld!: (data: BranchDiffResponse) => void
    let finishNew!: (data: BranchDiffResponse) => void
    jest
      .mocked(taskApis.getBranchDiff)
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishOld = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishNew = resolve
          })
      )
    const historical = {
      ...runningWorkbenchData,
      status: 'completed' as const,
      git_info: { ...runningWorkbenchData.git_info, target_branch: 'generated' },
    }
    const { rerender } = render(
      <Workbench {...props} taskNumber="#1" taskStatus="COMPLETED" workbenchData={historical} />
    )
    expect(taskApis.getBranchDiff).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Files Changed/ }))
    expect(taskApis.getBranchDiff).toHaveBeenCalledTimes(1)
    rerender(
      <Workbench
        {...props}
        taskNumber="#2"
        taskStatus="COMPLETED"
        workbenchData={{ ...historical, taskNumber: '#2', repository: 'new/repo' }}
      />
    )
    expect(taskApis.getBranchDiff).toHaveBeenCalledTimes(2)
    await act(async () => finishNew(branchDiff('new.txt')))
    expect(screen.getByTestId('diff-file-toggle')).toHaveTextContent('new.txt')
    await act(async () => finishOld(branchDiff('old.txt')))
    expect(screen.getByTestId('diff-file-toggle')).toHaveTextContent('new.txt')
    expect(screen.queryByText('old.txt')).not.toBeInTheDocument()
  })

  test('shows a branch request failure with an explicit retry', async () => {
    jest
      .mocked(taskApis.getBranchDiff)
      .mockRejectedValueOnce(new Error('403 forbidden'))
      .mockResolvedValueOnce(branchDiff('recovered.txt'))
    render(
      <Workbench
        {...props}
        taskStatus="COMPLETED"
        workbenchData={{
          ...runningWorkbenchData,
          status: 'completed',
          git_info: { ...runningWorkbenchData.git_info, target_branch: 'generated' },
        }}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Files Changed/ }))
    await screen.findByRole('alert')
    expect(screen.queryByText('No changes found')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() =>
      expect(screen.getByTestId('diff-file-toggle')).toHaveTextContent('recovered.txt')
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('keeps the current branch diff visible while refreshing and after a refresh failure', async () => {
    let failRefresh!: (error: Error) => void
    jest
      .mocked(taskApis.getBranchDiff)
      .mockResolvedValueOnce(branchDiff('saved.txt'))
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            failRefresh = reject
          })
      )
    const historical = {
      ...runningWorkbenchData,
      status: 'completed' as const,
      git_info: { ...runningWorkbenchData.git_info, target_branch: 'generated' },
    }
    const { rerender } = render(
      <Workbench {...props} taskStatus="COMPLETED" workbenchData={historical} />
    )
    fireEvent.click(screen.getByRole('button', { name: /Files Changed/ }))
    await waitFor(() =>
      expect(screen.getByTestId('diff-file-toggle')).toHaveTextContent('saved.txt')
    )
    fireEvent.click(screen.getByTestId('diff-file-toggle'))
    rerender(
      <Workbench
        {...props}
        taskStatus="COMPLETED"
        workbenchData={{ ...historical, lastUpdated: '2026-11-03T12:00:00Z' }}
      />
    )
    expect(taskApis.getBranchDiff).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('diff-file-content')).toBeInTheDocument()
    await act(async () => failRefresh(new Error('network timeout')))
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByTestId('diff-file-content')).toBeInTheDocument()
  })
})
