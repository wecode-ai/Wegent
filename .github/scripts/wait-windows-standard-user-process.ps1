function Wait-LoggedProcess {
  param(
    [Parameter(Mandatory = $true)]
    [Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)]
    [string[]]$LogPaths,
    [Parameter(Mandatory = $true)]
    [ValidateRange(0.001, 2147483)]
    [double]$TimeoutSeconds
  )

  $elapsed = [Diagnostics.Stopwatch]::StartNew()
  $readers = @()
  try {
    foreach ($path in $LogPaths) {
      $readers += [IO.StreamReader]::new([IO.File]::Open(
        $path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite
      ))
    }
    do {
      $finished = $Process.WaitForExit(1000)
      foreach ($reader in $readers) {
        $output = $reader.ReadToEnd()
        if ($output) { Write-Host -NoNewline $output }
      }
      if (-not $finished -and $elapsed.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
        throw "Windows E2E process $($Process.Id) exceeded ${TimeoutSeconds}s; preserving logs before the CI deadline"
      }
    } while (-not $finished)
    $Process.WaitForExit()
    foreach ($reader in $readers) {
      $output = $reader.ReadToEnd()
      if ($output) { Write-Host -NoNewline $output }
    }
    return $Process.ExitCode
  } finally {
    foreach ($reader in $readers) { $reader.Dispose() }
    $elapsed.Stop()
  }
}
