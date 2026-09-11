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
    -Wait `
    -PassThru
  exit $process.ExitCode
} finally {
  if ($userSid) {
    Get-CimInstance -ClassName Win32_UserProfile -ErrorAction SilentlyContinue |
      Where-Object { $_.SID -eq $userSid } |
      Remove-CimInstance -ErrorAction SilentlyContinue
  }
  Remove-LocalUser -Name $userName -ErrorAction SilentlyContinue
}
