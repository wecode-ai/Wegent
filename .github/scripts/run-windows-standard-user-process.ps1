param(
  [Parameter(Mandatory = $true)]
  [string]$FilePath,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ArgumentList
)

$ErrorActionPreference = "Stop"

$userName = "wework-e2e-$PID"
$passwordText = [Convert]::ToBase64String(
  [Security.Cryptography.RandomNumberGenerator]::GetBytes(24)
) + "aA1!"
$password = ConvertTo-SecureString $passwordText -AsPlainText -Force
$credential = [PSCredential]::new("$env:COMPUTERNAME\$userName", $password)
$workspace = (Resolve-Path -LiteralPath $env:GITHUB_WORKSPACE).Path
$userSid = $null
$stdoutReader = $null
$stderrReader = $null

try {
  $user = New-LocalUser `
    -Name $userName `
    -Password $password `
    -AccountNeverExpires `
    -PasswordNeverExpires
  $userSid = $user.SID.Value
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
  $env:PNPM_HOME = Join-Path $env:LOCALAPPDATA "pnpm"
  $env:npm_config_store_dir = Join-Path $env:PNPM_HOME "store"
  $env:TEMP = Join-Path $profileRoot "AppData/Local/Temp"
  $env:TMP = $env:TEMP
  New-Item -ItemType Directory -Path $env:APPDATA, $env:LOCALAPPDATA, $env:TEMP -Force |
    Out-Null

  Write-Host "[windows-standard-user] account=$env:COMPUTERNAME\$userName"
  $diagnosticsRoot = Join-Path $workspace "wework/test-results/desktop-e2e/windows-standard-user-$PID"
  New-Item -ItemType Directory -Path $diagnosticsRoot -Force | Out-Null
  $stdoutPath = Join-Path $diagnosticsRoot "runner.stdout.log"
  $stderrPath = Join-Path $diagnosticsRoot "runner.stderr.log"
  $process = Start-Process `
    -FilePath (Resolve-Path -LiteralPath $FilePath).Path `
    -ArgumentList $ArgumentList `
    -Credential $credential `
    -LoadUserProfile `
    -WorkingDirectory $workspace `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -NoNewWindow `
    -PassThru
  $stdoutReader = [IO.StreamReader]::new([IO.File]::Open(
    $stdoutPath, [IO.FileMode]::Open, [IO.FileAccess]::Read,
    [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
  ))
  $stderrReader = [IO.StreamReader]::new([IO.File]::Open(
    $stderrPath, [IO.FileMode]::Open, [IO.FileAccess]::Read,
    [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
  ))
  do {
    [Console]::Out.Write($stdoutReader.ReadToEnd())
    [Console]::Error.Write($stderrReader.ReadToEnd())
  } while (-not $process.WaitForExit(250))
  [Console]::Out.Write($stdoutReader.ReadToEnd())
  [Console]::Error.Write($stderrReader.ReadToEnd())
  exit $process.ExitCode
} finally {
  if ($stdoutReader) { $stdoutReader.Dispose() }
  if ($stderrReader) { $stderrReader.Dispose() }
  if ($userSid) {
    Get-CimInstance -ClassName Win32_UserProfile -ErrorAction SilentlyContinue |
      Where-Object { $_.SID -eq $userSid } |
      Remove-CimInstance -ErrorAction SilentlyContinue
  }
  Remove-LocalUser -Name $userName -ErrorAction SilentlyContinue
}
