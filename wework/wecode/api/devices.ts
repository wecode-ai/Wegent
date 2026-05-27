import type { CloudDeviceMetricsResponse, VncConfigResponse } from '@wecode/types/devices'
import { createHttpClient } from '@/api/http'
import { getRuntimeConfig } from '@/config/runtime'

function getClient() {
  const { apiBaseUrl } = getRuntimeConfig()
  return createHttpClient({ baseUrl: apiBaseUrl })
}

export const cloudDeviceInternalApis = {
  async getMetrics(deviceId: string): Promise<CloudDeviceMetricsResponse> {
    return getClient().post<CloudDeviceMetricsResponse>(
      `/cloud-devices/${deviceId}/metrics`,
    )
  },

  async getVncConfig(deviceId: string): Promise<VncConfigResponse> {
    return getClient().get<VncConfigResponse>(
      `/cloud-devices/${deviceId}/vnc-config`,
    )
  },
}
