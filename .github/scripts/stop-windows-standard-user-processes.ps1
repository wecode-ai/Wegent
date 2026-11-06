$ErrorActionPreference = "Stop"

$logDirectory = Join-Path $env:GITHUB_WORKSPACE ".ci-artifacts/windows-standard-user"
foreach ($record in Get-ChildItem -LiteralPath $logDirectory -Filter "account-*.json" -ErrorAction SilentlyContinue) {
  $account = Get-Content -LiteralPath $record.FullName -Raw | ConvertFrom-Json
  if ($account.name -notmatch '^wework-e2e-\d+$') {
    throw "Invalid Windows E2E account record: $($record.Name)"
  }
  $user = Get-LocalUser -Name $account.name -ErrorAction SilentlyContinue
  if (-not $user) {
    Remove-Item -LiteralPath $record.FullName
    continue
  }
  if ($user.SID.Value -ne $account.sid) {
    throw "Windows E2E account SID changed: $($account.name)"
  }
  # Credentialed descendants survive cancellation of the runner's PowerShell.
  # Only terminate processes owned by the dedicated account recorded by this job.
  $ownedProcesses = @()
  foreach ($process in Get-CimInstance Win32_Process) {
    $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction SilentlyContinue
    if ($owner.Sid -eq $account.sid) {
      Write-Host "[windows-standard-user] stopping owned process $($process.ProcessId)"
      $owned = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
      if ($owned) {
        $ownedProcesses += $owned
        Stop-Process -InputObject $owned -Force -ErrorAction SilentlyContinue
      }
    }
  }
  foreach ($owned in $ownedProcesses) {
    if (-not $owned.WaitForExit(10000)) {
      throw "Windows E2E process did not exit: $($owned.Id)"
    }
  }
  Get-CimInstance -ClassName Win32_UserProfile |
    Where-Object { $_.SID -eq $account.sid } |
    Remove-CimInstance
  Remove-LocalUser -Name $account.name
  Remove-Item -LiteralPath $record.FullName
}
