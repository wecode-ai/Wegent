# Wework Windows desktop startup script. Mirrors scripts/dev-mac-app.sh.

$ErrorActionPreference = 'Stop'

$SCRIPT_DIR = $PSScriptRoot
$WEWORK_DIR = (Resolve-Path (Join-Path $SCRIPT_DIR '..')).Path
$PROJECT_DIR = (Resolve-Path (Join-Path $WEWORK_DIR '..')).Path
$ENV_FILE = Join-Path $PROJECT_DIR '.env'
$EXECUTOR_ISOLATION = $false
$ELECTRON_ARGS = @()
$ISOLATED_EXECUTOR_HOME = ''
$MANAGED_SOURCE_EXECUTOR = $false
$MANAGED_DWS_BINARY = $false
$MANAGED_HARNESS_RUNTIME = $false
$MANAGED_SOURCE_EXECUTOR_BINARY = ''
$EXECUTOR_BINARY_TEMP = ''
$WATCH_PROCESS = $null
$WATCH_READY_FILE = ''

function Show-Usage {
  @'
Usage: pwsh -File wework/scripts/dev-windows-app.ps1 [options] [-- electron-options]

Options:
  --executor-isolation      Use a temporary Executor Home for this launch.
  --shared-executor-home    Use the release app's Executor Home (default).
  --no-executor-isolation   Alias for --shared-executor-home.
  -h, --help                Show this help message.

Environment:
  VITE_WEGENT_BACKEND_URL          Backend URL. Defaults to WEWORK_HOST/BACKEND_PORT.
  WEWORK_DEV_USER_DATA_DIR         Override Electron user data for this launch.
  WEWORK_DEV_APP_IDENTIFIER        Override the application identity for this launch.
  WEWORK_DEV_EXECUTOR_PATH         Executor command. Defaults to the source sidecar.
  WEWORK_DEV_CACHE_ROOT            Shared immutable dev cache. Defaults to
                                   %LOCALAPPDATA%\wegent\wework-dev.
  WEWORK_DEV_HARNESS_RUNTIME_ROOT  Harness runtime. Defaults to the worktree runtime.
  WEWORK_DEV_COMPONENT_RESOURCES   Component links. Defaults to the worktree dependency cache.
  WEWORK_DEV_CODEX_BINARY          Codex binary. Defaults to the repository-locked binary.
  WEWORK_DEV_DWS_BINARY            DWS binary. Defaults to the repository-prepared binary.
  WEWORK_HARNESS_RUNTIME_ASSET_CACHE_ROOT
                                   Harness runtime asset cache root. Defaults to
                                   %LOCALAPPDATA%\wegent\wework-dev\harness-runtime.
  CARGO_TARGET_DIR                 Explicit Cargo target directory. Overrides auto cache.
  WEGENT_CARGO_TARGET_ROOT         Root containing shared Cargo targets.
  WEGENT_DISABLE_SHARED_CARGO_TARGET
                                   Set to 1 to keep Cargo's default per-worktree target.
  WEGENT_DISABLE_SCCACHE           Set to 1 to disable automatic sccache detection.
  WEWORK_DRY_RUN=1                 Print the resolved launch configuration without starting.
'@
}

function Fail([string]$Message) {
  Write-Error $Message
  exit 1
}

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Fail "Error: required command is unavailable: $Name"
  }
}

function Get-GitBranchName {
  $branch = git -C $PROJECT_DIR branch --show-current 2>$null
  if ($LASTEXITCODE -eq 0 -and $branch) {
    return $branch.Trim()
  }
  return ''
}

function Get-DevTitle {
  if ($env:WEWORK_PARENT_TITLE) {
    return $env:WEWORK_PARENT_TITLE
  }
  if ($env:WEWORK_DEV_BRANCH) {
    return $env:WEWORK_DEV_BRANCH
  }
  return Split-Path $PROJECT_DIR -Leaf
}

