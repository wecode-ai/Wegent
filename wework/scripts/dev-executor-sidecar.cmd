@echo off
setlocal
rem Windows executor sidecar mirroring scripts/dev-executor-sidecar.sh.
set "SCRIPT_DIR=%~dp0"
set "EXECUTOR_DIR=%SCRIPT_DIR%..\..\executor"

if "%~1"=="browser-mcp-server" goto :stdio
if "%~1"=="space-mcp-server" goto :stdio
goto :configured

:stdio
set "CARGO_TARGET_DIR="
set "WEGENT_CARGO_TARGET_DIR_AUTO="
if not defined WEGENT_CARGO_TARGET_ROOT (
  if defined USERPROFILE set "WEGENT_CARGO_TARGET_ROOT=%USERPROFILE%\.cache\wegent\cargo-target"
)

:configured
if defined WEGENT_EXECUTOR_BINARY (
  "%WEGENT_EXECUTOR_BINARY%" %*
  goto :exit
)

if "%WEGENT_EXECUTOR_DEV_RELOAD%"=="0" goto :direct
if not defined WEGENT_EXECUTOR_DEV_RELOAD set "WEGENT_EXECUTOR_DEV_RELOAD=1"
if "%WEGENT_EXECUTOR_DEV_RELOAD%"=="1" (
  node "%SCRIPT_DIR%dev-executor-reload.mjs" %*
  goto :exit
)

:direct
if exist "%EXECUTOR_DIR%\dist\wegent-executor.exe" (
  "%EXECUTOR_DIR%\dist\wegent-executor.exe" %*
  goto :exit
)
if not defined CARGO_TARGET_DIR set "CARGO_TARGET_DIR=%EXECUTOR_DIR%\target"
if exist "%CARGO_TARGET_DIR%\release\wegent-executor.exe" (
  "%CARGO_TARGET_DIR%\release\wegent-executor.exe" %*
  goto :exit
)
cargo build --manifest-path "%EXECUTOR_DIR%\Cargo.toml" --bin wegent-executor
"%CARGO_TARGET_DIR%\debug\wegent-executor.exe" %*
goto :exit

:exit
exit /b %errorlevel%
