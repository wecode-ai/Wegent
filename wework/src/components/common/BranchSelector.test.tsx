import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { normalizeGeneratedBranchName, resolveBranchNameGenerationSource } from '@/lib/branch-name'
import { BranchSelector } from './BranchSelector'

describe('normalizeGeneratedBranchName', () => {
  test('keeps the first generated line and normalizes presentation noise', () => {
    expect(normalizeGeneratedBranchName(' “Fix/Login Redirect”\nExplanation')).toBe(
      'fix/login-redirect'
    )
  })

  test('falls back to the existing task title when the composer is empty', () => {
    expect(resolveBranchNameGenerationSource('  ', '修复登录回调跳转问题')).toBe(
      '修复登录回调跳转问题'
    )
    expect(resolveBranchNameGenerationSource('更新支付流程', '旧任务标题')).toBe('更新支付流程')
  })
})

describe('BranchSelector AI generation', () => {
  test('disables the input and shows progress while generating', async () => {
    let resolveGeneration: ((value: string) => void) | undefined
    const generation = new Promise<string>(resolve => {
      resolveGeneration = resolve
    })

    render(
      <BranchSelector
        variant="environment"
        currentBranch="main"
        onListBranches={vi.fn().mockResolvedValue(['main'])}
        onCheckoutBranch={vi.fn().mockResolvedValue(undefined)}
        onCreateBranch={vi.fn().mockResolvedValue(undefined)}
        onGenerateBranchName={vi.fn().mockReturnValue(generation)}
        branchNameSource="修复登录回调"
      />
    )

    fireEvent.click(screen.getByTestId('environment-branch-row'))
    await screen.findByTestId('environment-open-new-branch-button')
    fireEvent.click(screen.getByTestId('environment-open-new-branch-button'))
    fireEvent.click(screen.getByTestId('environment-generate-new-branch-button'))

    expect(screen.getByTestId('environment-new-branch-input')).toBeDisabled()
    expect(screen.getByTestId('environment-branch-generation-status')).toHaveTextContent(
      'AI 正在生成分支名'
    )
    expect(screen.getByTestId('environment-confirm-new-branch-button')).toBeDisabled()

    resolveGeneration?.('fix/login-redirect')
    await waitFor(() =>
      expect(screen.getByTestId('environment-new-branch-input')).not.toBeDisabled()
    )
  })

  test('generates a branch name into the editable input without creating it', async () => {
    const onCreateBranch = vi.fn().mockResolvedValue(undefined)
    const onGenerateBranchName = vi.fn().mockResolvedValue('fix/login-redirect')

    render(
      <BranchSelector
        variant="environment"
        currentBranch="main"
        onListBranches={vi.fn().mockResolvedValue(['main'])}
        onCheckoutBranch={vi.fn().mockResolvedValue(undefined)}
        onCreateBranch={onCreateBranch}
        onGenerateBranchName={onGenerateBranchName}
        branchNameSource="修复登录回调"
      />
    )

    fireEvent.click(screen.getByTestId('environment-branch-row'))
    await screen.findByTestId('environment-open-new-branch-button')
    fireEvent.click(screen.getByTestId('environment-open-new-branch-button'))
    fireEvent.click(screen.getByTestId('environment-generate-new-branch-button'))

    await waitFor(() =>
      expect(screen.getByTestId('environment-new-branch-input')).toHaveValue('fix/login-redirect')
    )
    expect(onGenerateBranchName).toHaveBeenCalledWith('修复登录回调')
    expect(onCreateBranch).not.toHaveBeenCalled()
  })

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
