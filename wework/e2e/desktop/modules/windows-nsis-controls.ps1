param(
  [Parameter(Mandatory = $true)]
  [int]$TimeoutSeconds,
  [Parameter(Mandatory = $true)]
  [string]$EvidencePath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$actions = [System.Collections.Generic.List[object]]::new()
$seenInstaller = $false

function Test-ApplicationUpdateInstaller($Process) {
  for ($depth = 0; $Process -and $depth -lt 8; $depth++) {
    if ($Process.CommandLine -match '--updated') { return $true }
    if (-not $Process.ParentProcessId) { break }
    $Process = Get-CimInstance Win32_Process -Filter "ProcessId=$($Process.ParentProcessId)"
  }
  return $false
}

try {
  while ([DateTime]::UtcNow -lt $deadline) {
    $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
      [System.Windows.Automation.TreeScope]::Children,
      [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32770'
      )
    )
    foreach ($window in $windows) {
      $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($window.Current.ProcessId)"
      if (-not (Test-ApplicationUpdateInstaller $process)) { continue }
      $seenInstaller = $true
      $buttons = $window.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.PropertyCondition]::new(
          [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
          [System.Windows.Automation.ControlType]::Button
        )
      )
      foreach ($button in $buttons) {
        if (-not $button.Current.IsEnabled) { continue }
        $name = $button.Current.Name.Replace('&', '')
        if ($name -match '^(Abort|Retry|中止|重试)') {
          throw "The real NSIS installation reported an error: $name"
        }
        if ($name -notmatch '^(Next|Install|Finish|Close|下一步|安装|完成|关闭)') { continue }
        $pattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $actions.Add(@{ processId = $process.ProcessId; button = $name; at = [DateTime]::UtcNow.ToString('o') })
        $pattern.Invoke()
        Start-Sleep -Milliseconds 300
        break
      }
    }
    if ($seenInstaller) {
      $remaining = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '--updated' }
      if (-not $remaining) { return }
    }
    Start-Sleep -Milliseconds 200
  }
  throw 'Timed out waiting for the real application-initiated NSIS upgrade'
} finally {
  @{ observedInstaller = $seenInstaller; actions = $actions } |
    ConvertTo-Json -Depth 4 |
    Set-Content -LiteralPath $EvidencePath -Encoding utf8
}
