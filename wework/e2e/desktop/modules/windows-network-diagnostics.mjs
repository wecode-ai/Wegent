import { spawnSync } from 'node:child_process'

export function collectWindowsNetworkDiagnostics() {
  if (process.platform !== 'win32') return null
  const script = `
$ErrorActionPreference = 'Stop'
$connections = @(Get-NetTCPConnection)
@{
  states = @($connections | Group-Object State | Select-Object Name, Count)
  processes = @($connections | Group-Object OwningProcess | Sort-Object Count -Descending | Select-Object -First 10 Name, Count)
} | ConvertTo-Json -Depth 4
`
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    }
  )
  if (result.status !== 0) {
    return { status: result.status, errorCode: result.error?.code ?? null }
  }
  try {
    return JSON.parse(result.stdout)
  } catch {
    return { status: result.status, errorCode: 'invalid-network-diagnostics' }
  }
}
