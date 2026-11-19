param(
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [Parameter(Mandatory = $true)][string]$PidPath,
  [Parameter(Mandatory = $true)][string]$ResumePath
)

$ErrorActionPreference = 'Stop'
$launchTimer = [System.Diagnostics.Stopwatch]::StartNew()
function Write-LaunchStage([string]$stage) {
  [Console]::Error.WriteLine(
    '[desktop-e2e-windows-launch] stage={0} elapsedMs={1}', $stage, $launchTimer.ElapsedMilliseconds
  )
}
Write-LaunchStage 'wrapper-started'
$configuration = Get-Content -LiteralPath $ConfigPath -Raw -Encoding utf8 | ConvertFrom-Json
Write-LaunchStage 'compile-started'
Add-Type -Path (Join-Path $PSScriptRoot 'windows-owned-process.cs')
Write-LaunchStage 'compile-completed'
$applicationExit = [WeworkE2EOwnedProcess]::Run(
  $configuration.executable,
  $configuration.commandLine,
  $configuration.directory,
  $PidPath,
  $ResumePath,
  $configuration.ownerProcessId
)
exit $applicationExit
