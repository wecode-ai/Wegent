#Requires -Version 5.1
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
#
# Wegent Executor Installation Script for Windows
#
# Usage:
#   irm https://github.com/wecode-ai/Wegent/releases/latest/download/local_executor_install.ps1 | iex
#
# Or with a specific version:
#   $env:WEGENT_VERSION='v1.0.0'; irm https://github.com/wecode-ai/Wegent/releases/latest/download/local_executor_install.ps1 | iex

[CmdletBinding()]
param(
    [string]$Version = $env:WEGENT_VERSION
)

$ErrorActionPreference = 'Stop'

# Configuration
$GitHubRepo = "wecode-ai/Wegent"
$InstallDir = "$env:LOCALAPPDATA\Wegent\bin"
$BinaryName = "wegent-executor.exe"
$MinNodeVersion = 18
$MinClaudeCodeVersion = "2.1.0"

# Print colored message
function Write-ColorOutput {
    param(
        [string]$Message,
        [string]$Level = "INFO"
    )
    switch ($Level) {
        "INFO"    { Write-Host "[$Level] $Message" -ForegroundColor Blue }
        "SUCCESS" { Write-Host "[$Level] $Message" -ForegroundColor Green }
        "WARNING" { Write-Host "[$Level] $Message" -ForegroundColor Yellow }
        "ERROR"   { Write-Host "[$Level] $Message" -ForegroundColor Red }
    }
}

# Compare semantic versions
# Returns $true if Version1 >= Version2
function Compare-SemanticVersion {
    param(
        [string]$Version1,
        [string]$Version2
    )

    # Remove 'v' prefix and any suffix after dash
    $v1Clean = ($Version1 -replace '^v', '') -replace '-.*$', ''
    $v2Clean = ($Version2 -replace '^v', '') -replace '-.*$', ''

    try {
        $v1 = [version]$v1Clean
        $v2 = [version]$v2Clean
        return $v1 -ge $v2
    }
    catch {
        # Fallback to string comparison for non-standard versions
        return $v1Clean -ge $v2Clean
    }
}

# Check Node.js installation
function Test-NodeJS {
    Write-ColorOutput "Checking Node.js installation..." "INFO"

    try {
        $nodeVersion = & node --version 2>$null
        if (-not $nodeVersion) {
            throw "Node.js not found"
        }

        # Extract major version number
        $nodeMajor = [int]($nodeVersion -replace '^v(\d+)\..*', '$1')

        if ($nodeMajor -lt $MinNodeVersion) {
            Write-ColorOutput "Node.js version $nodeVersion is too old. Requires v$MinNodeVersion+" "ERROR"
            Write-ColorOutput "Please install Node.js from https://nodejs.org/" "INFO"
            exit 1
        }

        Write-ColorOutput "Node.js found: $nodeVersion" "SUCCESS"
    }
    catch {
        Write-ColorOutput "Node.js is not installed." "ERROR"
        Write-ColorOutput "Claude Code requires Node.js $MinNodeVersion+ to run." "ERROR"
        Write-Host ""
        Write-ColorOutput "Please install Node.js from:" "INFO"
        Write-Host "  - https://nodejs.org/"
        Write-Host "  - Or use winget: winget install OpenJS.NodeJS.LTS"
        Write-Host "  - Or use chocolatey: choco install nodejs-lts"
        Write-Host ""
        exit 1
    }
}

# Check npm availability
function Test-Npm {
    try {
        $null = & npm --version 2>$null
        if (-not $?) {
            throw "npm not found"
        }
    }
    catch {
        Write-ColorOutput "npm is not installed." "ERROR"
        Write-ColorOutput "npm is required to install Claude Code." "ERROR"
        Write-Host ""
        Write-ColorOutput "npm usually comes with Node.js. Please reinstall Node.js." "INFO"
        Write-Host ""
        exit 1
    }
}

