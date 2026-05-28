import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { DeviceMetrics } from './DeviceMetrics'

vi.mock('@wecode/api/devices', () => ({
  cloudDeviceInternalApis: {
    getMetrics: vi.fn(),
    getMetricsHistory: vi.fn(),
  },
}))

import { cloudDeviceInternalApis } from '@wecode/api/devices'

describe('DeviceMetrics', () => {
  test('renders expanded trend charts with a readable height', async () => {
    vi.mocked(cloudDeviceInternalApis.getMetrics).mockResolvedValue({
      cpu_usage: 12,
      memory_usage: 35,
      disk_usage: 0.5,
    })
    vi.mocked(cloudDeviceInternalApis.getMetricsHistory).mockResolvedValue({
      cpu: [
        [1_700_000_000, 18],
        [1_700_001_800, 24],
        [1_700_003_600, 11],
      ],
      memory: [
        [1_700_000_000, 33],
        [1_700_001_800, 34],
        [1_700_003_600, 36],
      ],
      disk: [
        [1_700_000_000, 0.5],
        [1_700_001_800, 0.6],
        [1_700_003_600, 0.5],
      ],
    })

    render(<DeviceMetrics deviceId="device-1" />)

    await userEvent.click(screen.getByRole('button'))

    await waitFor(() => {
      expect(cloudDeviceInternalApis.getMetricsHistory).toHaveBeenCalledWith('device-1')
    })

    expect(screen.getByTestId('device-metrics-chart-grid')).toHaveStyle({
      display: 'grid',
      gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    })

    const charts = document.querySelectorAll('svg[viewBox="0 0 280 128"]')
    expect(charts).toHaveLength(3)
    charts.forEach(chart => {
      expect(chart).toHaveStyle({ height: '96px' })
    })
    expect(document.querySelector('path[stroke="#409eff"]')).toBeInTheDocument()
    expect(document.querySelector('path[stroke="#14B8A6"]')).not.toBeInTheDocument()
  })
})
