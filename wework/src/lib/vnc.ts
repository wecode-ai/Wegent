export function buildVncPageUrl(deviceId: string, sandboxId: string): string {
  const token = localStorage.getItem('auth_token') || ''
  const origin = window.location.origin
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.host
  const vncWsUrl = `${protocol}//${host}/api/cloud-devices/${encodeURIComponent(deviceId)}/vnc-ws?token=${encodeURIComponent(token)}`

  return `${origin}/vnc.html?wsUrl=${encodeURIComponent(vncWsUrl)}&sandboxId=${encodeURIComponent(sandboxId)}`
}
