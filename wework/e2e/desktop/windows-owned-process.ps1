param(
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [Parameter(Mandatory = $true)][string]$PidPath,
  [Parameter(Mandatory = $true)][string]$ResumePath
)

$ErrorActionPreference = 'Stop'
$configuration = Get-Content -LiteralPath $ConfigPath -Raw -Encoding utf8 | ConvertFrom-Json
Add-Type -Path (Join-Path $PSScriptRoot 'windows-owned-process.cs')
$applicationExit = [WeworkE2EOwnedProcess]::Run(
  $configuration.executable,
  $configuration.commandLine,
  $configuration.directory,
  $PidPath,
  $ResumePath,
  $configuration.ownerProcessId
)
exit $applicationExit
