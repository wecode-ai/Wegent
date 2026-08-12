import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

  test('traps keyboard focus and restores it to the permission trigger', async () => {
    const user = userEvent.setup()
    render(<PermissionModeSelector value="workspace-write" onChange={vi.fn()} />)
    const trigger = screen.getByTestId('permission-mode-menu-button')

    await user.click(trigger)
    await user.click(screen.getByTestId('permission-mode-full-access'))

    const cancel = screen.getByTestId('full-access-confirm-cancel')
    const confirm = screen.getByTestId('full-access-confirm-submit')
    expect(cancel).toHaveFocus()

    await user.tab({ shift: true })
    expect(confirm).toHaveFocus()
    await user.tab()
    expect(cancel).toHaveFocus()

    await user.click(cancel)
    expect(trigger).toHaveFocus()
  })
})
