import { resolveBranchNameGenerationSource } from '@/lib/branch-name'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { BranchSelector } from './BranchSelector'

describe('normalizeGeneratedBranchName', () => {
  test('falls back to the existing task title when the composer is empty', () => {
    expect(resolveBranchNameGenerationSource('  ', '修复登录回调跳转问题')).toBe(
      '修复登录回调跳转问题'
    )
    expect(resolveBranchNameGenerationSource('更新支付流程', '旧任务标题')).toBe('更新支付流程')
  })
})

describe('BranchSelector AI generation', () => {
  test('shows a visible error instead of silently ignoring an empty source', async () => {
    const onGenerateBranchName = vi.fn()

    render(
      <BranchSelector
        variant="environment"
        currentBranch="main"
        onListBranches={vi.fn().mockResolvedValue(['main'])}
        onCheckoutBranch={vi.fn().mockResolvedValue(undefined)}
        onCreateBranch={vi.fn().mockResolvedValue(undefined)}
        onGenerateBranchName={onGenerateBranchName}
      />
    )

    fireEvent.click(screen.getByTestId('environment-branch-row'))
    await screen.findByTestId('environment-open-new-branch-button')
    fireEvent.click(screen.getByTestId('environment-open-new-branch-button'))
    fireEvent.click(screen.getByTestId('environment-generate-new-branch-button'))

    expect(await screen.findByText('请先输入任务描述')).toBeInTheDocument()
    expect(onGenerateBranchName).not.toHaveBeenCalled()
  })
})

describe('BranchSelector checkout', () => {
  test('retains the menu and error when checking out the cached current branch fails', async () => {
    const onCheckoutBranch = vi.fn().mockRejectedValue(new Error('Git checkout rejected'))
    render(
      <BranchSelector
        variant="workbar"
        currentBranch="main"
        onListBranches={vi.fn().mockResolvedValue(['main'])}
        onCheckoutBranch={onCheckoutBranch}
      />
    )

    fireEvent.click(screen.getByTestId('project-branch-button'))
    fireEvent.click(await screen.findByTestId('project-branch-option'))

    expect(await screen.findByText('Git checkout rejected')).toBeInTheDocument()
    expect(screen.getByTestId('project-branch-menu')).toBeInTheDocument()
  })
})
