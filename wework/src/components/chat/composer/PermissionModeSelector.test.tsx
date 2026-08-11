import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { PermissionModeSelector } from './PermissionModeSelector'

describe('PermissionModeSelector', () => {
  test('changes between restricted modes without confirmation', () => {
    const onChange = vi.fn()
    render(<PermissionModeSelector value="workspace-write" onChange={onChange} />)

    fireEvent.click(screen.getByTestId('permission-mode-menu-button'))
    fireEvent.click(screen.getByTestId('permission-mode-read-only'))

    expect(onChange).toHaveBeenCalledWith('read-only')
  })

  test('requires confirmation before enabling full access', () => {
    const onChange = vi.fn()
    render(<PermissionModeSelector value="workspace-write" onChange={onChange} />)

    fireEvent.click(screen.getByTestId('permission-mode-menu-button'))
    fireEvent.click(screen.getByTestId('permission-mode-full-access'))

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('full-access-confirm-submit'))
    expect(onChange).toHaveBeenCalledWith('full-access')
  })

  test('keeps the current mode when full access is cancelled', () => {
    const onChange = vi.fn()
    render(<PermissionModeSelector value="workspace-write" onChange={onChange} />)

    fireEvent.click(screen.getByTestId('permission-mode-menu-button'))
    fireEvent.click(screen.getByTestId('permission-mode-full-access'))
    fireEvent.click(screen.getByTestId('full-access-confirm-cancel'))

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
