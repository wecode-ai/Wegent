# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Process lifecycle management for executor self-updates.

Manages PID file for tracking running executor instances and handles
the auto-restart functionality after successful upgrades.
"""

import logging
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional

from executor.platform_compat import IS_WINDOWS, get_signal_handler

# Use 'updater' logger to write to upgrade.log
logger = logging.getLogger("updater")


@dataclass
class ProcessInfo:
    """Information stored in PID file about a running executor process."""

    pid: int
    start_time: float
    version: str


class ProcessManager:
    """Manage executor process lifecycle via PID file for self-updates.

    Handles:
    - Writing PID file when executor starts
    - Reading PID file to check if executor is running
    - Terminating running executor (graceful then forceful)
    - Auto-restarting executor after upgrade
    - Cleaning up PID file on shutdown
    """

    PID_FILE_DIR = Path.home() / ".wegent-executor"
    PID_FILE = PID_FILE_DIR / "executor.pid"

    # Timeout for graceful termination (seconds)
    GRACEFUL_TIMEOUT = 10

    def __init__(self):
        """Initialize process manager."""
        self._signal_handler = get_signal_handler()

    def _is_windows(self) -> bool:
        """Check if running on Windows."""
        return IS_WINDOWS

    def write_pid_file(self, version: str) -> bool:
        """Write PID file with current process information.

        Args:
            version: Current executor version

        Returns:
            True if PID file was written successfully
        """
        import json
        from dataclasses import asdict

        try:
            self.PID_FILE_DIR.mkdir(parents=True, exist_ok=True)

            # On Windows, restrict directory permissions isn't straightforward,
            # so we rely on the file permissions
            info = ProcessInfo(
                pid=os.getpid(),
                start_time=time.time(),
                version=version,
            )

            # Write with restrictive permissions (owner only)
            self.PID_FILE.write_text(json.dumps(asdict(info)), encoding="utf-8")

            # Set owner-only permissions on Unix
            if not IS_WINDOWS:
                os.chmod(self.PID_FILE, 0o600)

            logger.debug(f"Wrote PID file: {self.PID_FILE} (pid={info.pid})")
            return True

        except Exception as e:
            logger.warning(f"Failed to write PID file: {e}")
            return False

    def remove_pid_file(self) -> bool:
        """Remove PID file on shutdown.

        Returns:
            True if PID file was removed or didn't exist
        """
        try:
            if self.PID_FILE.exists():
                self.PID_FILE.unlink()
                logger.debug(f"Removed PID file: {self.PID_FILE}")
            return True
        except Exception as e:
            logger.warning(f"Failed to remove PID file: {e}")
            return False

    def read_pid_file(self) -> Optional[ProcessInfo]:
        """Read PID file and return process information.

        Returns:
            ProcessInfo if PID file exists and is valid, None otherwise
        """
        import json

        try:
            if not self.PID_FILE.exists():
                return None

            data = json.loads(self.PID_FILE.read_text(encoding="utf-8"))
            return ProcessInfo(**data)

        except (json.JSONDecodeError, TypeError, KeyError) as e:
            logger.warning(f"Invalid PID file format: {e}")
            # Remove corrupted PID file
            try:
                self.PID_FILE.unlink()
            except Exception:
                pass
            return None
        except Exception as e:
            logger.warning(f"Failed to read PID file: {e}")
            return None

    def is_running(self, info: ProcessInfo) -> bool:
        """Check if a process with the given PID is actually running.

        Args:
            info: ProcessInfo containing PID to check

        Returns:
            True if process is running, False otherwise
        """
        try:
            if IS_WINDOWS:
                # On Windows, use ctypes to check if process exists
                import ctypes

                kernel32 = ctypes.windll.kernel32
                handle = kernel32.OpenProcess(1, False, info.pid)  # PROCESS_TERMINATE = 1
                if handle:
                    kernel32.CloseHandle(handle)
                    return True
                return False
            else:
                # On Unix, send signal 0 to check if process exists
                os.kill(info.pid, 0)
                return True

        except (OSError, ProcessLookupError):
            return False

    def was_running(self) -> Optional[ProcessInfo]:
        """Check if executor was running by checking PID file.

        Returns:
            ProcessInfo if a valid PID file exists and process is running,
            None otherwise
        """
        info = self.read_pid_file()
        if info is None:
            return None

        # Check if it's our own process (we're checking from upgrade process)
        if info.pid == os.getpid():
            return None

        # Check if the process is actually running
        if self.is_running(info):
            return info

        # Stale PID file - remove it
        logger.debug(f"Removing stale PID file for pid={info.pid}")
        self.remove_pid_file()
        return None

    def terminate_process(self, pid: int, timeout: Optional[int] = None) -> bool:
        """Terminate a process gracefully, then forcefully if needed.

        Args:
            pid: Process ID to terminate
            timeout: Seconds to wait for graceful termination (default: GRACEFUL_TIMEOUT)

        Returns:
            True if process was terminated successfully
        """
        if timeout is None:
            timeout = self.GRACEFUL_TIMEOUT

        # Don't terminate ourselves
        if pid == os.getpid():
            logger.warning("Cannot terminate current process")
            return False

        try:
            # First, try graceful termination
            logger.info(f"Sending graceful termination signal to pid={pid}")
            if not self._signal_handler.terminate_gracefully(pid):
                logger.warning(f"Failed to send graceful termination to pid={pid}")
                # Try to check if process is already dead
                if not self._is_process_alive(pid):
                    logger.info(f"Process pid={pid} is already terminated")
                    return True

            # Wait for process to terminate
            start_time = time.time()
            while time.time() - start_time < timeout:
                if not self._is_process_alive(pid):
                    logger.info(f"Process pid={pid} terminated gracefully")
                    return True
                time.sleep(0.5)

            # Force kill if still running
            logger.warning(f"Process pid={pid} did not terminate gracefully, force killing")
            if self._signal_handler.terminate_forcefully(pid):
                # Wait a bit for force kill to take effect
                time.sleep(1)
                if not self._is_process_alive(pid):
                    logger.info(f"Process pid={pid} force killed")
                    return True

            logger.error(f"Failed to terminate process pid={pid}")
            return False

        except Exception as e:
            logger.error(f"Error terminating process pid={pid}: {e}")
            return False

    def _is_process_alive(self, pid: int) -> bool:
        """Check if a process is alive.

        Args:
            pid: Process ID to check

        Returns:
            True if process is alive
        """
        try:
            if IS_WINDOWS:
                import ctypes

                kernel32 = ctypes.windll.kernel32
                handle = kernel32.OpenProcess(1, False, pid)
                if handle:
                    kernel32.CloseHandle(handle)
                    return True
                return False
            else:
                os.kill(pid, 0)
                return True
        except (OSError, ProcessLookupError):
            return False

    def _get_filtered_env(self) -> dict:
        """Get environment variables filtered for PyInstaller compatibility.

        Removes all _PYI_* and _MEI_* variables (PyInstaller internal vars)
        and any variables with values containing _MEI temp paths.
        Also logs all environment variables being passed to child process.

        Returns:
            Dict of environment variables
        """
        # Start with current environment
        env = dict(os.environ)

        # Remove all _PYI_ and _MEI_ prefixed variables (PyInstaller internal vars)
        pyi_vars = [k for k in env.keys() if k.startswith(("_PYI_", "_MEI_"))]
        for var in pyi_vars:
            del env[var]

        # Find and remove variables with values containing _MEI temp paths
        # These are PyInstaller temporary directories that won't exist after restart
        mei_path_vars = []
        for key, value in list(env.items()):
            if "_MEI" in value and "/var/folders/" in value:
                mei_path_vars.append(key)
                del env[key]

        # Log SSL certificate related variables for debugging
        ssl_vars = ["SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "OPENSSL_CONF"]
        logger.info("SSL/Certificate environment variables:")
        for var in ssl_vars:
            if var in env:
                logger.info(f"  {var}={env[var]}")
            else:
                logger.info(f"  {var}=<not set>")

        # Check if running as PyInstaller frozen executable
        is_frozen = getattr(sys, "frozen", False)
        logger.info(f"Running as PyInstaller frozen: {is_frozen}")

        # Log the filtered environment variables
        logger.info("All environment variables passed to child process:")
        for key, value in sorted(env.items()):
            # Mask sensitive values
            masked_value = value
            if any(
                sensitive in key.lower()
                for sensitive in ["token", "password", "secret", "key", "auth"]
            ):
                masked_value = "***" if value else ""
            logger.info(f"  {key}={masked_value}")

        if pyi_vars:
            logger.info(f"Removed PyInstaller variables: {pyi_vars}")
        if mei_path_vars:
            logger.info(f"Removed variables with _MEI temp paths: {mei_path_vars}")

        return env

    def restart_executor(self, verbose: bool = False) -> bool:
        """Restart the executor after upgrade using nohup.

        This method spawns a new executor process using nohup and exits the current one.
        On Unix, it uses nohup to keep the process running after parent exits.
        On Windows, it uses CREATE_NEW_PROCESS_GROUP.

        Args:
            verbose: If True, write restart output to executor-restart.log.
                    If False, redirect output to DEVNULL.

        Returns:
            True if restart was initiated successfully (doesn't return on success)
        """
        # Get the current binary path
        if getattr(sys, "frozen", False):
            binary_path = Path(sys.executable).resolve()
            args = []
        else:
            # In development mode, restart via Python module
            binary_path = Path(sys.executable).resolve()
            args = ["-m", "executor.main"]

        try:
            logger.info(f"Restarting executor via nohup: {binary_path}")

            if IS_WINDOWS:
                # On Windows, create new process group and detach
                creation_flags = subprocess.CREATE_NEW_PROCESS_GROUP
                creation_flags |= subprocess.DETACHED_PROCESS

                subprocess.Popen(
                    [str(binary_path)] + args,
                    creationflags=creation_flags,
                    close_fds=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    stdin=subprocess.DEVNULL,
                )
            else:
                # On Unix, use nohup to restart the executor
                if verbose:
                    # Setup log file for nohup output
                    log_dir = Path.home() / ".wegent-executor" / "logs"
                    log_dir.mkdir(parents=True, exist_ok=True)
                    log_file = log_dir / "executor-restart.log"

                    # Get filtered environment variables
                    env = self._get_filtered_env()

                    # Build nohup command: nohup <binary> [args]
                    cmd = ["nohup", str(binary_path)] + args

                    # Open log file for append
                    with open(log_file, "a") as log_fh:
                        # Write restart marker
                        log_fh.write(
                            f"\n\n=== Executor restart at {datetime.now().isoformat()} ===\n\n"
                        )
                        log_fh.flush()

                        # Start process with nohup
                        process = subprocess.Popen(
                            cmd,
                            stdout=log_fh,
                            stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL,
                            start_new_session=True,
                            close_fds=True,
                            env=env,
                            cwd=str(Path.home()),
                        )

                        logger.info(f"Executor restarted with PID: {process.pid}")
                        logger.info(f"Output redirected to: {log_file}")
                else:
                    # No verbose mode - redirect output to DEVNULL
                    env = self._get_filtered_env()
                    cmd = ["nohup", str(binary_path)] + args

                    process = subprocess.Popen(
                        cmd,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        stdin=subprocess.DEVNULL,
                        start_new_session=True,
                        close_fds=True,
                        env=env,
                        cwd=str(Path.home()),
                    )

                    logger.info(f"Executor restarted with PID: {process.pid}")

            # Clean up our PID file since we're restarting
            self.remove_pid_file()

            return True

        except Exception as e:
            logger.error(f"Failed to restart executor: {e}")
            return False
