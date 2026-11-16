import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import { DefaultRunnerSetting } from './DefaultRunnerSetting'

afterEach(cleanup)

it('stages an Issue-form selection, retains failures and applies only through its separate save action', async () => {
  const updateUserPreferences = vi
    .fn()
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValue(undefined)
  const value = {
    state: {
      devices: [
        { device_id: 'mac', name: 'Mac', status: 'online' },
        { device_id: 'cloud', name: 'Cloud', status: 'online' },
      ],
      user: { preferences: { default_execution_target: 'mac' } },
    },
    updateUserPreferences,
  } as unknown as WorkbenchContextValue
  const { unmount } = render(
    <WorkbenchContext.Provider value={value}>
      <DefaultRunnerSetting compact confirmChanges />
    </WorkbenchContext.Provider>
  )
  fireEvent.change(screen.getByTestId('settings-default-runner'), { target: { value: 'cloud' } })
  expect(updateUserPreferences).not.toHaveBeenCalled()
  expect(screen.getByTestId('settings-default-runner')).toHaveValue('cloud')
  fireEvent.click(screen.getByTestId('settings-default-runner-save'))
  await screen.findByRole('alert')
  expect(screen.getByTestId('settings-default-runner')).toHaveValue('cloud')
  fireEvent.click(screen.getByTestId('settings-default-runner-save'))
  await waitFor(() => expect(updateUserPreferences).toHaveBeenCalledTimes(2))
  expect(updateUserPreferences).toHaveBeenLastCalledWith({ default_execution_target: 'cloud' })
  unmount()
})

it('does not clear an unavailable default until explicitly saved in an Issue form', async () => {
  const updateUserPreferences = vi.fn().mockResolvedValue(undefined)
  const value = {
    state: { devices: [], user: { preferences: { default_execution_target: 'old' } } },
    updateUserPreferences,
  } as unknown as WorkbenchContextValue
  render(
    <WorkbenchContext.Provider value={value}>
      <DefaultRunnerSetting compact confirmChanges />
    </WorkbenchContext.Provider>
  )
  fireEvent.click(screen.getByTestId('settings-default-runner-clear'))
  expect(updateUserPreferences).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('settings-default-runner-save'))
  await waitFor(() =>
    expect(updateUserPreferences).toHaveBeenCalledWith({ default_execution_target: null })
  )
})

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

it('lets the user clear an unavailable default without listing the offline device', async () => {
  const updateUserPreferences = vi.fn(async () => {})
  const value = {
    state: {
      devices: [{ device_id: 'old', name: 'Offline Mac', status: 'offline' }],
      user: { preferences: { default_execution_target: 'old' } },
    },
    updateUserPreferences,
  } as unknown as WorkbenchContextValue
  render(
    <WorkbenchContext.Provider value={value}>
      <DefaultRunnerSetting compact />
    </WorkbenchContext.Provider>
  )
  expect(screen.queryByRole('option', { name: /Offline Mac/ })).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('settings-default-runner-clear'))
  await waitFor(() =>
    expect(updateUserPreferences).toHaveBeenCalledWith({ default_execution_target: null })
  )
})
