# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Executor command group - manage local executor."""

import os
import platform
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

import click
import requests

from ..config import get_server, get_token

# Constants
HOME_DIR = Path.home() / ".wegent"
BIN_DIR = HOME_DIR / "bin"
RUN_DIR = HOME_DIR / "run"
LOG_DIR = HOME_DIR / "logs"

EXECUTOR_BIN_NAME = "wegent-executor"
if platform.system() == "Windows":
    EXECUTOR_BIN_NAME += ".exe"

PID_FILE = RUN_DIR / "executor.pid"
LOG_FILE = LOG_DIR / "executor.log"
VERSION_FILE = BIN_DIR / ".executor-version"


def _ensure_dirs():
    """Ensure necessary directories exist."""
    BIN_DIR.mkdir(parents=True, exist_ok=True)
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)


def _get_executor_path() -> Optional[Path]:
    """Resolve executor executable path."""
    # 1. Environment variable
    env_path = os.environ.get("WEGENT_EXECUTOR_PATH")
    if env_path:
        return Path(env_path)

    # 2. Installed binary
    bin_path = BIN_DIR / EXECUTOR_BIN_NAME
    if bin_path.exists():
        return bin_path

    # 3. Development fallback (if running from source)
    # Assuming cli is run from root or wegent-cli dir, try to find executor/main.py
    cwd = Path.cwd()
    dev_main = cwd / "executor" / "main.py"
    if dev_main.exists():
        # Check for virtualenv python
        venv_python = cwd / "executor" / ".venv" / "bin" / "python"
        if venv_python.exists():
            return venv_python
        return Path(sys.executable)

    # 4. Dev fallback (parent directory)
    # Check if running from wegent-cli and sibling directory has executor
    dev_main_parent = cwd.parent / "executor" / "main.py"
    if dev_main_parent.exists():
        # Check for virtualenv python
        venv_python = cwd.parent / "executor" / ".venv" / "bin" / "python"
        if venv_python.exists():
            return venv_python
        return Path(sys.executable)

    return None


@click.group("executor")
def executor_cmd():
    """Manage local executor instance."""
    _ensure_dirs()


@executor_cmd.command("start")
@click.option("-d", "--detach", is_flag=True, help="Run in background")
def start_executor(detach: bool):
    """Start the local executor."""
    # Check if already running
    if PID_FILE.exists():
        try:
            pid = int(PID_FILE.read_text().strip())
            os.kill(pid, 0)  # Check if process exists
            click.echo(f"Executor is already running (PID: {pid})")
            return
        except (ValueError, OSError):
            # Stale PID file
            PID_FILE.unlink(missing_ok=True)

    # Get configuration
    token = get_token()
    server = get_server()

    if not token:
        click.echo("Error: Not logged in. Please run 'wegent login' first.", err=True)
        sys.exit(1)

    # Resolve executable
    exe_path = _get_executor_path()
    if not exe_path:
        click.echo("Error: Executor not found.", err=True)
        click.echo(
            "Run 'wegent executor update' to install it, or set WEGENT_EXECUTOR_PATH.",
            err=True,
        )
        sys.exit(1)

    # Prepare environment
    env = os.environ.copy()
    env["WEGENT_AUTH_TOKEN"] = token
    env["WEGENT_BACKEND_URL"] = server
    env["EXECUTOR_MODE"] = "local"

    # Dev mode handling for main.py
    cmd = []
    if str(exe_path).endswith("python"):
        # We found a python interpreter, assume we want to run executor/main.py
        # This is a bit of a heuristic for dev mode
        cwd = Path.cwd()
        script_path = cwd / "executor" / "main.py"
        if script_path.exists():
            cmd = [str(exe_path), str(script_path)]
            env["PYTHONPATH"] = str(cwd)  # Set PYTHONPATH for dev
        else:
            # Should not happen given _get_executor_path logic but safety check
            click.echo(
                "Error: Could not locate executor/main.py for dev execution", err=True
            )
            sys.exit(1)
    else:
        cmd = [str(exe_path)]

    click.echo(f"Starting executor connected to {server}...")

    if detach:
        # Run in background
        with open(LOG_FILE, "a") as log:
            process = subprocess.Popen(
                cmd, env=env, stdout=log, stderr=log, start_new_session=True
            )

        PID_FILE.write_text(str(process.pid))
        click.echo(f"Executor started in background (PID: {process.pid})")
        click.echo(f"Logs: {LOG_FILE}")
    else:
        # Run in foreground
        try:
            subprocess.run(cmd, env=env, check=True)
        except KeyboardInterrupt:
            click.echo("\nStopping executor...")


@executor_cmd.command("stop")
def stop_executor():
    """Stop the local executor."""
    if not PID_FILE.exists():
        click.echo("Executor is not running.")
        return

    try:
        pid = int(PID_FILE.read_text().strip())
        os.kill(pid, signal.SIGTERM)

        # Wait for process to exit
        for _ in range(10):
            try:
                os.kill(pid, 0)
                time.sleep(0.5)
            except OSError:
                break
        else:
            # Force kill if still running
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass

        click.echo(f"Executor stopped (PID: {pid})")
    except (ValueError, OSError):
        click.echo("Failed to stop executor (maybe it wasn't running?)")

    PID_FILE.unlink(missing_ok=True)


@executor_cmd.command("restart")
@click.option("-d", "--detach", is_flag=True, help="Run in background")
@click.pass_context
def restart_executor(ctx, detach):
    """Restart the local executor."""
    ctx.invoke(stop_executor)
    time.sleep(1)

    # If previously running, we might want to default to detach,
    # but for now explicit flag or default foreground is safer/clearer
    ctx.invoke(start_executor, detach=detach)


