# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Development reloader for the complete Backend process topology."""

from __future__ import annotations

import logging
import os
import signal
import subprocess
import sys
from pathlib import Path
from types import FrameType

from watchfiles import PythonFilter, watch

logger = logging.getLogger(__name__)


class BackendDevelopmentRuntime:
    """Restart the entire Backend supervisor when Python source changes."""

    def __init__(
        self,
        watch_paths: tuple[Path, ...],
        *,
        shutdown_timeout_seconds: int,
    ) -> None:
        if not watch_paths:
            raise ValueError("At least one development watch path is required")
        if shutdown_timeout_seconds <= 0:
            raise ValueError("shutdown_timeout_seconds must be positive")
        self._watch_paths = watch_paths
        self._shutdown_timeout_seconds = shutdown_timeout_seconds
        self._shutdown_requested = False
        self._process: subprocess.Popen[bytes] | None = None

    def run(self) -> int:
        """Run and reload app.runtime until this reloader is terminated."""
        self._install_signal_handlers()
        self._process = self._start_runtime()
        exit_code = 0
        try:
            for changes in watch(
                *self._watch_paths,
                watch_filter=PythonFilter(),
                rust_timeout=500,
                yield_on_timeout=True,
            ):
                if self._shutdown_requested:
                    break
                if self._process.poll() is not None:
                    exit_code = self._process.returncode or 1
                    logger.error(
                        "Backend development runtime exited unexpectedly: "
                        "exit_code=%s",
                        exit_code,
                    )
                    break
                if not changes:
                    continue
                logger.info(
                    "Backend Python change detected; restarting all roles: %s",
                    sorted(path for _change, path in changes),
                )
                self._stop_runtime(self._process)
                if self._shutdown_requested:
                    break
                self._process = self._start_runtime()
        finally:
            if self._process is not None:
                self._stop_runtime(self._process)
        return exit_code

    def request_shutdown(
        self,
        signum: int,
        frame: FrameType | None = None,
    ) -> None:
        """Request a graceful shutdown at the next watcher checkpoint."""
        del frame
        logger.info("Backend development reloader received signal %s", signum)
        self._shutdown_requested = True

    def _install_signal_handlers(self) -> None:
        for handled_signal in (signal.SIGINT, signal.SIGTERM):
            signal.signal(handled_signal, self.request_shutdown)

    @staticmethod
    def _start_runtime() -> subprocess.Popen[bytes]:
        return subprocess.Popen(
            [sys.executable, "-m", "app.runtime"],
            start_new_session=True,
        )

    def _stop_runtime(self, process: subprocess.Popen[bytes]) -> None:
        if process.poll() is not None:
            return
        process.send_signal(signal.SIGTERM)
        try:
            process.wait(timeout=self._shutdown_timeout_seconds)
        except subprocess.TimeoutExpired:
            logger.error(
                "Backend supervisor did not drain within %ss; force-killing "
                "its process group",
                self._shutdown_timeout_seconds,
            )
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()


def _positive_int_environment(name: str, default: int) -> int:
    value = int(os.getenv(name, str(default)))
    if value <= 0:
        raise ValueError(f"{name} must be positive")
    return value


def main() -> None:
    """Watch Backend and shared Python sources during local development."""
    from app.core.logging import setup_logging

    setup_logging()
    backend_root = Path(__file__).resolve().parents[1]
    repository_root = backend_root.parent
    graceful_timeout = _positive_int_environment(
        "GRACEFUL_SHUTDOWN_TIMEOUT",
        600,
    )
    runtime = BackendDevelopmentRuntime(
        (backend_root / "app", repository_root / "shared"),
        shutdown_timeout_seconds=graceful_timeout + 10,
    )
    raise SystemExit(runtime.run())


if __name__ == "__main__":
    main()
