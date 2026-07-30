---
sidebar_position: 45
---

# Wework Windows Desktop Build Guide

This guide covers how to build and run the Wework desktop app (`wework`) on Windows, and how to cross-compile a Windows installer from macOS.

---

## Prerequisites

### Native Windows build

- **Windows 10/11**
- **Rust 1.77+** with the `x86_64-pc-windows-msvc` target installed
- **Node.js 20+** and **pnpm**
- **Visual Studio Build Tools** (provides the MSVC toolchain)
- **Git**

### Cross-compiling the Windows installer from macOS

- **macOS** (Apple Silicon or Intel)
- **Rust 1.77+**
- **cargo-xwin**: `cargo install cargo-xwin`
- **LLVM** (for `clang`): `brew install llvm`, and ensure `/opt/homebrew/opt/llvm/bin` is on your `PATH`
- **NSIS** (for installer generation): `brew install nsis`
- **Node.js 20+** and **pnpm**

---

## Summary of changes for Windows support

The main portability changes are:

1. **Local IPC uses standard input and output**: Tauri exchanges JSONL messages with the Executor sidecar over the child process stdin/stdout, with no Unix domain socket, TCP port, or address file. Every platform uses the same parent-child transport.
2. **Portable home directory resolution**: All Rust code uses `dirs::home_dir()`, which falls back to `USERPROFILE` on Windows instead of relying on the `HOME` environment variable.
3. **File permission calls are Unix-only**: `chmod` / `set_mode` calls are gated with `#[cfg(unix)]` and ignored on Windows.
4. **Local terminal defaults to PowerShell on Windows**: `pwsh.exe` is preferred, with `powershell.exe` as the fallback.
5. **New Windows build script and Tauri config**: `wework/scripts/build-windows-app.sh` and `wework/src-tauri/tauri.windows.conf.json`.

---

## Native Windows development

### 1. Install dependencies

```powershell
# Add the Windows target
rustup target add x86_64-pc-windows-msvc

# Install pnpm
npm install -g pnpm

# Install frontend dependencies
pnpm install
```

### 2. Start dev mode with one command

After the prerequisites are installed, run this from the project root:

```powershell
pnpm --filter wework dev:windows
```

This command automatically:

- Finds an available port (default `1420`; increments if it is in use).
- Builds the Windows local Executor sidecar (uses `dev-reload` mode by default, so changes to `executor` source are recompiled automatically).
- Prepares the Windows Codex binary.
- Generates a temporary Tauri dev config and starts `tauri dev --target x86_64-pc-windows-msvc`.

To disable executor hot-reload, set this environment variable first:

```powershell
$env:WEWORK_DISABLE_EXECUTOR_DEV_RELOAD = "1"
pnpm --filter wework dev:windows
```

### 3. Speed up development builds (optional)

`pnpm --filter wework dev:windows` automatically uses a shared Cargo target directory so that dependencies compiled in one worktree or one session are reused in the next. It also auto-detects `sccache` and uses it when available.

The cache layout is:

```text
%USERPROFILE%\.cache\wegent\cargo-target\
  executor-dev\      # dev-reload executor builds
  executor\          # non-reload executor builds
  wework-src-tauri\  # Tauri/Cargo builds
```

You can customize or disable this behavior with environment variables:

| Variable                               | Description                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| `WEGENT_CARGO_TARGET_ROOT`             | Override the shared cache root directory.                                                   |
| `WEGENT_DISABLE_SHARED_CARGO_TARGET=1` | Keep Cargo artifacts inside each project's `target/` directory instead of the shared cache. |
| `CARGO_TARGET_DIR`                     | If you explicitly set this, `dev:windows` will use it for all Cargo builds.                 |
| `WEGENT_DISABLE_SCCACHE=1`             | Do not auto-detect or use `sccache`.                                                        |

