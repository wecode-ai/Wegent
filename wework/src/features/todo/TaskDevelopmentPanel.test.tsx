import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { openExternalUrl } from '@/lib/external-links'
import { TaskDevelopmentPanel } from './TaskDevelopmentPanel'

vi.mock('@/lib/external-links', () => ({
  openExternalUrl: vi.fn().mockResolvedValue(true),
}))

describe('TaskDevelopmentPanel', () => {
  it('shows workspace, pull request, CI checks, review, and merge state', async () => {
    const user = userEvent.setup()
    const api = {
      listRepositories: vi.fn(async () => [
        {
          id: 'repository-1',
          repositoryIdentity: 'wegent/wegent',
        },
      ]),
      getTaskDevelopment: vi.fn(async () => [
        {
          id: 'development-1',
          itemId: 'item-1',
          repositoryBindingId: 'repository-1',
          workspace: {
            id: 'workspace-1',
            workspaceKind: 'git_worktree',
            workspacePath: '/workspace/item-1',
            status: 'ready',
          },
          branchName: 'feature/WEWORK-1-workflow',
          baseBranch: 'main',
          headCommit: 'abcdef0123456789',
          provider: 'github',
          pullRequestId: '123',
          pullRequestNumber: 123,
          pullRequestUrl: 'https://github.com/wegent/wegent/pull/123',
          pullRequestState: 'open',
          draft: false,
          mergeableState: 'clean',
          reviewDecision: 'approved',
          ciState: 'success',
          mergedCommit: null,
          checks: [
            {
              id: 'check-1',
              name: 'desktop-e2e',
              status: 'completed',
              conclusion: 'success',
            },
          ],
          reviewThreads: [
            {
              id: 'thread-1',
              providerThreadId: 'provider-thread-1',
              providerCommentId: 'comment-1',
              path: 'src/workflow.ts',
              line: 42,
              side: 'right',
              author: 'reviewer',
              body: 'Please handle the failed execution explicitly.',
              url: 'https://github.com/wegent/wegent/pull/123#discussion_r1',
              status: 'open',
              reviewState: 'changes_requested',
              createdAt: '2026-08-12T00:00:00Z',
              updatedAt: '2026-08-12T00:00:00Z',
            },
          ],
          version: 1,
          createdAt: '2026-08-12T00:00:00Z',
          updatedAt: '2026-08-12T00:00:00Z',
        },
      ]),
    }

    render(<TaskDevelopmentPanel projectId="12" itemId="item-1" api={api as never} />)

    expect(await screen.findByText('feature/WEWORK-1-workflow')).toBeInTheDocument()
    expect(screen.getByText('/workspace/item-1')).toBeInTheDocument()
    expect(screen.getByText('desktop-e2e')).toBeInTheDocument()
    expect(screen.getByText('approved')).toBeInTheDocument()
    expect(screen.getByText('src/workflow.ts:42')).toBeInTheDocument()
    expect(screen.getByText('Please handle the failed execution explicitly.')).toBeInTheDocument()
    await user.click(screen.getByTestId('task-development-open-review-thread-thread-1'))
    expect(openExternalUrl).toHaveBeenCalledWith(
      'https://github.com/wegent/wegent/pull/123#discussion_r1'
    )
    await user.click(screen.getByTestId('task-development-open-pr-development-1'))
    expect(openExternalUrl).toHaveBeenCalledWith('https://github.com/wegent/wegent/pull/123')
  })
})
