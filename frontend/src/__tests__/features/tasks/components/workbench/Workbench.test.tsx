// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import { Workbench } from '@/features/tasks/components/workbench'

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

jest.mock('@/features/tasks/components/message/DiffViewer', () => ({
  __esModule: true,
  default: () => <div>diff-viewer</div>,
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
      }

      return translations[key] || key
    },
  }),
}))

describe('Workbench', () => {
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
})