# Install or upgrade Claude Code
function Install-ClaudeCode {
    Write-ColorOutput "Checking Claude Code installation..." "INFO"

    $claudeInstalled = $false
    $currentVersion = ""

    # Check if Claude Code is installed
    try {
        $claudeOutput = & claude --version 2>$null
        if ($claudeOutput) {
            $claudeInstalled = $true
            # Extract version number (e.g., "claude 2.1.27" -> "2.1.27")
            if ($claudeOutput -match '\d+\.\d+\.\d+') {
                $currentVersion = $Matches[0]
            }
        }
    }
    catch {
        # Claude not found
    }

    if (-not $claudeInstalled) {
        Write-ColorOutput "Claude Code not found, installing via npm..." "INFO"
        Test-Npm

        try {
            & npm install -g "@anthropic-ai/claude-code"
            if ($LASTEXITCODE -ne 0) {
                throw "npm install failed with exit code $LASTEXITCODE"
            }
        }
        catch {
            Write-ColorOutput "Failed to install Claude Code via npm." "ERROR"
            Write-Host ""
            Write-ColorOutput "You can try installing manually:" "INFO"
            Write-Host "  npm install -g @anthropic-ai/claude-code"
            Write-Host ""
            Write-ColorOutput "If you encounter permission issues, try running PowerShell as Administrator." "INFO"
            Write-Host ""
            exit 1
        }

        # Verify installation
        try {
            $claudeOutput = & claude --version 2>$null
            if ($claudeOutput -match '\d+\.\d+\.\d+') {
                $currentVersion = $Matches[0]
            }
        }
        catch {
            Write-ColorOutput "Claude Code installation failed - 'claude' command not found." "ERROR"
            exit 1
        }

        if (-not $currentVersion -or -not (Compare-SemanticVersion $currentVersion $MinClaudeCodeVersion)) {
            Write-ColorOutput "Claude Code version $currentVersion is below required $MinClaudeCodeVersion" "ERROR"
            exit 1
        }

        Write-ColorOutput "Claude Code installed: v$currentVersion" "SUCCESS"
    }
    elseif ($currentVersion) {
        # Check version compatibility
        if (-not (Compare-SemanticVersion $currentVersion $MinClaudeCodeVersion)) {
            Write-ColorOutput "Claude Code version $currentVersion is below minimum required version $MinClaudeCodeVersion" "WARNING"
            Write-ColorOutput "Upgrading Claude Code..." "INFO"
            Test-Npm

            try {
                & npm update -g "@anthropic-ai/claude-code"
            }
            catch {
                Write-ColorOutput "npm update command failed, checking current version..." "WARNING"
            }

            # Re-check version after upgrade attempt
            try {
                $claudeOutput = & claude --version 2>$null
                if ($claudeOutput -match '\d+\.\d+\.\d+') {
                    $currentVersion = $Matches[0]
                }
            }
            catch {
                Write-ColorOutput "Failed to determine Claude Code version after upgrade." "ERROR"
                exit 1
            }

            if (-not (Compare-SemanticVersion $currentVersion $MinClaudeCodeVersion)) {
                Write-ColorOutput "Claude Code version $currentVersion is still below required $MinClaudeCodeVersion" "ERROR"
                Write-ColorOutput "Please upgrade manually: npm update -g @anthropic-ai/claude-code" "INFO"
                exit 1
            }

            Write-ColorOutput "Claude Code upgraded to: v$currentVersion" "SUCCESS"
        }
        else {
            Write-ColorOutput "Claude Code found: v$currentVersion" "SUCCESS"
        }
    }
    else {
        Write-ColorOutput "Claude Code found but version could not be determined." "WARNING"
    }
}

# Detect platform
function Get-Platform {
    $arch = if ([Environment]::Is64BitOperatingSystem) { "amd64" } else { "x86" }

    if ($arch -ne "amd64") {
        Write-ColorOutput "Unsupported architecture: $arch. Only amd64 (64-bit) is supported." "ERROR"
        exit 1
    }

    # Check Windows version for ConPTY support (Windows 10 1809+)
    $osVersion = [Environment]::OSVersion.Version
    if ($osVersion.Major -lt 10 -or ($osVersion.Major -eq 10 -and $osVersion.Build -lt 17763)) {
        Write-ColorOutput "Windows 10 version 1809 (build 17763) or later is required." "ERROR"
        Write-ColorOutput "Current version: $($osVersion.Major).$($osVersion.Minor) (build $($osVersion.Build))" "INFO"
        exit 1
    }

    return "windows-$arch"
}

