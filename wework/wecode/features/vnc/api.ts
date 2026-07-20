import { createHttpClient } from '@/api/http'
import type { CloudDesktopConnection } from '@/extensions/cloud-desktop-contract'

export interface VncConfigResponse {
  sandbox_id: string
  signature: string
  wss_url: string
}

export async function getVncConfig(
  connection: CloudDesktopConnection,
  deviceId: string
): Promise<VncConfigResponse> {
  if (!connection.isConnected || !connection.apiBaseUrl || !connection.token) {
    throw new Error('Cloud connection is required')
  }

  const client = createHttpClient({
    baseUrl: connection.apiBaseUrl,
    getToken: () => connection.token,
    redirectOnUnauthorized: false,
  })
  return client.get<VncConfigResponse>(`/cloud-devices/${encodeURIComponent(deviceId)}/vnc-config`)
}