function Get-DevIdentityFields {
  $identityPath = Join-Path $SCRIPT_DIR 'resolve-dev-instance-identity.mjs'
  $output = & node $identityPath $PROJECT_DIR $env:WEWORK_DEV_BRANCH
  if ($LASTEXITCODE -ne 0 -or -not $output) {
    return @()
  }
  return @($output -split "`r?`n")
}

function Get-DevUserDataDirectory {
  $resolverPath = Join-Path $SCRIPT_DIR 'resolve-dev-user-data.mjs'
  $output = & node $resolverPath $PROJECT_DIR $env:WEWORK_DEV_USER_DATA_DIR
  if ($LASTEXITCODE -ne 0) {
    return ''
  }
  return "$output".Trim()
}

function Get-WindowsTarget {
  return 'x86_64-pc-windows-msvc'
}

function Get-WindowsLocalIPv4 {
  $defaultRoute = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
    Sort-Object RouteMetric, InterfaceMetric |
    Select-Object -First 1
  if ($defaultRoute) {
    $address = Get-NetIPAddress -InterfaceIndex $defaultRoute.InterfaceIndex `
      -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -notlike '169.254.*' } |
      Select-Object -First 1
    if ($address) {
      return $address.IPAddress
    }
  }
  return '127.0.0.1'
}

function Get-BackendBaseUrl {
  $hostName = if ($env:WEWORK_HOST) { $env:WEWORK_HOST } else { Get-WindowsLocalIPv4 }
  $port = if ($env:BACKEND_PORT) { $env:BACKEND_PORT } else { '9100' }
  return "http://$hostName`:$port"
}

function Get-CargoCacheCandidates([string]$CacheName) {
  if ($env:WEGENT_CARGO_TARGET_ROOT) {
    return @((Join-Path ($env:WEGENT_CARGO_TARGET_ROOT.TrimEnd('\')) $CacheName))
  }

  $candidates = @()
  if ($env:LOCALAPPDATA) {
    $candidates += Join-Path $env:LOCALAPPDATA "wegent\cargo-target\$CacheName"
  }
  if ($env:USERPROFILE) {
    $candidates += Join-Path $env:USERPROFILE ".cache\wegent\cargo-target\$CacheName"
  } elseif ($env:HOME) {
    $candidates += Join-Path $env:HOME ".cache\wegent\cargo-target\$CacheName"
  }

  # Fall back to other drives when C: is low on space.
  foreach ($drive in @('D:', 'E:', 'F:', 'G:', 'H:')) {
    $candidates += [System.IO.Path]::Combine($drive, "wegent\cargo-target\$CacheName")
  }

  return $candidates
}

function Test-DriveFreeSpace([string]$Path, [long]$MinFreeBytes = 10GB) {
  try {
    return [System.IO.DriveInfo]::GetDriveInfo($Path).AvailableFreeSpace -ge $MinFreeBytes
  } catch {
    return $false
  }
}

function Select-BestCacheDir([string[]]$Candidates) {
  # Prefer a cache that already exists so we do not rebuild dependencies from
  # scratch across low-space migrations.
  foreach ($candidate in $Candidates) {
    $entries = @(Get-ChildItem -LiteralPath $candidate -Force -ErrorAction SilentlyContinue)
    if ($entries.Count -gt 0) {
      return $candidate
    }
  }

  # Otherwise pick the first drive with enough free space.
  foreach ($candidate in $Candidates) {
    try {
      New-Item -ItemType Directory -Force -Path $candidate | Out-Null
      if (Test-DriveFreeSpace $candidate) {
        return $candidate
      }
    } catch {
      # Ignore drives that cannot be created or queried.
    }
  }

  # Last resort: use the first candidate even if it is low on space.
  if ($Candidates.Count -gt 0) {
    New-Item -ItemType Directory -Force -Path $Candidates[0] | Out-Null
    return $Candidates[0]
  }
  return $null
}

function Get-SccachePath {
  $command = Get-Command sccache -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }
  return ''
}

function Configure-Sccache([string]$ProjectDir, [string]$TargetDir) {
  if ($env:WEGENT_DISABLE_SCCACHE -eq '1') {
    return
  }
  if ($env:RUSTC_WRAPPER -and $env:WEGENT_SCCACHE_AUTO -ne '1') {
    return
  }
  $sccache = Get-SccachePath
  if (-not $sccache) {
    return
  }
  $env:RUSTC_WRAPPER = $sccache
  $env:CARGO_INCREMENTAL = '0'
  $env:WEGENT_SCCACHE_AUTO = '1'
  if (-not $env:SCCACHE_BASEDIRS -or $env:WEGENT_SCCACHE_BASEDIRS_AUTO -eq '1') {
    $env:SCCACHE_BASEDIRS = "$ProjectDir;$TargetDir"
    $env:WEGENT_SCCACHE_BASEDIRS_AUTO = '1'
  }
}

function Get-ExecutorBinaryPath {
  if ($env:CARGO_TARGET_DIR) {
    return Join-Path $env:CARGO_TARGET_DIR 'debug\wegent-executor.exe'
  }
  return Join-Path $PROJECT_DIR 'executor\target\debug\wegent-executor.exe'
}

function Start-PrepareStep([string]$Name, [string]$Command) {
  $stdout = Join-Path $env:TEMP "wework-dev-$Name-$PID.out.log"
  $stderr = Join-Path $env:TEMP "wework-dev-$Name-$PID.err.log"
  $process = Start-Process -FilePath 'pwsh.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $Command) -WorkingDirectory $WEWORK_DIR -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
  return [pscustomobject]@{ Name = $Name; Process = $process; Stdout = $stdout; Stderr = $stderr }
}

function Wait-PrepareStep($Job) {
  if (-not $Job) {
    return
  }
  $Job.Process.WaitForExit()
  if ($Job.Process.ExitCode -ne 0) {
    Write-Host "  prepare $($Job.Name) failed; last output:"
    Get-Content -LiteralPath $Job.Stderr -Tail 30 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" }
    Get-Content -LiteralPath $Job.Stdout -Tail 10 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" }
    Fail "Error: failed to prepare $($Job.Name)."
  }
}

$index = 0
while ($index -lt $args.Count) {
  switch ($args[$index]) {
    '--executor-isolation' {
      $EXECUTOR_ISOLATION = $true
    }
    '--shared-executor-home' {
      $EXECUTOR_ISOLATION = $false
    }
    '--no-executor-isolation' {
      $EXECUTOR_ISOLATION = $false
    }
    '-h' {
      Show-Usage
      exit 0
    }
    '--help' {
      Show-Usage
      exit 0
    }
    '--' {
      if ($index + 1 -lt $args.Count) {
        $ELECTRON_ARGS = $args[($index + 1)..($args.Count - 1)]
      }
      $index = $args.Count
      continue
    }
    default {
      Write-Error "Error: unknown option: $($args[$index])"
      Show-Usage
      exit 1
    }
  }
  $index += 1
}

if ($env:OS -ne 'Windows_NT') {
  Fail 'Error: dev-windows-app.ps1 only supports Windows.'
}

$REQUESTED_EXECUTOR_ISOLATION = $EXECUTOR_ISOLATION
if (Test-Path $ENV_FILE) {
  Get-Content $ENV_FILE | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
      $name = $matches[1]
      $value = $matches[2].Trim('"', "'")
      [System.Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
  }
}
$EXECUTOR_ISOLATION = $REQUESTED_EXECUTOR_ISOLATION

Require-Command git
Require-Command node
Require-Command pnpm
Require-Command cargo

$WINDOWS_TARGET = Get-WindowsTarget
$env:WEWORK_DEV_WORKTREE = $PROJECT_DIR
$env:WEWORK_DEV_BRANCH = Get-GitBranchName
$DEV_IDENTITY_FIELDS = Get-DevIdentityFields
if ($DEV_IDENTITY_FIELDS.Count -ne 6) {
  Fail 'Error: failed to resolve the development instance identity.'
}
$env:WEWORK_PARENT_TITLE = $DEV_IDENTITY_FIELDS[0]
$env:WEWORK_DEV_TITLE = $DEV_IDENTITY_FIELDS[1]
$env:WEWORK_DEV_INSTANCE_ID = $DEV_IDENTITY_FIELDS[2]
$env:WEWORK_DEV_INSTANCE_LABEL = $DEV_IDENTITY_FIELDS[3]
$env:WEWORK_DEV_DOCK_TITLE = $DEV_IDENTITY_FIELDS[4]
$env:WEWORK_DEV_EXECUTABLE_NAME = $DEV_IDENTITY_FIELDS[5]
$env:WEWORK_APP_IDENTIFIER = if ($env:WEWORK_DEV_APP_IDENTIFIER) {
  $env:WEWORK_DEV_APP_IDENTIFIER
} else {
  "io.wecode.wework.dev.$env:WEWORK_DEV_INSTANCE_ID"
}
$USER_DATA_OUTPUT = Get-DevUserDataDirectory
if (-not $USER_DATA_OUTPUT) {
  Fail 'Error: failed to resolve the development user data directory.'
}
$env:WEWORK_USER_DATA_DIR = $USER_DATA_OUTPUT
Remove-Item Env:WEWORK_DEV_APP_IDENTIFIER -ErrorAction SilentlyContinue
Remove-Item Env:WEWORK_DEV_USER_DATA_DIR -ErrorAction SilentlyContinue
$env:VITE_WEWORK_DEV_TITLE = $env:WEWORK_DEV_TITLE
$env:VITE_WEWORK_DEV_WORKTREE = $env:WEWORK_DEV_WORKTREE
$env:VITE_WEWORK_DEV_BRANCH = $env:WEWORK_DEV_BRANCH
$env:VITE_WEWORK_PARENT_TITLE = if ($env:WEWORK_PARENT_TITLE) { $env:WEWORK_PARENT_TITLE } else { '' }
$env:VITE_WEWORK_PARENT_PROJECT = if ($env:WEWORK_PARENT_PROJECT) { $env:WEWORK_PARENT_PROJECT } else { '' }
$env:VITE_WEWORK_PARENT_WORKSPACE = if ($env:WEWORK_PARENT_WORKSPACE) { $env:WEWORK_PARENT_WORKSPACE } else { '' }
$env:VITE_WEGENT_BACKEND_URL = if ($env:VITE_WEGENT_BACKEND_URL) { $env:VITE_WEGENT_BACKEND_URL } else { Get-BackendBaseUrl }
$env:VITE_WEWORK_RELEASE_CHANNEL = if ($env:VITE_WEWORK_RELEASE_CHANNEL) { $env:VITE_WEWORK_RELEASE_CHANNEL } else { 'development' }
$env:VITE_WEWORK_RUNTIME_MODE = if ($env:VITE_WEWORK_RUNTIME_MODE) { $env:VITE_WEWORK_RUNTIME_MODE } else { 'local-first' }
$env:ELECTRON_GET_USE_PROXY = if ($env:ELECTRON_GET_USE_PROXY) { $env:ELECTRON_GET_USE_PROXY } else { 'true' }

Remove-Item Env:WEGENT_EXECUTOR_BINARY -ErrorAction SilentlyContinue
if ($env:WEWORK_DEV_EXECUTOR_PATH) {
  $env:WEWORK_EXECUTOR_PATH = $env:WEWORK_DEV_EXECUTOR_PATH
} else {
  $env:WEWORK_EXECUTOR_PATH = Join-Path $SCRIPT_DIR 'dev-executor-sidecar.cmd'
  $MANAGED_SOURCE_EXECUTOR = $true
  if (-not $env:WEGENT_DISABLE_SHARED_CARGO_TARGET -and -not $env:CARGO_TARGET_DIR) {
    $cacheRoot = Select-BestCacheDir (Get-CargoCacheCandidates 'executor-dev')
    if ($cacheRoot) {
      $env:CARGO_TARGET_DIR = $cacheRoot
    }
  }
  if ($env:CARGO_TARGET_DIR) {
    New-Item -ItemType Directory -Force -Path $env:CARGO_TARGET_DIR | Out-Null
    Configure-Sccache $PROJECT_DIR $env:CARGO_TARGET_DIR
  }
  $MANAGED_SOURCE_EXECUTOR_BINARY = Get-ExecutorBinaryPath
  $env:WEGENT_EXECUTOR_BINARY = Join-Path $WEWORK_DIR 'node_modules\.cache\wework-executor-dev\wegent-executor.exe'
  $env:WEGENT_EXECUTOR_DEV_BUILD_ID = $env:WEWORK_DEV_INSTANCE_ID
}

$DEV_CACHE_ROOT = if ($env:WEWORK_DEV_CACHE_ROOT) {
  $env:WEWORK_DEV_CACHE_ROOT.TrimEnd('\')
} elseif ($env:LOCALAPPDATA) {
  Join-Path $env:LOCALAPPDATA 'wegent\wework-dev'
} elseif ($env:USERPROFILE) {
  Join-Path $env:USERPROFILE '.cache\wegent\wework-dev'
} else {
  Join-Path $WEWORK_DIR 'node_modules\.cache\wework-dev'
}
$env:WEWORK_HARNESS_RUNTIME_ASSET_CACHE_ROOT = if ($env:WEWORK_HARNESS_RUNTIME_ASSET_CACHE_ROOT) {
  $env:WEWORK_HARNESS_RUNTIME_ASSET_CACHE_ROOT.TrimEnd('\')
} else {
  Join-Path $DEV_CACHE_ROOT 'harness-runtime'
}
if ($env:WEWORK_DEV_HARNESS_RUNTIME_ROOT) {
  $env:WEWORK_HARNESS_RUNTIME_ROOT = $env:WEWORK_DEV_HARNESS_RUNTIME_ROOT
} else {
  $env:WEWORK_HARNESS_RUNTIME_ROOT = Join-Path $WEWORK_DIR 'node_modules\.cache\harness-runtime-dev'
  $MANAGED_HARNESS_RUNTIME = $true
}
$env:WEWORK_COMPONENT_RESOURCES_ROOT = if ($env:WEWORK_DEV_COMPONENT_RESOURCES) {
  $env:WEWORK_DEV_COMPONENT_RESOURCES
} else {
  Join-Path $WEWORK_DIR 'node_modules\.cache\wework-electron-dev-resources'
}
$env:WEWORK_CORE_PLUGIN_ROOT = Join-Path $env:WEWORK_COMPONENT_RESOURCES_ROOT 'wework-core-plugins'
# Serve the freshly built Wework app and auto-reload when it changes, matching
# dev-mac-app.sh. Dev loads the UI plugin from the packaged core plugin root,
# which the dev flow does not rebuild; pointing the plugin at the current Vite
# output keeps the running desktop app in sync with the source tree.
$env:WEWORK_APP_HOT_RELOAD = '1'
$env:WEWORK_APP_WEB_ROOT = Join-Path $WEWORK_DIR 'dsh\app-wework\web'

if ($env:WEWORK_DEV_CODEX_BINARY) {
  $env:CODEX_BINARY_PATH = $env:WEWORK_DEV_CODEX_BINARY
} else {
  $env:CODEX_BINARY_PATH = Join-Path $WEWORK_DIR "resources\binaries\codex\$WINDOWS_TARGET\vendor\$WINDOWS_TARGET\bin\codex.exe"
}
if ($env:WEWORK_DEV_DWS_BINARY) {
  $env:DWS_BINARY_PATH = $env:WEWORK_DEV_DWS_BINARY
} else {
  $env:DWS_BINARY_PATH = Join-Path $WEWORK_DIR "resources\binaries\dws-$WINDOWS_TARGET.exe"
  $MANAGED_DWS_BINARY = $true
}

if ($EXECUTOR_ISOLATION) {
  $ISOLATED_EXECUTOR_HOME = Join-Path ([System.IO.Path]::GetTempPath()) ("wework-dev-executor-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $ISOLATED_EXECUTOR_HOME | Out-Null
  $env:WEGENT_EXECUTOR_HOME = $ISOLATED_EXECUTOR_HOME
}

function Print-Configuration {
  Write-Host 'Starting Wework Windows app'
  Write-Host "  WEWORK_DEV_TITLE=$env:WEWORK_DEV_TITLE"
  Write-Host "  WEWORK_DEV_WORKTREE=$env:WEWORK_DEV_WORKTREE"
  Write-Host "  WEWORK_DEV_BRANCH=$(if ($env:WEWORK_DEV_BRANCH) { $env:WEWORK_DEV_BRANCH } else { '<detached>' })"
  Write-Host "  WEWORK_DEV_INSTANCE_LABEL=$env:WEWORK_DEV_INSTANCE_LABEL"
  Write-Host "  WEWORK_DEV_DOCK_TITLE=$env:WEWORK_DEV_DOCK_TITLE"
  Write-Host "  WEWORK_DEV_EXECUTABLE_NAME=$env:WEWORK_DEV_EXECUTABLE_NAME"
  Write-Host "  WEWORK_APP_IDENTIFIER=$env:WEWORK_APP_IDENTIFIER"
  Write-Host "  WEWORK_USER_DATA_DIR=$env:WEWORK_USER_DATA_DIR"
  Write-Host "  VITE_WEGENT_BACKEND_URL=$env:VITE_WEGENT_BACKEND_URL"
  Write-Host "  WEWORK_EXECUTOR_PATH=$env:WEWORK_EXECUTOR_PATH"
  Write-Host "  WEGENT_EXECUTOR_BINARY=$(if ($env:WEGENT_EXECUTOR_BINARY) { $env:WEGENT_EXECUTOR_BINARY } else { '<managed by command>' })"
  Write-Host "  WEGENT_EXECUTOR_HOME=$(if ($env:WEGENT_EXECUTOR_HOME) { $env:WEGENT_EXECUTOR_HOME } else { '<release app default>' })"
  Write-Host "  CARGO_TARGET_DIR=$env:CARGO_TARGET_DIR"
  Write-Host "  RUSTC_WRAPPER=$env:RUSTC_WRAPPER"
  Write-Host "  WEWORK_HARNESS_RUNTIME_ASSET_CACHE_ROOT=$env:WEWORK_HARNESS_RUNTIME_ASSET_CACHE_ROOT"
  Write-Host "  WEWORK_HARNESS_RUNTIME_ROOT=$env:WEWORK_HARNESS_RUNTIME_ROOT"
  Write-Host "  WEWORK_COMPONENT_RESOURCES_ROOT=$env:WEWORK_COMPONENT_RESOURCES_ROOT"
  Write-Host "  WEWORK_CORE_PLUGIN_ROOT=$env:WEWORK_CORE_PLUGIN_ROOT"
  Write-Host "  WEWORK_APP_HOT_RELOAD=$env:WEWORK_APP_HOT_RELOAD"
  Write-Host "  WEWORK_APP_WEB_ROOT=$env:WEWORK_APP_WEB_ROOT"
  Write-Host "  CODEX_BINARY_PATH=$env:CODEX_BINARY_PATH"
  Write-Host "  DWS_BINARY_PATH=$env:DWS_BINARY_PATH"
}

Print-Configuration
if ($env:WEWORK_DRY_RUN -eq '1') {
  exit 0
}

try {
  Push-Location $WEWORK_DIR
  try {
    node (Join-Path $SCRIPT_DIR 'prepare-dev-dependencies.mjs')
    if ($LASTEXITCODE -ne 0) {
      Fail 'Error: failed to prepare development dependencies.'
    }
    New-Item -ItemType Directory -Force -Path 'electron\resources' | Out-Null
    foreach ($resource in @('icons', 'bundled-plugins')) {
      $target = Join-Path $WEWORK_DIR "resources\$resource"
      $link = Join-Path $WEWORK_DIR "electron\resources\$resource"
      if (-not (Test-Path $link)) {
        New-Item -ItemType Junction -Path $link -Target $target | Out-Null
      }
    }
    if (-not (Test-Path 'electron\resources\icons\32x32.png')) {
      Fail 'Error: Electron development icons are unavailable.'
    }
    if (-not (Test-Path 'electron\resources\bundled-plugins\wework-personal\.agents\plugins\marketplace.json')) {
      Fail 'Error: Electron bundled plugins are unavailable.'
    }
    $prepareJobs = @()
    if (-not $env:WEWORK_DEV_CODEX_BINARY) {
      $env:WEWORK_CODEX_TARGET = $WINDOWS_TARGET
      $prepareJobs += Start-PrepareStep 'codex' 'node scripts/prepare-codex-binary.mjs'
    }
    if ($MANAGED_DWS_BINARY) {
      $env:WEWORK_DWS_TARGET = $WINDOWS_TARGET
      $prepareJobs += Start-PrepareStep 'dws' 'node scripts/prepare-dws-binary.mjs'
    }
    if ($MANAGED_HARNESS_RUNTIME) {
      $prepareJobs += Start-PrepareStep 'harness-runtime' 'node scripts/prepare-harness-runtime.mjs --materialize'
    }
    foreach ($job in $prepareJobs) {
      Wait-PrepareStep $job
      Write-Host "Prepared $($job.Name)"
    }
    if ($MANAGED_SOURCE_EXECUTOR) {
      cargo build --manifest-path (Join-Path $PROJECT_DIR 'executor\Cargo.toml') --bin wegent-executor
      if ($LASTEXITCODE -ne 0) {
        Fail 'Error: failed to build the wegent executor.'
      }
      New-Item -ItemType Directory -Force -Path (Split-Path $env:WEGENT_EXECUTOR_BINARY -Parent) | Out-Null
      $EXECUTOR_BINARY_TEMP = "$($env:WEGENT_EXECUTOR_BINARY).tmp.$PID"
      Copy-Item -LiteralPath $MANAGED_SOURCE_EXECUTOR_BINARY -Destination $EXECUTOR_BINARY_TEMP -Force
      Move-Item -LiteralPath $EXECUTOR_BINARY_TEMP -Destination $env:WEGENT_EXECUTOR_BINARY -Force
      $EXECUTOR_BINARY_TEMP = ''
    }
    if (-not (Test-Path $env:WEWORK_EXECUTOR_PATH)) {
      Fail "Error: Executor command is not available: $env:WEWORK_EXECUTOR_PATH"
    }
    if (-not (Test-Path $env:CODEX_BINARY_PATH)) {
      Fail "Error: Codex binary is not available: $env:CODEX_BINARY_PATH"
    }
    if (-not (Test-Path $env:DWS_BINARY_PATH)) {
      Fail "Error: DWS binary is not available: $env:DWS_BINARY_PATH"
    }
    node (Join-Path $SCRIPT_DIR 'prepare-dev-component-resources.mjs')
    if ($LASTEXITCODE -ne 0) {
      Fail 'Error: failed to prepare development component resources.'
    }
    $componentsManifest = Get-Content -LiteralPath (Join-Path $env:WEWORK_COMPONENT_RESOURCES_ROOT 'components.json') -Raw | ConvertFrom-Json
    $env:WEWORK_CORE_PLUGINS_SHA256 = $componentsManifest.components.weworkCorePlugins.sha256
    if (-not $env:WEWORK_CORE_PLUGINS_SHA256) {
      Fail 'Error: Failed to read core plugin checksum from component resources.'
    }
    $WATCH_READY_FILE = Join-Path $env:TEMP ("wework-app-watch-" + [guid]::NewGuid().ToString('N') + ".ready")
    $WATCH_OUT_LOG = Join-Path $env:TEMP "wework-app-watch-$PID.out.log"
    $WATCH_ERR_LOG = Join-Path $env:TEMP "wework-app-watch-$PID.err.log"
    $env:WEWORK_APP_WATCH_READY_FILE = $WATCH_READY_FILE
    $nodePath = (Get-Command node -ErrorAction Stop).Source
    $WATCH_PROCESS = Start-Process -FilePath $nodePath -ArgumentList @(Join-Path $SCRIPT_DIR 'dev-wework-app-watch.mjs') -WorkingDirectory $WEWORK_DIR -WindowStyle Hidden -RedirectStandardOutput $WATCH_OUT_LOG -RedirectStandardError $WATCH_ERR_LOG -PassThru
    $watchDeadline = (Get-Date).AddSeconds(90)
    $watchReady = $false
    while ((Get-Date) -lt $watchDeadline) {
      if ($WATCH_PROCESS.HasExited) {
        Get-Content -LiteralPath $WATCH_ERR_LOG -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" }
        Fail 'Error: Wework application build watcher exited before becoming ready.'
      }
      if ((Test-Path $WATCH_READY_FILE) -and [bool](Get-Content -LiteralPath $WATCH_READY_FILE -Raw -ErrorAction SilentlyContinue)) {
        $watchReady = $true
        break
      }
      Start-Sleep -Milliseconds 250
    }
    if (-not $watchReady) {
      Get-Content -LiteralPath $WATCH_ERR_LOG -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" }
      Fail 'Error: Wework application build watcher did not become ready.'
    }
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Remove-Item Env:WEWORK_NODE_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:WEWORK_NODE_RUNTIME_KIND -ErrorAction SilentlyContinue
    pnpm --dir electron run build
    if ($LASTEXITCODE -ne 0) {
      Fail 'Error: failed to build the Electron application.'
    }
    $ELECTRON_BINARY = Join-Path $WEWORK_DIR 'electron\node_modules\electron\dist\electron.exe'
    if ($ELECTRON_ARGS.Count -gt 0) {
      & $ELECTRON_BINARY (Join-Path $WEWORK_DIR 'electron') @ELECTRON_ARGS
    } else {
      & $ELECTRON_BINARY (Join-Path $WEWORK_DIR 'electron')
    }
    if ($LASTEXITCODE -ne 0) {
      exit $LASTEXITCODE
    }
  } finally {
    Pop-Location
  }
} finally {
  if ($WATCH_PROCESS -and -not $WATCH_PROCESS.HasExited) {
    Stop-Process -Id $WATCH_PROCESS.Id -Force -ErrorAction SilentlyContinue
  }
  if ($WATCH_READY_FILE -and (Test-Path $WATCH_READY_FILE)) {
    Remove-Item -LiteralPath $WATCH_READY_FILE -Force -ErrorAction SilentlyContinue
  }
  if ($ISOLATED_EXECUTOR_HOME) {
    Remove-Item -LiteralPath $ISOLATED_EXECUTOR_HOME -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($EXECUTOR_BINARY_TEMP -and (Test-Path $EXECUTOR_BINARY_TEMP)) {
    Remove-Item -LiteralPath $EXECUTOR_BINARY_TEMP -Force -ErrorAction SilentlyContinue
  }
}
