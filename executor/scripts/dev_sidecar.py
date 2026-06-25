#!/usr/bin/env python

# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Run the local executor from source and restart it when source files change."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Iterable

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer


EXECUTOR_DIR = Path(__file__).resolve().parents[1]
PROJECT_DIR = EXECUTOR_DIR.parent
DEFAULT_RELOAD_EXTENSIONS = {".py", ".toml", ".yaml", ".yml", ".json"}
IGNORED_PATH_PARTS = {
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "venv",
}


def log(message: str) -> None:
    print(f"[wegent-executor-dev] {message}", flush=True)


def prepend_pythonpath(env: dict[str, str]) -> dict[str, str]:
    current = env.get("PYTHONPATH", "")
    paths = [str(PROJECT_DIR)]
    if current:
        paths.append(current)
    env["PYTHONPATH"] = os.pathsep.join(paths)
    return env


def reload_extensions() -> set[str]:
    raw = os.environ.get("WEGENT_EXECUTOR_RELOAD_EXTENSIONS", "")
    if not raw.strip():
        return DEFAULT_RELOAD_EXTENSIONS
    return {item.strip() for item in raw.split(",") if item.strip()}


def reload_dirs() -> list[Path]:
    raw = os.environ.get("WEGENT_EXECUTOR_RELOAD_DIRS", "")
    if raw.strip():
        return [Path(item).expanduser().resolve() for item in raw.split(os.pathsep) if item]
    return [EXECUTOR_DIR, PROJECT_DIR / "shared"]


def debounce_seconds() -> float:
    raw = os.environ.get("WEGENT_EXECUTOR_RELOAD_DEBOUNCE_SECONDS", "0.5")
    try:
        return max(0.1, float(raw))
    except ValueError:
        return 0.5


def should_reload_path(path: Path, extensions: set[str]) -> bool:
    if any(part in IGNORED_PATH_PARTS for part in path.parts):
        return False
    return path.suffix in extensions


class ReloadEventHandler(FileSystemEventHandler):
    def __init__(self, supervisor: "DevSidecarSupervisor", extensions: set[str]) -> None:
        self.supervisor = supervisor
        self.extensions = extensions

    def on_any_event(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        paths = [Path(event.src_path)]
        dest_path = getattr(event, "dest_path", "")
        if dest_path:
            paths.append(Path(dest_path))
        for path in paths:
            if should_reload_path(path, self.extensions):
                self.supervisor.request_reload(path)
                return


class DevSidecarSupervisor:
    def __init__(self, args: Iterable[str]) -> None:
        self.args = list(args)
        self.child: subprocess.Popen[bytes] | None = None
        self.lock = threading.Lock()
        self.reload_requested = threading.Event()
        self.stop_requested = threading.Event()
        self.last_reload_at = 0.0
        self.last_reload_path: Path | None = None
        self.debounce = debounce_seconds()

    def command(self) -> list[str]:
        return [sys.executable, str(EXECUTOR_DIR / "main.py"), *self.args]

    def child_env(self) -> dict[str, str]:
        return prepend_pythonpath(os.environ.copy())

    def start_child(self) -> None:
        command = self.command()
        log(f"starting executor from source: {' '.join(command)}")
        self.child = subprocess.Popen(command, cwd=EXECUTOR_DIR, env=self.child_env())

    def stop_child(self) -> int:
        child = self.child
        self.child = None
        if child is None:
            return 0
        if child.poll() is not None:
            return child.returncode or 0

        child.terminate()
        try:
            return child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            return child.wait()

    def request_reload(self, path: Path) -> None:
        now = time.monotonic()
        with self.lock:
            self.last_reload_path = path
            if now - self.last_reload_at < self.debounce:
                return
            self.last_reload_at = now
            self.reload_requested.set()

    def request_stop(self, signum: int, _frame: object) -> None:
        log(f"received signal {signum}, stopping")
        self.stop_requested.set()
        self.reload_requested.set()

    def run(self) -> int:
        self.start_child()
        while not self.stop_requested.is_set():
            child = self.child
            if child is None:
                return 1

            if child.poll() is not None:
                return child.returncode or 0

            if not self.reload_requested.wait(timeout=0.2):
                continue
            self.reload_requested.clear()

            if self.stop_requested.is_set():
                break

            path = self.last_reload_path
            log(f"source changed, restarting executor: {path}")
            self.stop_child()
            self.start_child()

        return self.stop_child()


def start_observer(supervisor: DevSidecarSupervisor) -> Observer:
    observer = Observer()
    handler = ReloadEventHandler(supervisor, reload_extensions())
    for directory in reload_dirs():
        if directory.exists():
            observer.schedule(handler, str(directory), recursive=True)
            log(f"watching {directory}")
    observer.start()
    return observer


def main() -> int:
    supervisor = DevSidecarSupervisor(sys.argv[1:])
    signal.signal(signal.SIGTERM, supervisor.request_stop)
    signal.signal(signal.SIGINT, supervisor.request_stop)

    observer = start_observer(supervisor)
    try:
        return supervisor.run()
    finally:
        observer.stop()
        observer.join(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main())
