param(
  [Parameter(Mandatory = $true)]
  [int]$TimeoutSeconds,
  [Parameter(Mandatory = $true)]
  [string]$EvidencePath
)

$ErrorActionPreference = 'Stop'

# Drive the real electron-builder NSIS wizard through Win32 messages. Windows
# PowerShell 5.1 cannot see the NSIS control tree through UI Automation, and
# matching localized button labels breaks on non-English installers.
Add-Type -Namespace WeworkNsis -Name Native -MemberDefinition @'
public delegate bool EnumWindowsProc(System.IntPtr hWnd, System.IntPtr lParam);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, System.IntPtr lParam);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint processId);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetClassName(System.IntPtr hWnd, System.Text.StringBuilder name, int max);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr hWnd, System.Text.StringBuilder text, int max);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetDlgItem(System.IntPtr hDlg, int id);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr hWnd, uint msg, System.IntPtr wParam, System.IntPtr lParam);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowEnabled(System.IntPtr hWnd);
'@

$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$actions = [System.Collections.Generic.List[object]]::new()
$trackedProcessIds = [System.Collections.Generic.HashSet[int]]::new()
$lastPosted = @{}
$lastWindowTitle = ''
$lastControlIds = @()
$seenInstaller = $false

function Test-ApplicationUpdateInstaller($Process) {
  if (-not $Process -or $Process.Name -notmatch '(?i)-setup\.exe$') { return $false }
  for ($depth = 0; $Process -and $depth -lt 8; $depth++) {
    if ($Process.CommandLine -match '--updated') { return $true }
    if (-not $Process.ParentProcessId) { break }
    $Process = Get-CimInstance Win32_Process -Filter "ProcessId=$($Process.ParentProcessId)"
  }
  return $false
}

function Update-TrackedInstallerProcesses {
  foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name LIKE '%-setup.exe'")) {
    if (Test-ApplicationUpdateInstaller $process) {
      [void]$trackedProcessIds.Add([int]$process.ProcessId)
    }
  }
  # The installer hands off to child processes, so tracked ids are only dropped
  # once the process has really exited.
  $exited = @(
    foreach ($processId in @($trackedProcessIds)) {
      try {
        $null = [System.Diagnostics.Process]::GetProcessById($processId)
      } catch {
        $processId
      }
    }
  )
  foreach ($processId in $exited) { [void]$trackedProcessIds.Remove($processId) }
}

function Get-InstallerDialogs {
  $script:dialogs = [System.Collections.Generic.List[object]]::new()
  $callback = [WeworkNsis.Native+EnumWindowsProc] {
    param($handle, $parameter)
    $owner = 0
    [void][WeworkNsis.Native]::GetWindowThreadProcessId($handle, [ref]$owner)
    if (-not $script:trackedProcessIds.Contains([int]$owner)) { return $true }
    $className = New-Object System.Text.StringBuilder 64
    [void][WeworkNsis.Native]::GetClassName($handle, $className, 64)
    if ($className.ToString() -ne '#32770') { return $true }
    if (-not [WeworkNsis.Native]::IsWindowVisible($handle)) { return $true }
    $title = New-Object System.Text.StringBuilder 256
    [void][WeworkNsis.Native]::GetWindowText($handle, $title, 256)
    $script:dialogs.Add([pscustomobject]@{
      Handle = $handle
      ProcessId = [int]$owner
      Title = $title.ToString()
      Primary = [WeworkNsis.Native]::GetDlgItem($handle, 1)
      Abort = [WeworkNsis.Native]::GetDlgItem($handle, 4)
      Ignore = [WeworkNsis.Native]::GetDlgItem($handle, 5)
    })
    return $true
  }
  [void][WeworkNsis.Native]::EnumWindows($callback, [System.IntPtr]::Zero)
  return $script:dialogs
}

try {
  while ([DateTime]::UtcNow -lt $deadline) {
    Update-TrackedInstallerProcesses
    foreach ($dialog in (Get-InstallerDialogs)) {
      $seenInstaller = $true
      $lastWindowTitle = $dialog.Title
      $lastControlIds = @(1, 2, 3, 4, 5 | Where-Object {
        [WeworkNsis.Native]::GetDlgItem($dialog.Handle, $_) -ne [System.IntPtr]::Zero
      })
      # A NSIS message box exposes IDABORT/IDRETRY/IDIGNORE (3/4/5); wizard
      # pages only expose IDOK/IDCANCEL plus an optional custom Back button.
      if (
        $dialog.Ignore -ne [System.IntPtr]::Zero -or
        ($dialog.Abort -ne [System.IntPtr]::Zero -and $dialog.Primary -eq [System.IntPtr]::Zero)
      ) {
        throw "The real NSIS installation reported an error: '$($dialog.Title)'"
      }
      if ($dialog.Primary -eq [System.IntPtr]::Zero) { continue }
      if (-not [WeworkNsis.Native]::IsWindowEnabled($dialog.Primary)) { continue }
      $key = "$($dialog.Handle):$($dialog.ProcessId)"
      $postedAt = [DateTime]::MinValue
      if ($lastPosted.ContainsKey($key)) { $postedAt = $lastPosted[$key] }
      if ((([DateTime]::UtcNow - $postedAt).TotalSeconds) -lt 3) { continue }
      $lastPosted[$key] = [DateTime]::UtcNow
      # WM_COMMAND with IDOK (1) matches Next/Install/Finish on every page.
      $sent = [WeworkNsis.Native]::PostMessage(
        $dialog.Handle,
        0x0111,
        [System.IntPtr]1,
        $dialog.Primary
      )
      $actions.Add(@{
        processId = $dialog.ProcessId
        window = $dialog.Title
        controlId = '1'
        posted = $sent
        at = [DateTime]::UtcNow.ToString('o')
      })
      Start-Sleep -Milliseconds 500
    }
    if ($seenInstaller -and $trackedProcessIds.Count -eq 0) { return }
    Start-Sleep -Milliseconds 200
  }
  throw 'Timed out waiting for the real application-initiated NSIS upgrade'
} finally {
  @{
    observedInstaller = $seenInstaller
    lastWindowTitle = $lastWindowTitle
    lastControlIds = $lastControlIds
    actions = $actions
  } |
    ConvertTo-Json -Depth 4 |
    Set-Content -LiteralPath $EvidencePath -Encoding utf8
}
