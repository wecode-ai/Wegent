import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { PermissionModeSelector } from './PermissionModeSelector'

describe('PermissionModeSelector', () => {
  test('shows the current mode and changes it from the native selector', () => {
    const onChange = vi.fn()
    render(<PermissionModeSelector value="full_access" onChange={onChange} />)

    const selector = screen.getByTestId('codex-permission-mode-selector')
    expect(selector).toHaveValue('full_access')

    fireEvent.change(selector, { target: { value: 'request_approval' } })

    expect(onChange).toHaveBeenCalledWith('request_approval')
  })

  test('uses a mobile-sized target without changing its test id', () => {
    render(<PermissionModeSelector value="approve_for_me" mobile onChange={vi.fn()} />)

    const selector = screen.getByTestId('codex-permission-mode-selector')
    expect(selector.closest('label')).toHaveClass('h-11')
    expect(selector).toHaveAccessibleName()
  })
})
