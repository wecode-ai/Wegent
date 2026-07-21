import { beforeEach, vi } from 'vitest'

const cloudDeviceInternalApisMock = vi.hoisted(() => ({
  getMetrics: vi.fn(),
  getMetricsHistory: vi.fn(),
}))

vi.mock('@wecode/api/devices', () => ({
  cloudDeviceInternalApis: cloudDeviceInternalApisMock,
}))

function resetCloudDeviceInternalApisMock() {
  cloudDeviceInternalApisMock.getMetrics.mockReset()
  cloudDeviceInternalApisMock.getMetricsHistory.mockReset()

  cloudDeviceInternalApisMock.getMetrics.mockResolvedValue({
    cpu_usage: 42,
    memory_usage: 68,
    disk_usage: 57,
  })
  cloudDeviceInternalApisMock.getMetricsHistory.mockResolvedValue({
    cpu: [],
    memory: [],
    disk: [],
  })
}

beforeEach(() => {
  resetCloudDeviceInternalApisMock()
})
