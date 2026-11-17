$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "wait-windows-standard-user-process.ps1")

$directory = Join-Path ([IO.Path]::GetTempPath()) "wework-process-wait-$PID"
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$node = (Get-Command node).Source
$process = $null
try {
  foreach ($hang in @($false, $true)) {
    $script = Join-Path $directory "child.js"
    $stdout = Join-Path $directory "stdout.log"
    $stderr = Join-Path $directory "stderr.log"
    $ending = if ($hang) { 'setInterval(() => {}, 1000)' } else { 'process.exitCode = 7' }
    "console.log('retained stdout'); console.error('retained stderr'); $ending" |
      Set-Content -LiteralPath $script
    $process = Start-Process -FilePath $node -ArgumentList "`"$script`"" `
      -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $expired = $false
    $exitCode = $null
    try {
      $exitCode = Wait-LoggedProcess -Process $process `
        -LogPaths @($stdout, $stderr) -TimeoutSeconds 2
    } catch {
      if (-not $hang -or $_.Exception.Message -notmatch 'exceeded 2s') { throw }
      $expired = $true
    }
    if ($hang -ne $expired) { throw "The process deadline was not enforced" }
    if (-not $hang -and $exitCode -ne 7) { throw "The child failure exit code was lost" }
    if ((Get-Content -LiteralPath $stdout -Raw) -notmatch 'retained stdout') {
      throw "The child stdout evidence was lost"
    }
    if ((Get-Content -LiteralPath $stderr -Raw) -notmatch 'retained stderr') {
      throw "The child stderr evidence was lost"
    }
    if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
    $process.Dispose()
    $process = $null
  }
  Write-Host "Windows process deadline, failure exit, and retained logs verified"
} finally {
  if ($process -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
  if ($process) { $process.Dispose() }
  Remove-Item -LiteralPath $directory -Recurse -Force
}