@executor_cmd.command("update")
@click.option("-v", "--version", help="Specific version to install (e.g., v1.0.0)")
@click.option(
    "-f", "--force", is_flag=True, help="Force reinstall even if already up-to-date"
)
def update_executor(version, force):
    """Install or update the executor binary."""
    # Determine platform/arch
    system = platform.system().lower()
    machine = platform.machine().lower()

    # Map to release asset naming convention
    # naming format: wegent-executor-{os}-{arch}
    # os: linux, darwin (macos), windows
    # arch: amd64, arm64

    target_os = system
    if system == "darwin":
        target_os = "macos"  # or darwin, depends on how we name assets

    target_arch = machine
    if machine == "x86_64":
        target_arch = "amd64"
    elif machine == "aarch64":
        target_arch = "arm64"

    asset_name = f"wegent-executor-{target_os}-{target_arch}"
    if system == "windows":
        asset_name += ".exe"

    click.echo(f"Looking for {asset_name}...")

    try:
        if version:
            url = (
                f"https://api.github.com/repos/wecode-ai/Wegent/releases/tags/{version}"
            )
        else:
            url = "https://api.github.com/repos/wecode-ai/Wegent/releases/latest"

        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
        release_data = resp.json()

        tag_name = release_data["tag_name"]
        assets = release_data.get("assets", [])

        # Check if already installed with same version
        target_path = BIN_DIR / EXECUTOR_BIN_NAME
        if not force and target_path.exists() and VERSION_FILE.exists():
            try:
                installed_version = VERSION_FILE.read_text().strip()
                if installed_version == tag_name:
                    click.echo(
                        click.style(f"✓ Already up-to-date ({tag_name})", fg="green")
                    )
                    click.echo("Use --force to reinstall anyway.")
                    return
                else:
                    click.echo(f"Upgrading from {installed_version} to {tag_name}...")
            except Exception:
                pass  # If version file is corrupted, continue with installation

        target_asset = None
        for asset in assets:
            if asset["name"] == asset_name:
                target_asset = asset
                break

        if not target_asset:
            click.echo(
                f"Error: No asset found for {target_os}/{target_arch} in release {tag_name}",
                err=True,
            )
            return

        download_url = target_asset["browser_download_url"]
        click.echo(f"Downloading {tag_name} from {download_url}...")

        # Download
        bin_resp = requests.get(download_url, stream=True, timeout=60)
        bin_resp.raise_for_status()

        temp_path = target_path.with_suffix(".tmp")

        with open(temp_path, "wb") as f:
            for chunk in bin_resp.iter_content(chunk_size=8192):
                f.write(chunk)

        # Backup existing binary
        if target_path.exists():
            backup_path = target_path.with_suffix(".old")
            target_path.replace(backup_path)
            click.echo(f"Backed up current version to {backup_path}")

        # Move to final location and make executable
        temp_path.chmod(0o755)
        temp_path.replace(target_path)

        # Save version info
        VERSION_FILE.write_text(tag_name)

        click.echo(
            click.style(
                f"✓ Successfully installed executor {tag_name}",
                fg="green",
            )
        )
        click.echo(f"Location: {target_path}")

    except Exception as e:
        click.echo(f"Update failed: {str(e)}", err=True)


@executor_cmd.command("rollback")
def rollback_executor():
    """Rollback to the previous version of executor."""
    target_path = BIN_DIR / EXECUTOR_BIN_NAME
    backup_path = target_path.with_suffix(".old")

    if not backup_path.exists():
        click.echo("Error: No backup found to rollback to.", err=True)
        return

    # Backup current version as .new in case rollback is accidental?
    # Or just overwrite? Let's just swap them to be safe/simple.

    try:
        if target_path.exists():
            # Move current to .tmp so we can restore if rename fails
            temp_current = target_path.with_suffix(".tmp_rollback")
            target_path.replace(temp_current)

            try:
                # Restore backup
                backup_path.replace(target_path)
                click.echo(f"Rolled back to previous version.")

                # The old 'current' is now the backup (swap) logic?
                # Or just delete? Let's keep it as .old for toggle capability?
                # "Rollback" usually implies going to previous state.
                # Let's make the "newly rolled back" version the active one,
                # and the "bad new version" becomes .old (swapping).
                # This allow repeated rollback to toggle between two versions.
                temp_current.replace(backup_path)
                click.echo(f"The version you rolled back FROM is now saved as backup.")

            except Exception as e:
                # Restore failed, try to put back current
                temp_current.replace(target_path)
                raise e
        else:
            # No current version, just restore backup
            backup_path.replace(target_path)
            click.echo(f"Restored executor from backup.")

    except Exception as e:
        click.echo(f"Rollback failed: {str(e)}", err=True)


@executor_cmd.command("version")
def version_executor():
    """Show installed executor version."""
    target_path = BIN_DIR / EXECUTOR_BIN_NAME

    if not target_path.exists():
        click.echo(click.style("Executor binary not installed.", fg="yellow"))
        click.echo(f"\nRun 'wegent executor update' to install it.")
        return

    # Read version from version file
    if VERSION_FILE.exists():
        try:
            installed_version = VERSION_FILE.read_text().strip()
            click.echo(
                click.style(f"Installed version: {installed_version}", fg="green")
            )
        except Exception:
            click.echo(click.style("Installed version: unknown", fg="yellow"))
    else:
        click.echo(
            click.style("Installed version: unknown (legacy installation)", fg="yellow")
        )

    click.echo(f"Location: {target_path}")

    # Check for backup
    backup_path = target_path.with_suffix(".old")
    if backup_path.exists():
        click.echo(f"Backup available: {backup_path}")