To get the fastest rebuilds, install [sccache](https://github.com/mozilla/sccache) and make sure it is on your `PATH`:

```powershell
cargo install sccache
```

### 4. Manual steps (optional)

If you prefer to run the steps individually, or want to understand what the `dev:windows` script does internally, follow the commands below.

#### 4.1 Build the local Executor sidecar

```powershell
cd executor
cargo build --release --target x86_64-pc-windows-msvc
```

Copy the resulting binary to the location Tauri expects:

```powershell
$target = "x86_64-pc-windows-msvc"
cp "executor\target\$target\release\wegent-executor.exe" "wework\src-tauri\binaries\wegent-executor-$target.exe"
```

Or use the convenience helper from the repository root on macOS to cross-compile the sidecar only (faster than a full installer build):

```bash
cd wework
pnpm run build:windows:sidecar
```

#### 4.2 Prepare the bundled Codex binary

```powershell
cd wework
$env:WEWORK_CODEX_TARGET = "x86_64-pc-windows-msvc"
pnpm run prepare:codex
```

#### 4.3 Start the dev mode

```powershell
pnpm exec tauri dev --target x86_64-pc-windows-msvc
```

---

## Cross-compiling the Windows installer from macOS

Use the repository build script:

```bash
bash wework/scripts/build-windows-app.sh
```

The script will:

1. Build the Executor sidecar for `x86_64-pc-windows-msvc` using `cargo xwin build`.
2. Copy `wegent-executor.exe` to `wework/src-tauri/binaries/wegent-executor-x86_64-pc-windows-msvc.exe`.
3. Prepare the Windows Codex binary.
4. Build Tauri with `cargo-xwin` and produce an NSIS installer.

The installer is written to:

```
wework/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/
```

### Repository convenience command

```bash
cd wework
pnpm run build:windows
```

This is equivalent to `bash scripts/build-windows-app.sh`.

---

## Runtime behavior

- Tauri starts the Executor sidecar and sends JSONL requests through stdin.
- Executor stdout is reserved for JSONL responses and events; ordinary diagnostics go to stderr.
- Local IPC ends when stdin closes or the child exits, so no endpoint discovery or reconnect is required.

---

## Known limitations

- **Local terminal uses PowerShell** on Windows instead of `/bin/zsh`.
- **Executor lifetime is bound to the desktop process**: fully exiting Wework closes stdin and terminates its managed Executor. A new Wework process does not reattach to an old Executor.
- **Some backend/sandbox paths remain Unix-oriented**: Docker socket paths, `/home/user`, `/workspace`, etc. are used by the remote Linux/macOS Executor Manager and are not part of the Windows desktop installer path.

---

## Troubleshooting

- **`cargo xwin` cannot find a C compiler**: make sure LLVM is installed and `clang` is on your `PATH`.
- **Tauri cannot find the sidecar**: verify that `wework/src-tauri/binaries/wegent-executor-x86_64-pc-windows-msvc.exe` exists.
- **NSIS build fails**: confirm NSIS is installed (on either Windows or macOS).
- **Runtime cannot connect to the Executor**: verify that the sidecar starts successfully and does not write non-protocol text to stdout. Diagnostics must go to stderr or the Executor log file.
- **"Program not found" when sending a message**: the local Executor sidecar may be missing or stale. Rebuild it with `pnpm run build:windows:sidecar` (cross-compile from macOS) or `cargo build --release --target x86_64-pc-windows-msvc` followed by copying `wegent-executor.exe` to `wework/src-tauri/binaries/wegent-executor-x86_64-pc-windows-msvc.exe`.
- **Locally installed Codex reports "program not found"**: on Windows, resolving a bare `codex` name automatically tries executable extensions (`codex.exe`, `codex.cmd`, `codex.bat`, etc.) and falls back to common user directories such as `%APPDATA%\npm` and `~/.cargo/bin`, because GUI-launched processes may not inherit the shell `PATH`. If Codex is installed elsewhere, set the full path via environment variable: `$env:CODEX_BINARY_PATH = "C:\Path\To\codex.exe"`.
