import '@/i18n'
import type { CloudDeviceMetricsResponse, DeviceInfo } from '@/types/devices'
import { act, render, screen, waitFor } from '@testing-library/react'
import { Cloud } from 'lucide-react'
import { expect, test, vi } from 'vitest'
import { DeviceSection } from './DeviceSection'

const cloud = vi.hoisted(() => ({
  connection: {
    isConnected: true,
    apiBaseUrl: 'https://cloud.example.test',
    serviceKey: 'account-1',
    token: 'test-token',
  },
}))
const getMetrics = vi.hoisted(() => vi.fn())

vi.mock('@/features/cloud-connection/useCloudConnection', () => ({
  useOptionalCloudConnection: () => cloud.connection,
}))
vi.mock('./settings-cloud-api', () => ({
  createSettingsDeviceApi: () => ({ getMetrics }),
}))

test('preserves device readings across inventory updates and clears them when the cloud scope changes', async () => {
  const device: DeviceInfo = {
    id: 1,
    device_id: 'cloud-device',
    name: 'Cloud device',
    device_type: 'cloud',
    status: 'online',
    is_default: false,
    bind_shell: 'claudecode',
  }
  const nextMetrics = Promise.withResolvers<CloudDeviceMetricsResponse>()
  getMetrics
    .mockResolvedValueOnce({ cpu_usage: 24, memory_usage: 36, disk_usage: 67 })
    .mockReturnValueOnce(nextMetrics.promise)
  const deviceSection = (entry: DeviceInfo) => (
    <DeviceSection title="Devices" devices={[entry]} icon={Cloud} onChanged={vi.fn()} />
  )
  const view = render(deviceSection(device))
  const cpu = screen.getByTestId('connection-device-metric-cpu-cloud-device')
  await waitFor(() => expect(cpu).toHaveTextContent('24%'))

  const updatedDevice = { ...device, slot_used: 1 }
  await act(async () => view.rerender(deviceSection(updatedDevice)))
  expect(cpu).toHaveTextContent('24%')
  expect(getMetrics).toHaveBeenCalledOnce()

  cloud.connection = { ...cloud.connection, serviceKey: 'account-2' }
  view.rerender(deviceSection(updatedDevice))
  expect(cpu).toHaveTextContent('-')
  await act(async () => nextMetrics.resolve({ cpu_usage: 42, memory_usage: 35, disk_usage: 67 }))
  expect(cpu).toHaveTextContent('42%')
})
