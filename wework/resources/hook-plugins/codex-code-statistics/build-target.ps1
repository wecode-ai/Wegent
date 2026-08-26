param(
  [Parameter(Mandatory = $true)]
  [string]$RustTarget
)

$targets = @{
  'aarch64-pc-windows-msvc' = 'windows-aarch64'
  'x86_64-pc-windows-msvc' = 'windows-x86_64'
}
$pluginTarget = $targets[$RustTarget]
if (-not $pluginTarget) {
  throw "Unsupported Windows Rust target: $RustTarget"
}

$pluginDir = $PSScriptRoot
$bundleDir = Join-Path $pluginDir '../../bundled-hooks/codex-code-statistics'
cargo build --manifest-path "$pluginDir/Cargo.toml" --target-dir "$pluginDir/target" --release --locked --target $RustTarget
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$destination = "$bundleDir/bin/$pluginTarget"
New-Item -ItemType Directory -Force -Path $destination | Out-Null
Copy-Item "$pluginDir/target/$RustTarget/release/codex-code-statistics.exe" $destination
