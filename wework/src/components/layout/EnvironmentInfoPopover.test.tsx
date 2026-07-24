import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { EnvironmentInfoPopover } from './EnvironmentInfoPopover'

describe('EnvironmentInfoPopover', () => {
  const portalContainers: HTMLElement[] = []

  afterEach(() => {
    portalContainers.splice(0).forEach(container => container.remove())
  })

  test('shows the device IP instead of an executor id for offline errors', () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)

    render(
      <EnvironmentInfoPopover
        info={{
          additions: '',
          deletions: '',
          executionTarget: 'cloud',
          deviceId: '9562a3b4-61a3-4217-9655-0341b231eb06',
          error: 'executor-offline:9562a3b4-61a3-4217-9655-0341b231eb06',
        }}
        devices={[
          {
            id: 1,
            device_id: '9562a3b4-61a3-4217-9655-0341b231eb06',
            name: 'sifang-executor-0341b231eb06',
            status: 'offline',
            is_default: false,
            device_type: 'remote',
            client_ip: '10.201.3.200',
          },
        ]}
        popoverContainer={popoverContainer}
        open
        onOpenChange={vi.fn()}
      />
    )

    const popover = screen.getByTestId('environment-info-popover')
    expect(popover).toHaveTextContent('10.201.3.200 已离线，恢复在线后可继续对话')
    expect(popover).not.toHaveTextContent('executor-offline:')
    expect(popover).not.toHaveTextContent('9562a3b4-61a3-4217-9655-0341b231eb06')
  })

  test('delegates open state to the app shell without writing browser storage', async () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)

    function ControlledPopover() {
      const [open, setOpen] = useState(true)
      return (
        <EnvironmentInfoPopover
          info={{
            additions: '',
            deletions: '',
            executionTarget: 'local',
          }}
          popoverContainer={popoverContainer}
          open={open}
          onOpenChange={setOpen}
        />
      )
    }

    const first = render(<ControlledPopover />)

    expect(screen.getByTestId('environment-info-popover')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('environment-info-button'))
    expect(screen.queryByTestId('environment-info-popover')).not.toBeInTheDocument()
    expect(localStorage.getItem('wework.desktop.environmentInfo.open')).toBeNull()

    first.unmount()
    render(<ControlledPopover />)
    expect(screen.getByTestId('environment-info-popover')).toBeInTheDocument()
    expect(localStorage.getItem('wework.desktop.environmentInfo.open')).toBeNull()
  })

  test('shows TODO binding and delivery actions for a local task', async () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)
    const onDeliver = vi.fn()
    const onManageTodo = vi.fn()

    render(
      <EnvironmentInfoPopover
        info={{ additions: '', deletions: '', executionTarget: 'local' }}
        popoverContainer={popoverContainer}
        open
        onOpenChange={vi.fn()}
        onDeliver={onDeliver}
        onManageTodo={onManageTodo}
      />
    )

    expect(screen.getByTestId('environment-todo-binding-button')).toHaveTextContent('关联项目空间')
    expect(screen.getByTestId('environment-delivery-button')).toHaveTextContent('交付到任务…')
    await userEvent.click(screen.getByTestId('environment-todo-binding-button'))
    await userEvent.click(screen.getByTestId('environment-delivery-button'))
    expect(onManageTodo).toHaveBeenCalledOnce()
    expect(onDeliver).toHaveBeenCalledOnce()
  })

  test('hides git controls and diff stats for a non-git workspace', () => {
    const popoverContainer = document.createElement('div')
    document.body.appendChild(popoverContainer)
    portalContainers.push(popoverContainer)

    render(
      <EnvironmentInfoPopover
        info={{
          additions: '+0',
          deletions: '-0',
          executionTarget: 'local',
          isGitRepository: false,
          workspacePath: '/workspace/plain-project',
        }}
        popoverContainer={popoverContainer}
        open
        onOpenChange={vi.fn()}
        onListBranches={vi.fn().mockResolvedValue([])}
        onCheckoutBranch={vi.fn().mockResolvedValue(undefined)}
        onOpenChangesReview={vi.fn()}
      />
    )

    expect(screen.queryByTestId('environment-git-section')).not.toBeInTheDocument()
    expect(screen.queryByText('+0')).not.toBeInTheDocument()
    expect(screen.queryByText('-0')).not.toBeInTheDocument()
  })
})
