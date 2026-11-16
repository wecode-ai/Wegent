$ErrorActionPreference = "Stop"

# The desktop suites exercise the full 1440x960 workbench, like the Linux runner.
# A default 1024x768 Windows display silently clamps Electron's requested bounds.
Set-DisplayResolution -Width 1920 -Height 1080 -Force
Add-Type -AssemblyName System.Windows.Forms
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
Write-Host "[windows-e2e-display] work-area=$($bounds.Width)x$($bounds.Height)"
if ($bounds.Width -lt 1440 -or $bounds.Height -lt 960) {
  throw "Windows desktop E2E requires a working area of at least 1440x960"
}
