import { render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { DeviceInfo } from '@/types/api'
import type { EnvironmentInfo } from '@/types/environment'
import { EnvironmentSummaryOverview } from './EnvironmentSummaryOverview'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | { device: string }) =>
      typeof fallback === 'string'
        ? fallback
        : fallback?.device
          ? `${fallback.device} offline`
          : key,
  }),
}))

test('names the remote owner and retains a failed read until a successful refresh', () => {
  const device: DeviceInfo = {
    id: 1,
    device_id: 'owner',
    name: 'Remote workspace',
    status: 'offline',
    client_ip: '127.0.0.1',
    device_type: 'remote',
    bind_shell: 'claudecode',
    is_default: false,
  }
  const info: EnvironmentInfo = {
    additions: '',
    deletions: '',
    executionTarget: 'remote',
    executionDeviceId: device.device_id,
    error: 'executor-offline:owner',
  }
  const { rerender } = render(<EnvironmentSummaryOverview devices={[device]} info={info} />)
  expect(screen.getByTestId('environment-read-error')).toHaveTextContent('Remote workspace offline')
  expect(screen.getByTestId('environment-execution-target-row').title).toContain('远程设备')
  rerender(<EnvironmentSummaryOverview devices={[{ ...device, status: 'online' }]} info={info} />)
  expect(screen.getByTestId('environment-read-error')).toBeInTheDocument()
  rerender(
    <EnvironmentSummaryOverview
      devices={[{ ...device, status: 'online' }]}
      info={{ ...info, error: undefined }}
    />
  )
  expect(screen.queryByTestId('environment-read-error')).not.toBeInTheDocument()
})
