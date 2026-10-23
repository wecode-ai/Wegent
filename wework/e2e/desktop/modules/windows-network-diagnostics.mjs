import { spawnSync } from 'node:child_process'

export function collectWindowsNetworkDiagnostics() {
  if (process.platform !== 'win32') return null
  const script = `
$ErrorActionPreference = 'Stop'
function Read-Diagnostic([scriptblock] $Query) {
  try { & $Query } catch { @{ errorId = $_.FullyQualifiedErrorId } }
}
$connections = @(Get-NetTCPConnection)
@{
  states = @($connections | Group-Object State | Select-Object Name, Count)
  processes = @($connections | Group-Object OwningProcess | Sort-Object Count -Descending | Select-Object -First 10 Name, Count)
  runtimeProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(WeWork|codex|node|claude|bash|sh|wegent-executor|powershell|pwsh)\\.exe$' } | Select-Object ProcessId, ParentProcessId, Name, CreationDate, KernelModeTime, UserModeTime, WorkingSetSize)
  dynamicTcpPorts = @(Read-Diagnostic { netsh interface ipv4 show dynamicport tcp })
  excludedTcpPorts = @(Read-Diagnostic { netsh interface ipv4 show excludedportrange protocol=tcp })
  socketExhaustionEvents = @(Read-Diagnostic {
    Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 4227, 4231; StartTime = (Get-Date).AddHours(-1) } |
      Select-Object TimeCreated, Id, ProviderName
  })
  memory = Read-Diagnostic {
    Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory |
      Select-Object AvailableBytes, PoolNonpagedBytes, PoolPagedBytes, CommittedBytes, CommitLimit
  }
} | ConvertTo-Json -Depth 4
`
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  })
  if (result.status !== 0) {
    return { status: result.status, errorCode: result.error?.code ?? null }
  }
  try {
    return JSON.parse(result.stdout)
  } catch {
    return { status: result.status, errorCode: 'invalid-network-diagnostics' }
  }
}
