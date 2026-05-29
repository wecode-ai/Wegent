import { beforeEach, vi } from 'vitest'

const cloudDeviceInternalApisMock = vi.hoisted(() => ({
  getMetrics: vi.fn(),
  getMetricsHistory: vi.fn(),
  getVncConfig: vi.fn(),
}))

vi.mock('@wecode/api/devices', () => ({
  cloudDeviceInternalApis: cloudDeviceInternalApisMock,
}))

function resetCloudDeviceInternalApisMock() {
  cloudDeviceInternalApisMock.getMetrics.mockReset()
  cloudDeviceInternalApisMock.getMetricsHistory.mockReset()
  cloudDeviceInternalApisMock.getVncConfig.mockReset()

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
  cloudDeviceInternalApisMock.getVncConfig.mockResolvedValue({
    wss_url: 'wss://example.com/vnc',
    signature: 'signature',
    sandbox_id: 'sandbox-1',
  })
}

beforeEach(() => {
  resetCloudDeviceInternalApisMock()
})