# Download and install binary
function Install-WegentExecutor {
    param([string]$Platform)

    $baseUrl = "https://github.com/$GitHubRepo/releases"

    if ($Version) {
        $downloadUrl = "$baseUrl/download/$Version/wegent-executor-$Platform.exe"
    }
    else {
        $downloadUrl = "$baseUrl/latest/download/wegent-executor-$Platform.exe"
    }

    Write-ColorOutput "Download URL: $downloadUrl" "INFO"

    # Create install directory
    if (-not (Test-Path $InstallDir)) {
        Write-ColorOutput "Creating installation directory: $InstallDir" "INFO"
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }

    $targetPath = Join-Path $InstallDir $BinaryName

    Write-ColorOutput "Downloading wegent-executor..." "INFO"

    try {
        # Use TLS 1.2
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

        # Download with progress
        $progressPreference = 'SilentlyContinue'  # Suppress progress for faster download
        Invoke-WebRequest -Uri $downloadUrl -OutFile $targetPath -UseBasicParsing
        $progressPreference = 'Continue'
    }
    catch {
        Write-ColorOutput "Failed to download wegent-executor: $_" "ERROR"
        Write-Host ""
        Write-ColorOutput "Please check:" "INFO"
        Write-Host "  1. Your internet connection"
        Write-Host "  2. The version '$Version' exists in releases"
        Write-Host "  3. GitHub is accessible"
        Write-Host ""
        exit 1
    }

    # Verify download
    if (Test-Path $targetPath) {
        $fileSize = (Get-Item $targetPath).Length / 1MB
        Write-ColorOutput "Downloaded wegent-executor ($([math]::Round($fileSize, 1)) MB)" "SUCCESS"
    }
    else {
        Write-ColorOutput "Download failed - file not found at $targetPath" "ERROR"
        exit 1
    }
}

# Add installation directory to user PATH
function Add-ToPath {
    $currentPath = [Environment]::GetEnvironmentVariable("Path", "User")

    if ($currentPath -notlike "*$InstallDir*") {
        Write-ColorOutput "Adding $InstallDir to user PATH..." "INFO"
        [Environment]::SetEnvironmentVariable(
            "Path",
            "$currentPath;$InstallDir",
            "User"
        )
        Write-ColorOutput "Added to PATH. Please restart your terminal for changes to take effect." "SUCCESS"
    }
    else {
        Write-ColorOutput "Install directory already in PATH" "INFO"
    }
}

# Print usage instructions
function Show-Usage {
    Write-Host ""
    Write-Host "======================================"
    Write-Host "Installation Complete!" -ForegroundColor Green
    Write-Host "======================================"
    Write-Host ""
    Write-Host "To run wegent-executor, use PowerShell:"
    Write-Host ""
    Write-Host '  $env:EXECUTOR_MODE="local"' -ForegroundColor Yellow
    Write-Host '  $env:WEGENT_BACKEND_URL="<your-backend-url>"' -ForegroundColor Yellow
    Write-Host '  $env:WEGENT_AUTH_TOKEN="<your-auth-token>"' -ForegroundColor Yellow
    Write-Host "  & `"$InstallDir\$BinaryName`"" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Or use Command Prompt (cmd):" -ForegroundColor Blue
    Write-Host ""
    Write-Host "  set EXECUTOR_MODE=local" -ForegroundColor Yellow
    Write-Host "  set WEGENT_BACKEND_URL=<your-backend-url>" -ForegroundColor Yellow
    Write-Host "  set WEGENT_AUTH_TOKEN=<your-auth-token>" -ForegroundColor Yellow
    Write-Host "  wegent-executor" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "After restarting your terminal, you can run directly:" -ForegroundColor Blue
    Write-Host "  wegent-executor --version" -ForegroundColor Yellow
    Write-Host ""
}

# Main function
function Main {
    Write-Host ""
    Write-Host "======================================"
    Write-Host "  Wegent Executor Installation Script"
    Write-Host "  (Windows)"
    Write-Host "======================================"
    Write-Host ""

    $platform = Get-Platform
    Write-ColorOutput "Detected platform: $platform" "INFO"

    Test-NodeJS
    Install-ClaudeCode
    Install-WegentExecutor -Platform $platform
    Add-ToPath
    Show-Usage
}

# Run main function
Main
