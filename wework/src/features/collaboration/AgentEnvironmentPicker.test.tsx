import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { RunnerEnvironment } from '@wegent/collaboration'
import { AgentEnvironmentPicker } from './AgentEnvironmentPicker'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const environments: RunnerEnvironment[] = [
  { id: 'offline', device_key: 'laptop-offline-key', name: 'Offline laptop', status: 'offline' },
  { id: 'online', device_key: 'server-online-key', name: 'Online server', status: 'online' },
  { id: 'unknown', device_key: 'pending-key', name: 'Unknown device', status: 'unknown' },
].map(item => ({
  ...item,
  owner_type: 'user',
  owner_id: '1',
  project_authorized: false,
  models: [],
})) as RunnerEnvironment[]

environments.push(
  {
    ...environments[1],
    id: 'project-shared',
    name: 'Project runner',
    owner_type: 'workspace',
    project_authorized: true,
  },
  {
    ...environments[1],
    id: 'shared-personal',
    name: 'Shared personal runner',
    project_authorized: true,
  },
  {
    ...environments[1],
    id: 'other-workspace',
    name: 'Unrelated shared runner',
    owner_type: 'workspace',
  }
)

function setup(value = 'policy:project_pool', selectionOnly = false, disabled = false) {
  const onChange = vi.fn()
  render(
    <AgentEnvironmentPicker
      value={value}
      onChange={onChange}
      testId="runner"
      disabled={disabled}
      loading={false}
      environments={environments}
      selectionOnly={selectionOnly}
      projectScoped
    />
  )
  return onChange
}

async function open() {
  fireEvent.click(screen.getByTestId('runner'))
  await waitFor(() => expect(screen.getByTestId('runner-search')).toHaveFocus())
}

describe('execution environment picker', () => {
  it('orders automatic and runtime choices before project-shared and personal device sections', async () => {
    const onChange = setup()
    expect(screen.getByTestId('runner')).toHaveAttribute('data-value', 'policy:project_pool')
    await open()
    expect(screen.queryByTestId('runner-option-empty')).not.toBeInTheDocument()
    expect(screen.getAllByRole('option').map(option => option.getAttribute('data-testid'))).toEqual(
      [
        'runner-option-policy:project_pool',
        'runner-option-policy:user_select',
        'runner-option-project-shared',
        'runner-option-shared-personal',
        'runner-option-online',
      ]
    )
    expect(screen.queryByTestId('runner-option-other-workspace')).not.toBeInTheDocument()
    const menu = screen.getByTestId('runner-menu')
    expect(menu.textContent!.indexOf('workbench.runner_specify_device')).toBeLessThan(
      menu.textContent!.indexOf('workbench.runner_project_devices')
    )
    expect(menu.textContent!.indexOf('workbench.runner_project_devices')).toBeLessThan(
      menu.textContent!.indexOf('workbench.runner_personal_devices')
    )
    fireEvent.click(screen.getByTestId('runner-option-policy:user_select'))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('policy:user_select')
  })

  it('shows only online devices initially and toggles offline devices without closing the menu', async () => {
    setup()
    await open()
    expect(screen.getByTestId('runner-option-online')).toBeVisible()
    expect(screen.queryByTestId('runner-option-offline')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runner-option-unknown')).not.toBeInTheDocument()
    const checkbox = screen.getByTestId('runner-show-offline')
    expect(checkbox).not.toBeChecked()
    fireEvent.click(checkbox)
    expect(screen.getByTestId('runner-option-offline')).toBeVisible()
    expect(screen.getByTestId('runner-option-unknown')).toBeVisible()
    expect(
      screen
        .getAllByRole('option')
        .map(option => option.getAttribute('data-testid'))
        .indexOf('runner-option-online')
    ).toBeLessThan(
      screen
        .getAllByRole('option')
        .map(option => option.getAttribute('data-testid'))
        .indexOf('runner-option-offline')
    )
    fireEvent.click(checkbox)
    expect(screen.queryByTestId('runner-option-offline')).not.toBeInTheDocument()
    expect(screen.getByTestId('runner-search')).toBeVisible()
  })

  it('searches device names and IDs while respecting the offline filter', async () => {
    const onChange = setup()
    await open()
    fireEvent.change(screen.getByTestId('runner-search'), {
      target: { value: 'SERVER-ONLINE-KEY' },
    })
    expect(screen.getByTestId('runner-option-online')).toBeVisible()
    expect(screen.queryByTestId('runner-option-policy:project_pool')).not.toBeInTheDocument()
    fireEvent.change(screen.getByTestId('runner-search'), { target: { value: 'Offline laptop' } })
    expect(screen.queryByTestId('runner-option-offline')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('runner-show-offline'))
    fireEvent.click(screen.getByTestId('runner-option-offline'))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('offline')
    expect(screen.queryByTestId('runner-menu')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('runner')).toHaveFocus())
  })

  it('retains an already selected offline environment without enabling the offline filter', async () => {
    const onChange = setup('offline')
    expect(screen.getByTestId('runner')).toHaveTextContent('Offline laptop')
    expect(screen.getByTestId('runner')).toHaveAttribute('data-value', 'offline')
    await open()
    expect(screen.getByTestId('runner-show-offline')).not.toBeChecked()
    expect(screen.queryByTestId('runner-option-offline')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByTestId('runner-search'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('runner-menu')).not.toBeInTheDocument())
    expect(screen.getByTestId('runner')).toHaveAttribute('data-value', 'offline')
  })

  it('preserves allocation policies and respects disabled and execution-only modes', async () => {
    const onChange = setup('policy:project_pool', true)
    await open()
    expect(screen.queryByTestId('runner-option-policy:user_select')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('runner-option-policy:project_pool'))
    expect(onChange).toHaveBeenCalledWith('policy:project_pool')
  })

  it('does not open a disabled selector', () => {
    setup('online', false, true)
    fireEvent.click(screen.getByTestId('runner'))
    expect(screen.queryByTestId('runner-menu')).not.toBeInTheDocument()
  })
})
