import { getRuntimeConfig, joinAppPath } from '@/config/runtime'

export function buildVncPageUrl(deviceId: string, sandboxId: string): string {
  const token = localStorage.getItem('auth_token') || ''
  const { appBasePath } = getRuntimeConfig()
  const origin = window.location.origin
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.host
  const vncWsUrl = `${protocol}//${host}/api/cloud-devices/${encodeURIComponent(deviceId)}/vnc-ws?token=${encodeURIComponent(token)}`
  const vncPagePath = joinAppPath(appBasePath, '/vnc.html')

  return `${origin}${vncPagePath}?wsUrl=${encodeURIComponent(vncWsUrl)}&sandboxId=${encodeURIComponent(sandboxId)}`
}
