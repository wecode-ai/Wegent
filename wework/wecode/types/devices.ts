export interface CloudDeviceMetricsResponse {
  cpu_usage: number | null
  memory_usage: number | null
  disk_usage: number | null
}

export interface MetricsHistoryResponse {
  cpu: [number, number][]
  memory: [number, number][]
  disk: [number, number][]
}

export interface VncConfigResponse {
  wss_url: string
  signature: string
  sandbox_id: string
}
