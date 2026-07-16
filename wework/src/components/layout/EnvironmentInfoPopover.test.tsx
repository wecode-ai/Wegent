import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
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
        defaultOpen
      />
    )

    const popover = screen.getByTestId('environment-info-popover')
    expect(popover).toHaveTextContent('10.201.3.200 已离线，恢复在线后可继续对话')
    expect(popover).not.toHaveTextContent('executor-offline:')
    expect(popover).not.toHaveTextContent('9562a3b4-61a3-4217-9655-0341b231eb06')
  })
})
