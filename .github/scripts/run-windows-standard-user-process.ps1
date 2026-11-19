param(
  [Parameter(Mandatory = $true)]
  [string]$FilePath,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ArgumentList
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "wait-windows-standard-user-process.ps1")
$deadlineClock = [Diagnostics.Stopwatch]::StartNew()

$userName = "wework-e2e-$PID"
$passwordText = [Convert]::ToBase64String(
  [Security.Cryptography.RandomNumberGenerator]::GetBytes(24)
) + "aA1!"
$password = ConvertTo-SecureString $passwordText -AsPlainText -Force
$credential = [PSCredential]::new("$env:COMPUTERNAME\$userName", $password)
$workspace = (Resolve-Path -LiteralPath $env:GITHUB_WORKSPACE).Path
$logDirectory = Join-Path $workspace ".ci-artifacts/windows-standard-user"
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$stdoutPath = Join-Path $logDirectory "stdout.log"
$stderrPath = Join-Path $logDirectory "stderr.log"
$userSid = $null

try {
  & powershell.exe -NoProfile -NonInteractive -File (
    Join-Path $PSScriptRoot "prepare-windows-e2e-display.ps1"
  )
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to prepare the Windows desktop E2E display"
  }
  $user = New-LocalUser `
    -Name $userName `
    -Password $password `
    -AccountNeverExpires `
    -PasswordNeverExpires
  $userSid = $user.SID.Value
  @{ name = $userName; sid = $userSid } | ConvertTo-Json |
    Set-Content -LiteralPath (Join-Path $logDirectory "account-$PID.json")
  Add-LocalGroupMember -Group "Users" -Member $userName

  if (
    Get-LocalGroupMember -Group "Administrators" |
      Where-Object { $_.Name -eq "$env:COMPUTERNAME\$userName" }
  ) {
    throw "The Windows E2E account unexpectedly has administrator membership"
  }

  & icacls.exe $workspace /grant "${env:COMPUTERNAME}\${userName}:(OI)(CI)M" /Q
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to grant the Windows E2E account access to the workspace"
  }

  $profileBootstrap = Start-Process `
    -FilePath $env:ComSpec `
    -ArgumentList "/d", "/c", "exit", "0" `
    -Credential $credential `
    -LoadUserProfile `
    -NoNewWindow `
    -Wait `
    -PassThru
  if ($profileBootstrap.ExitCode -ne 0) {
    throw "Failed to initialize the Windows E2E account profile"
  }
  $profile = Get-CimInstance -ClassName Win32_UserProfile |
    Where-Object { $_.SID -eq $userSid }
  if (-not $profile -or -not $profile.LocalPath) {
    throw "The Windows E2E account profile was not created"
  }
  $profileRoot = $profile.LocalPath

  $env:USERNAME = $userName
  $env:USERPROFILE = $profileRoot
  $env:HOME = $profileRoot
  $env:HOMEDRIVE = (Split-Path -Qualifier $profileRoot).TrimEnd("\")
  $env:HOMEPATH = $profileRoot.Substring($env:HOMEDRIVE.Length)
  $env:APPDATA = Join-Path $profileRoot "AppData/Roaming"
  $env:LOCALAPPDATA = Join-Path $profileRoot "AppData/Local"
  $env:TEMP = Join-Path $profileRoot "AppData/Local/Temp"
  $env:TMP = $env:TEMP
  New-Item -ItemType Directory -Path $env:APPDATA, $env:LOCALAPPDATA, $env:TEMP -Force |
    Out-Null

  Write-Host "[windows-standard-user] account=$env:COMPUTERNAME\$userName"
  $process = Start-Process `
    -FilePath (Resolve-Path -LiteralPath $FilePath).Path `
    -ArgumentList $ArgumentList `
    -Credential $credential `
    -LoadUserProfile `
    -WorkingDirectory $workspace `
    -NoNewWindow `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru
  # Credentialed processes do not reliably inherit the runner's console handles.
  # Keep independent logs and forward output while the process is still running.
  # Reserve one minute inside the existing 55-minute step for account cleanup.
  $remainingSeconds = 54 * 60 - $deadlineClock.Elapsed.TotalSeconds
  if ($remainingSeconds -le 0) { throw "Windows E2E setup exhausted the process deadline" }
  $exitCode = Wait-LoggedProcess -Process $process `
    -LogPaths @($stdoutPath, $stderrPath) -TimeoutSeconds $remainingSeconds
  exit $exitCode
} finally {
  & (Join-Path $workspace ".github/scripts/stop-windows-standard-user-processes.ps1")
}
