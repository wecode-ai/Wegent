import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import { DefaultRunnerSetting } from './DefaultRunnerSetting'

it('renders a usable default-device control, saves the shared preference and restores it on reopening', async () => {
  const updateUserPreferences = vi.fn(async () => {})
  const state = {
    devices: [
      { device_id: 'mac', name: 'My Mac', status: 'online' },
      { device_id: 'old', name: 'Old installation', status: 'offline' },
      { device_id: 'cloud', name: 'My cloud host', status: 'online' },
    ],
    user: { preferences: { default_execution_target: 'mac' } },
  }
  const value = { state, updateUserPreferences } as unknown as WorkbenchContextValue
  const { rerender } = render(
    <WorkbenchContext.Provider value={value}>
      <DefaultRunnerSetting />
    </WorkbenchContext.Provider>
  )
  const selector = screen.getByTestId('settings-default-runner')
  expect(selector).toBeVisible()
  expect(selector).toHaveValue('mac')
  expect(screen.queryByRole('option', { name: /Old installation/ })).not.toBeInTheDocument()
  fireEvent.change(selector, { target: { value: 'cloud' } })
  await waitFor(() =>
    expect(updateUserPreferences).toHaveBeenCalledWith({ default_execution_target: 'cloud' })
  )
  rerender(
    <WorkbenchContext.Provider
      value={{
        ...value,
        state: {
          ...value.state,
          user: { ...value.state.user!, preferences: { default_execution_target: 'cloud' } },
        },
      }}
    >
      <DefaultRunnerSetting compact />
    </WorkbenchContext.Provider>
  )
  expect(screen.getByTestId('settings-default-runner')).toHaveValue('cloud')
})
