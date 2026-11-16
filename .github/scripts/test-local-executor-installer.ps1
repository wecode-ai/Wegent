$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot '../../executor/scripts/local_executor_install.ps1'
$fixture = Join-Path $PSScriptRoot '../fixtures/executor-platform-releases.json'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($installer, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors) { throw ($parseErrors | Out-String) }
foreach ($name in @('Get-LatestPlatformVersion', 'Install-WegentExecutor')) {
    $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    if (-not $definition) { throw "Missing installer function $name" }
    Set-Item -Path "Function:\$name" -Value ($definition.Body.GetScriptBlock())
}

$GitHubRepo = 'wecode-ai/Wegent'
$BinaryName = 'wegent-executor.exe'
$InstallDir = Join-Path ([IO.Path]::GetTempPath()) ('wegent-installer-' + [guid]::NewGuid())
[IO.Directory]::CreateDirectory($InstallDir) | Out-Null
$releases = Get-Content -Raw $fixture | ConvertFrom-Json
$script:ApiRequests = [Collections.Generic.List[string]]::new()
$script:Downloads = [Collections.Generic.List[string]]::new()
$script:FailApi = $false
function Write-ColorOutput { param($Message, $Level) }
function Invoke-RestMethod {
    param($Uri, $Headers)
    if ($Headers.Accept -ne 'application/vnd.github+json') { throw 'Missing API accept header' }
    $script:ApiRequests.Add($Uri)
    if ($script:FailApi) { throw 'fixture network failure' }
    $page = [int]([regex]::Match($Uri, '[?&]page=(\d+)').Groups[1].Value)
    if ($page -gt $script:Pages.Count) { return @() }
    return $script:Pages[$page - 1]
}
function Invoke-WebRequest {
    param($Uri, $OutFile, [switch]$UseBasicParsing)
    $script:Downloads.Add($Uri)
    [IO.File]::WriteAllText($OutFile, 'unit download fixture')
}
function Reset-Requests {
    $script:ApiRequests.Clear()
    $script:Downloads.Clear()
    $script:Version = ''
    $script:FailApi = $false
}
function Assert-Failure {
    param([string]$Pattern)
    $failure = $null
    try { Install-WegentExecutor -Platform 'windows-amd64' } catch { $failure = $_ }
    if (-not $failure) { throw 'Installer accepted an invalid release catalog' }
    if ($failure.Exception.Message -notmatch $Pattern) { throw $failure }
    if ($script:Downloads.Count -ne 0) { throw 'Installer downloaded after a catalog failure' }
}

try {
    Reset-Requests
    $script:Pages = ,$releases
    Install-WegentExecutor -Platform 'windows-amd64'
    if ($script:Downloads[0] -ne 'https://github.com/wecode-ai/Wegent/releases/download/v2.0.25/wegent-executor-windows-amd64.exe') { throw 'Selected the wrong default release' }
    if ($script:ApiRequests.Count -ne 1) { throw 'Unexpected catalog request count' }

    Reset-Requests
    $padding = @(1..100 | ForEach-Object { $releases[0] })
    $script:Pages = @($padding, $releases)
    Install-WegentExecutor -Platform 'windows-amd64'
    if ($script:ApiRequests.Count -ne 2 -or $script:ApiRequests[1] -notmatch 'page=2$') { throw 'Installer did not paginate' }
    if ($script:Downloads[0] -notmatch '/download/v2\.0\.25/') { throw 'Wrong paginated release' }

    Reset-Requests
    $script:Version = 'v1.2.3'
    Install-WegentExecutor -Platform 'windows-amd64'
    if ($script:ApiRequests.Count -ne 0 -or $script:Downloads[0] -notmatch '/download/v1\.2\.3/') { throw 'Explicit release override was not preserved' }

    Reset-Requests
    $script:Pages = ,@($releases[0], $releases[1], $releases[2])
    Assert-Failure 'No stable Wegent platform release'

    Reset-Requests
    $missing = Get-Content -Raw $fixture | ConvertFrom-Json
    ($missing | Where-Object { $_.tag_name -eq 'v2.0.25' }).assets = @()
    $script:Pages = ,$missing
    Assert-Failure 'v2\.0\.25 has no wegent-executor-windows-amd64.exe'

    Reset-Requests
    $script:FailApi = $true
    $script:Pages = ,$releases
    Assert-Failure 'fixture network failure'
    Write-Host 'Windows installer release metadata checks passed'
} finally {
    Remove-Item -Recurse -Force $InstallDir
}
