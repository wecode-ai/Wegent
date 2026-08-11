import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import '@/i18n'
import { WorktreeCreationStatus } from './WorktreeCreationStatus'
import { isWorktreeCreationPending } from './worktreeCreationState'

const creatingWorktree = {
  taskId: 'runtime-1',
  workspacePath: '/workspace/project',
  workspaceKind: 'worktree',
  title: 'Create a worktree',
  runtime: 'codex',
  status: 'creating',
  optimistic: true,
} as const

describe('WorktreeCreationStatus', () => {
  test('renders an accessible creation status', () => {
    render(<WorktreeCreationStatus />)

    expect(screen.getByRole('status')).toHaveTextContent('正在创建工作树')
    expect(screen.getByRole('status')).toHaveTextContent('完成后，任务会自动开始')
  })

  test('only matches the optimistic worktree submission phase', () => {
    expect(isWorktreeCreationPending(creatingWorktree, 'submitting')).toBe(true)
    expect(isWorktreeCreationPending(creatingWorktree, 'awaiting_assistant')).toBe(false)
    expect(
      isWorktreeCreationPending(
        {
          ...creatingWorktree,
          workspaceKind: 'workspace',
        },
        'submitting'
      )
    ).toBe(false)
    expect(
      isWorktreeCreationPending(
        {
          ...creatingWorktree,
          optimistic: false,
        },
        'submitting'
      )
    ).toBe(false)
  })
})
